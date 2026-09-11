/**
 * 消息协议（docs/04 §八的实现版）。
 *
 * 与文档的差异说明：
 *  - 文档把「翻译队列」整体放在 Background。本实现把**批次切分与并发调度**放在 Content，
 *    Background 只负责**单批**的 LLM 调用（含重试、超时、缓存）。
 *    原因：MV3 Service Worker 随时可能休眠，跨多批的长会话状态放在 SW 里会在休眠时丢失，
 *    导致内容脚本永久等待；放在内容脚本则天然跟随页面生命周期。
 *  - 安全边界不变：内容脚本**从不传 URL**，只传 `modelId` + 文本，URL 由 Background 自己拼（docs/00 §G-2 约束 2）。
 *  - 网络访问边界不变：内容脚本**从不直接发跨域请求**（docs/00 §G-2）。
 */

import type { ErrorInfo, ModelConfig, Settings, TranslateType } from './types'

export const MSG = {
  /** Content/Popup → BG：翻译一个批次 */
  TRANSLATE_BATCH: 'transora/translate-batch',
  /** Content/Popup → BG：取消某个翻译会话 */
  CANCEL: 'transora/cancel',
  /** Content/Popup → BG：测试模型连通性（FR-12） */
  TEST_CONNECTION: 'transora/test-connection',
  /** 任意页面 → BG：取当前状态（模型列表 / 设置） */
  GET_STATE: 'transora/get-state',
  /** 任意页面 → BG：写入设置 */
  PATCH_SETTINGS: 'transora/patch-settings',
  /** 任意页面 → BG：打开扩展独立页 */
  OPEN_APP_PAGE: 'transora/open-app-page',
  /** Popup → Content：查询当前页翻译状态 */
  PAGE_STATUS: 'transora/page-status',
  /** BG → Content：执行一条指令 */
  CMD: 'transora/cmd',
} as const

/** Background 下发给内容脚本的指令 */
export type ContentCommand =
  | 'toggle-translate'
  | 'restore'
  | 'translate-selection'
  | 'toggle-sidebar'

export interface TranslateBatchRequest {
  type: typeof MSG.TRANSLATE_BATCH
  /** 会话 id：同一轮全文翻译共用一个，用于中途取消 */
  sessionId: string
  modelId: string
  texts: string[]
  sourceLang: string
  targetLang: string
  /** 是否查/写缓存（S12 开关） */
  useCache: boolean
  /** 来源类型，写入历史时使用 */
  sourceType: TranslateType
}

export interface TranslateBatchResponse {
  ok: boolean
  /** 与请求 texts 等长、下标一一对应 */
  translations?: string[]
  latencyMs?: number
  totalTokens?: number
  /** 命中缓存的条数，用于角标提示 */
  cacheHits?: number
  /** 模型漏返回的段落数 */
  missing?: number
  error?: ErrorInfo
}

export interface CancelRequest {
  type: typeof MSG.CANCEL
  sessionId: string
}

export interface TestConnectionRequest {
  type: typeof MSG.TEST_CONNECTION
  /** 允许携带完整配置：该调用发生在扩展页面内，不涉及宿主页面注入 */
  model: ModelConfig
}

export interface TestConnectionResponse {
  ok: boolean
  latencyMs?: number
  sample?: string
  error?: ErrorInfo
}

export interface GetStateResponse {
  models: ModelConfig[]
  settings: Settings
}

export interface PatchSettingsRequest {
  type: typeof MSG.PATCH_SETTINGS
  patch: Partial<Settings>
}

export interface OpenAppPageRequest {
  type: typeof MSG.OPEN_APP_PAGE
  /** 目标区块：models / general / history / about */
  hash?: string
}

/** 当前页翻译状态（由内容脚本应答 Popup 的查询） */
export interface PageStatusResponse {
  /** 内容脚本未注入时（chrome:// 等页面）为 false */
  available: boolean
  status?: 'idle' | 'translating' | 'translated'
  progress?: { done: number; total: number }
  entryCount?: number
}

/** 统一的消息信封校验，避免把非本扩展的消息当成自己的 */
export function isTransoraMessage(value: unknown): value is { type: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (value as { type: string }).type.startsWith('transora/')
  )
}

/** 向 Background 发送消息 */
export async function sendToBackground<TResponse>(payload: object): Promise<TResponse> {
  return (await chrome.runtime.sendMessage(payload)) as TResponse
}

/** 向指定标签页发送指令 */
export async function sendToTab(tabId: number, command: ContentCommand): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.CMD, command })
  } catch {
    // 目标标签页没有内容脚本（如 chrome:// 页面）时静默失败
  }
}

/** 取当前活动标签页 */
export async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  return tabs[0]
}

/** 取当前活动标签页 id */
export async function getActiveTabId(): Promise<number | undefined> {
  return (await getActiveTab())?.id
}
