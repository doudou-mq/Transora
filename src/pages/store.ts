/**
 * 新标签页（扩展独立页）的共享上下文。
 *
 * 术语提醒（docs/07 判据 2）：「新标签页」= **扩展独立页**（options.html 路径），
 * **不是**浏览器新建标签页，也不替换 chrome://newtab。
 */

import { PRODUCT_VERSION } from '@/shared/constants'
import { MSG, sendToBackground, type GetStateResponse } from '@/shared/messages'
import type { ModelConfig, Settings } from '@/shared/types'

export { PRODUCT_VERSION }

/** 设计稿版本与产品版本是两套口径（docs/00 §C3），界面上不得混用 */
export const DESIGN_VERSION = 'v1.0'

export interface AppContext {
  models: ModelConfig[]
  settings: Settings
  reload: () => Promise<void>
}

/**
 * 区块与页头的接口。
 *
 * 为什么需要它：设计稿的页头不只是「标题 + 一句固定描述」——
 * 翻译历史页要把**实时条数**写进副标题，还要把「导出 / 清空」放在标题右侧（F1）。
 * 这两件事都依赖区块自己的数据，所以由区块回写，而不是让外壳去猜。
 *
 * 只有真的有动态页头需求的区块才用它，其余区块照旧忽略这个参数。
 */
export interface SectionContext {
  /** 回写标题下方的描述行 */
  setHeaderDesc: (desc: string) => void
  /** 把操作区挂到标题右侧（每次调用整体替换） */
  setHeaderActions: (nodes: HTMLElement[]) => void
}

let current: AppContext = {
  models: [],
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
  reload: async () => {},
}

export function getContext(): AppContext {
  return current
}

export async function loadState(): Promise<void> {
  const state = await sendToBackground<GetStateResponse>({ type: MSG.GET_STATE })
  current = { ...current, models: state.models, settings: state.settings }
}

export async function saveModels(models: ModelConfig[]): Promise<void> {
  // 直接写 chrome.storage：扩展页面本身就具备存储权限
  await chrome.storage.local.set({ 'transora:models': models })
  current = { ...current, models }
}

export async function patchSettings(patch: Partial<Settings>): Promise<void> {
  const next = await sendToBackground<Settings>({ type: MSG.PATCH_SETTINGS, patch })
  current = { ...current, settings: next }
}

/** E5 页首「恢复默认」：整体写回出厂设置（不含模型与缓存） */
export async function resetSettings(): Promise<void> {
  const next = await sendToBackground<Settings>({ type: MSG.RESET_SETTINGS })
  current = { ...current, settings: next }
}

export function bindReload(reload: () => Promise<void>): void {
  current = { ...current, reload }
}

/** 元素工厂（各区块共用） */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
