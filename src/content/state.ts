/**
 * 内容脚本的页面级状态。
 *
 * 全部状态都是「本页内存态」，不落盘 —— 落盘的只有设置与缓存。
 * 页面刷新即重置，符合「侧边栏只对当前页生效」的归属判据（docs/07）。
 */

import type { ContentCommand } from '@/shared/messages'
import { STORAGE_KEYS } from '@/shared/constants'
import type { CompareColumnStatus } from '@/shared/compare'
import { columnStatusOf } from '@/shared/compare'
import { getEnabledModels, getSettings, onStorageChanged } from '@/shared/storage'
import type { ErrorInfo, ModelConfig, Settings } from '@/shared/types'
import type { BlockCandidate } from './extractor'
import { applyDisplayMode } from './injector'

export type PageStatus = 'idle' | 'translating' | 'translated'

/** 一条对照记录（侧边栏「本页对照」列表的数据源） */
export interface PageEntry {
  el: HTMLElement
  sourceText: string
  translatedText: string
  error: ErrorInfo | null
  /** 译文是否内嵌在原文块内部（父级为 flex/grid 的场景） */
  isInner: boolean
  /** 译文块节点与其正文容器，供重试 / 更新复用 */
  node: HTMLElement
  body: HTMLElement
}

/** 一条划词记录（侧边栏「划词记录」；只属于当前页，全局历史在阶段 2） */
export interface SelectionRecord {
  id: string
  sourceText: string
  translatedText: string
  modelName: string
  sourceLang: string
  targetLang: string
  timestamp: number
  error: string | null
}

export type SidebarTab = 'page' | 'records' | 'compare'

/**
 * 一列 = 一个模型在本页的译文。
 *
 * `translations` / `errors` 与 `CompareState.blocks` **下标对齐**：
 * 「应用」时按下标把整列回填到页面，不需要任何元素级映射表。
 */
export interface CompareColumn {
  modelId: string
  modelName: string
  /** 「供应商」由 endpoint 主机名推断（shared/providers.ts），不是配置字段 */
  provider: string
  status: CompareColumnStatus
  /** 与 blocks 等长；空串 = 该块没有译文 */
  translations: string[]
  /** 与 blocks 等长；null = 该块成功 */
  errors: Array<ErrorInfo | null>
  /** 已处理块数（成功 + 失败），用于列头进度 */
  done: number
  failed: number
  /** 全列累计耗时 / token（G6 列头元信息；命中等场景可能为 0） */
  latencyMs: number
  totalTokens: number
  /** 命中缓存的块数（元信息在耗时 0 时改显示「命中缓存」） */
  cacheHits: number
  /** 整列致命错误（auth / no-model 等：本列剩余批次不再发起） */
  error: ErrorInfo | null
}

/** G6 多模型对比的页面级状态（全部是内存态，刷新即清） */
export interface CompareState {
  /** 勾选的模型 id（2–3 个，见 MIN/MAX_COMPARE_MODELS） */
  selectedIds: string[]
  columns: CompareColumn[]
  /** 本次对比的块快照；「应用」按 index 回填页面（FR-11 动态补翻属阶段 3，不在此处理） */
  blocks: BlockCandidate[]
  /** 当前已应用到页面的模型（G6 图里标橙的那一列） */
  appliedModelId: string | null
  status: 'idle' | 'running' | 'done'
  /** 运行中的会话标记，供「取消对比」与迟到响应丢弃使用 */
  runId: string | null
}

export function emptyCompareState(): CompareState {
  return {
    selectedIds: [],
    columns: [],
    blocks: [],
    appliedModelId: null,
    status: 'idle',
    runId: null,
  }
}

export interface PageState {
  status: PageStatus
  settings: Settings
  models: ModelConfig[]
  /** 已翻译块：Map 保证同一元素只记一条 */
  entries: Map<HTMLElement, PageEntry>
  progress: { done: number; total: number }
  selectionRecords: SelectionRecord[]
  lastError: ErrorInfo | null
  /** 上一轮整页翻译是否存在失败块（H3 失败角标判据） */
  lastRunFailed: boolean
  /** 侧边栏当前 Tab 与开关（X2：默认不打开） */
  sidebarOpen: boolean
  sidebarTab: SidebarTab
  /** 悬浮按钮是否展开菜单 */
  fabMenuOpen: boolean
  /** G6 多模型对比（FR-09 / FR-10） */
  compare: CompareState
}

export const state: PageState = {
  status: 'idle',
  settings: {
    targetLang: 'zh-CN',
    sourceLang: 'en',
    displayMode: 'bilingual',
    cacheEnabled: true,
    autoRetry: true,
    historyLimit: 1000,
    maxModelsForCompare: 3,
    lastModelId: null,
    fabHidden: false,
  },
  models: [],
  entries: new Map(),
  progress: { done: 0, total: 0 },
  selectionRecords: [],
  lastError: null,
  lastRunFailed: false,
  sidebarOpen: false,
  sidebarTab: 'page',
  fabMenuOpen: false,
  compare: emptyCompareState(),
}

/* ------------------------------------------------------------------ */
/* 极简事件总线：状态变更 → 重绘注入 UI                                   */
/* ------------------------------------------------------------------ */

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let scheduled = false

export function emit(): void {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    listeners.forEach((listener) => {
      try {
        listener()
      } catch (err) {
        console.warn('[Transora] 渲染回调异常', err)
      }
    })
  })
}

/* ------------------------------------------------------------------ */
/* 派生值                                                              */
/* ------------------------------------------------------------------ */

/** 当前使用的模型：上次选择 → 首个启用项 → null（未配置） */
export function activeModel(): ModelConfig | null {
  if (state.models.length === 0) return null
  const preferred = state.settings.lastModelId
  return state.models.find((m) => m.id === preferred) ?? state.models[0]
}

/**
 * 解析本次翻译实际使用的目标语言。
 *
 * 优先级：模型的 `targetLang`（E2 表单里的可选覆盖）→ 全局「默认目标语言」。
 * 模型表单留空即跟随全局 —— 这样 E2 的 7 字段与「目标语言由用户统一指定」的冻结口径不冲突。
 */
export function targetLangFor(model: ModelConfig | null): string {
  return model?.targetLang?.trim() || state.settings.targetLang
}

/** 是否处于「未配置」状态（D-4：四处挂载点共用同一判据） */
export function isUnconfigured(): boolean {
  return state.models.length === 0
}

/** 取对比中的某一列（不存在返回 null） */
export function compareColumnOf(modelId: string): CompareColumn | null {
  return state.compare.columns.find((column) => column.modelId === modelId) ?? null
}

/**
 * 由计数重算列状态。
 * 状态**不在每次回调里手写**，一律走这个函数 —— 否则「失败块也算已处理」这类口径
 * 会在三处回填点各写一遍，迟早写歪一个。
 */
export function refreshColumnStatus(column: CompareColumn): void {
  column.status = columnStatusOf(column.done, column.translations.length, column.failed)
}

/* ------------------------------------------------------------------ */
/* 初始化与订阅                                                         */
/* ------------------------------------------------------------------ */

/** 从存储加载设置与模型（可重复调用） */
export async function hydrateState(): Promise<void> {
  const [settings, models] = await Promise.all([getSettings(), getEnabledModels()])
  state.settings = settings
  state.models = models
  document.documentElement.dataset.transoraFabHidden = String(settings.fabHidden)
  // 显示模式可能被 Popup / 设置页改动，这里统一回落到页面上（FR-16）
  applyDisplayMode(settings.displayMode)
  emit()
}

let watching = false

/**
 * 监听设置/模型变化（只注册一次，避免 hydrate 反复调用导致监听器泄漏）。
 * 设置页或 Popup 改动后，本页 UI 实时跟随。
 */
export function watchStorage(): void {
  if (watching) return
  watching = true
  onStorageChanged([STORAGE_KEYS.settings, STORAGE_KEYS.models], () => {
    void hydrateState()
  })
}

/** 供 UI 层复用的动作类型 */
export type ContentAction =
  | ContentCommand
  | 'open-settings'
  | 'open-sidebar-page'
  | 'open-sidebar-records'
