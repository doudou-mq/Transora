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
  /** 任意页面 → BG：恢复默认设置（E5 页首按钮，不动模型与缓存） */
  RESET_SETTINGS: 'transora/reset-settings',
  /** 任意页面 → BG：打开扩展独立页 */
  OPEN_APP_PAGE: 'transora/open-app-page',
  /** Popup → Content：查询当前页翻译状态 */
  PAGE_STATUS: 'transora/page-status',
  /** BG → Content：执行一条指令 */
  CMD: 'transora/cmd',
  /** Content → BG：上报整页翻译进度，供工具栏角标（H3）显示 */
  TRANSLATE_PROGRESS: 'transora/translate-progress',
  /** Content → BG：写入一条翻译历史（FR-05） */
  HISTORY_ADD: 'transora/history-add',
  /** 扩展页 → BG：把某条历史记录应用到它的来源页面（设计稿 F3 行内操作） */
  APPLY_HISTORY: 'transora/apply-history',
} as const

/** Background 下发给内容脚本的指令 */
export type ContentCommand =
  | 'toggle-translate'
  | 'restore'
  | 'translate-selection'
  | 'toggle-sidebar'
  /** 只重试当前页上失败的块（D6「重试失败批次」） */
  | 'retry-failed'
  /** H1 右键菜单：复制选中原文 */
  | 'copy-source'
  /** H1 右键菜单：复制选中内容的译文 */
  | 'copy-translation'
  /** H1 快捷键 Alt+Shift+M：对照 → 译文 → 原文 循环 */
  | 'toggle-display-mode'
  /** F3 行内操作「应用到页面」：把历史记录的译文套回来源页 */
  | 'apply-history'

/**
 * 指令附带的数据。
 * 右键菜单的 `info.selectionText` 是浏览器已经算好的选区文本，
 * 直接带下来最可靠 —— 内容脚本再读一次 `getSelection()` 在 iframe / 失焦场景下可能为空。
 */
export interface ContentCommandPayload {
  text?: string
  /** `apply-history`：这条记录的原文（段间以空行分隔，与译文**按序号对齐**） */
  sourceText?: string
  /** `apply-history`：这条记录的译文（同上） */
  translatedText?: string
}

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

export interface ResetSettingsRequest {
  type: typeof MSG.RESET_SETTINGS
}

/**
 * 整页翻译进度上报（Content → Background）。
 *
 * 为什么由内容脚本上报：批次切分与总块数只有内容脚本知道（docs/04 §八的分工），
 * Background 每次只看到一批，算不出「42 / 56」里的 56。
 */
export interface TranslateProgressRequest {
  type: typeof MSG.TRANSLATE_PROGRESS
  /** progress = 进行中（角标显示已译块数）；done / failed = 收尾三态；clear = 清空角标 */
  phase: 'progress' | 'done' | 'failed' | 'clear'
  done: number
  total: number
}

export interface OpenAppPageRequest {
  type: typeof MSG.OPEN_APP_PAGE
  /** 目标区块：models / general / history / about */
  hash?: string
}

/**
 * 写入一条翻译历史（Content → Background，FR-05）。
 *
 * 为什么内容脚本不自己写：**IndexedDB 按源隔离**，内容脚本开库会落在宿主页面的源上，
 * 换个网站就读不到了 —— 历史必须由 Background 写在扩展源里。
 *
 * 两处「不由页面决定」的字段（与「URL 自拼」同一条安全边界）：
 *  - `pageUrl`：取 `sender.tab.url`，不信任消息内容；
 *  - `timestamp`：由 Background 打，页面改不了记录时间，超限剪裁的顺序才可信。
 */
export interface HistoryAddRequest {
  type: typeof MSG.HISTORY_ADD
  modelId: string
  modelName: string
  sourceText: string
  translatedText: string | null
  error: string | null
  /** 来源类型：selection / fullpage / dynamic */
  sourceType: TranslateType
  sourceLang: string
  targetLang: string
  latencyMs?: number
  totalTokens?: number
}

export interface HistoryAddResponse {
  ok: boolean
  /** 落库后的自增 id */
  id?: number
  /** 本轮因超出上限被清掉的条数 */
  pruned?: number
}

/**
 * 把一条历史记录应用到它的来源页面（设计稿 F3 行内操作「应用到页面」）。
 *
 * 由 Background 负责找同 URL 的标签页 —— 扩展页自己 `chrome.tabs.query` 也行，
 * 但「找页 + 下发指令」是同一件事，放一处才好排查。
 */
export interface ApplyHistoryRequest {
  type: typeof MSG.APPLY_HISTORY
  /** 记录的来源页 URL */
  pageUrl: string
  sourceText: string
  translatedText: string
}

export interface ApplyHistoryResponse {
  ok: boolean
  /** tab-not-open = 来源页当前没打开（不是错误，是要提示用户的那条降解路径） */
  reason?: 'tab-not-open' | 'send-failed'
}

/** 本轮全文翻译的「成本预估」输入（D3 翻译前确认） */
export interface PagePlan {
  /** 待翻译块数 */
  blocks: number
  /** 待翻译总字符数（含空白归一化后的长度） */
  chars: number
  /** 已切分出的批次数（按 docs/00 §D-2 的上限推算） */
  batches: number
}

/** 当前页翻译状态（由内容脚本应答 Popup 的查询） */
export interface PageStatusResponse {
  /** 内容脚本未注入时（chrome:// 等页面）为 false */
  available: boolean
  status?: 'idle' | 'translating' | 'translated'
  progress?: { done: number; total: number }
  entryCount?: number
  /** 已注入但失败的块数（D6「部分失败」判据） */
  failedCount?: number
  /** 可取消（正在翻译）时的会话标记，供 Popup 显示取消 */
  cancellable?: boolean
  /** 未开始翻译时的成本预估（D3）；翻译中 / 已完成时为 undefined */
  plan?: PagePlan
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

/** 向指定标签页发送指令（可携带文本载荷，见 ContentCommandPayload） */
export async function sendToTab(
  tabId: number,
  command: ContentCommand,
  payload?: ContentCommandPayload,
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.CMD, command, payload })
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
