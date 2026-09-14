/**
 * 内容脚本的页面级状态。
 *
 * 全部状态都是「本页内存态」，不落盘 —— 落盘的只有设置与缓存。
 * 页面刷新即重置，符合「侧边栏只对当前页生效」的归属判据（docs/07）。
 */

import type { ContentCommand } from '@/shared/messages'
import { STORAGE_KEYS } from '@/shared/constants'
import { getEnabledModels, getSettings, onStorageChanged } from '@/shared/storage'
import type { ErrorInfo, ModelConfig, Settings } from '@/shared/types'
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
}

export const state: PageState = {
  status: 'idle',
  settings: {
    targetLang: 'zh-CN',
    sourceLang: 'en',
    displayMode: 'bilingual',
    cacheEnabled: true,
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

/** 是否处于「未配置」状态（D-4：四处挂载点共用同一判据） */
export function isUnconfigured(): boolean {
  return state.models.length === 0
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
