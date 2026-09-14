/**
 * 动作层：内容脚本内所有「用户意图」的唯一入口。
 * 注入 UI（FAB / 侧边栏 / 划词内容块）与 Background 下发的指令都调用这里，
 * 保证同一动作在任何入口下行为一致。
 */

import { errorInfoOf } from '@/shared/errors'
import { MSG, sendToBackground, type ContentCommand } from '@/shared/messages'
import type { DisplayMode, ErrorInfo } from '@/shared/types'
import { uid } from '@/shared/utils'
import { collectBlocks, sortByViewportFirst, type BlockCandidate } from './extractor'
import {
  applyDisplayMode,
  createTranslationNode,
  focusSourceBlock,
  hasTranslations,
  insertTranslationNode,
  removeAllTranslations,
  setTranslationError,
  setTranslationLoading,
  setTranslationText,
} from './injector'
import {
  activeModel,
  emit,
  state,
  type PageEntry,
  type SelectionRecord,
  type SidebarTab,
} from './state'
import { cancelActiveTranslation, isTranslating, translateBlocks, translateText } from './translator'
import type { RunOptions } from './translator'
import { destroyToast, toast } from './ui/toast'

const MAX_SELECTION_RECORDS = 50

/* ------------------------------------------------------------------ */
/* 页面跳转 / 侧边栏                                                    */
/* ------------------------------------------------------------------ */

/**
 * 打开扩展独立页。
 * 内容脚本没有 chrome.tabs 权限，必须委托 Background（见 shared/messages.ts）。
 */
export function openApp(hash?: string): void {
  void sendToBackground({ type: MSG.OPEN_APP_PAGE, hash })
}

export function openSidebar(tab: SidebarTab = 'page'): void {
  state.sidebarOpen = true
  state.sidebarTab = tab
  state.fabMenuOpen = false
  emit()
}

export function closeSidebar(): void {
  state.sidebarOpen = false
  emit()
}

export function toggleSidebar(tab?: SidebarTab): void {
  if (state.sidebarOpen && (!tab || state.sidebarTab === tab)) closeSidebar()
  else openSidebar(tab ?? state.sidebarTab)
}

export function setSidebarTab(tab: SidebarTab): void {
  state.sidebarTab = tab
  emit()
}

export function toggleFabMenu(force?: boolean): void {
  state.fabMenuOpen = force ?? !state.fabMenuOpen
  emit()
}

/** X1：悬浮按钮可隐藏；隐藏后从 Popup 或设置页恢复 */
export async function setFabHidden(hidden: boolean): Promise<void> {
  state.settings.fabHidden = hidden
  state.fabMenuOpen = false
  document.documentElement.dataset.transoraFabHidden = String(hidden)
  emit()
  await sendToBackground({ type: MSG.PATCH_SETTINGS, patch: { fabHidden: hidden } })
  if (hidden) toast('悬浮按钮已隐藏，可在设置页重新开启')
}

/* ------------------------------------------------------------------ */
/* 显示模式                                                            */
/* ------------------------------------------------------------------ */

export async function setDisplayMode(mode: DisplayMode): Promise<void> {
  state.settings.displayMode = mode
  applyDisplayMode(mode)
  emit()
  await sendToBackground({ type: MSG.PATCH_SETTINGS, patch: { displayMode: mode } })
}

/* ------------------------------------------------------------------ */
/* 全文翻译                                                            */
/* ------------------------------------------------------------------ */

let currentRun: { canceled: boolean } | null = null

function currentOptions(type: RunOptions['type']): RunOptions | null {
  const model = activeModel()
  if (!model) return null
  return {
    model,
    sourceLang: state.settings.sourceLang,
    targetLang: state.settings.targetLang,
    useCache: state.settings.cacheEnabled,
    type,
  }
}

function ensureEntry(block: BlockCandidate): PageEntry {
  const existing = state.entries.get(block.el)
  if (existing) return existing

  const { node, body } = createTranslationNode(block.el, state.settings.targetLang)
  const isInner = insertTranslationNode(block.el, node)
  const entry: PageEntry = {
    el: block.el,
    sourceText: block.text,
    translatedText: '',
    error: null,
    isInner,
    node,
    body,
  }
  state.entries.set(block.el, entry)
  return entry
}

async function retryEntry(entry: PageEntry): Promise<void> {
  const options = currentOptions('fullpage')
  if (!options) {
    toast('尚未配置模型', 'error')
    openApp('models')
    return
  }

  setTranslationLoading(entry.node, entry.body)
  entry.error = null
  emit()

  const result = await translateText(entry.sourceText, options)
  if (result.ok) {
    entry.translatedText = result.text
    setTranslationText(entry.node, entry.body, result.text)
  } else {
    entry.error = result.error
    setTranslationError(entry.node, entry.body, result.error, () => {
      void retryEntry(entry)
    })
  }
  emit()
}

/** 翻译整页（FR-01） */
export async function runFullPageTranslation(): Promise<void> {
  const options = currentOptions('fullpage')
  if (!options) {
    state.lastError = errorInfoOf('no-model')
    emit()
    toast('尚未配置模型', 'error')
    openApp('models')
    return
  }

  // 已经翻过的块不再重复提交
  const skip = new WeakSet<HTMLElement>()
  state.entries.forEach((_entry, el) => skip.add(el))

  const blocks = sortByViewportFirst(collectBlocks(document, { skip }))
  if (blocks.length === 0) {
    toast(hasTranslations() ? '本页已全部翻译' : '未找到可翻译的内容')
    return
  }

  // 若页面上残留了旧的译文块（例如上次未完整结束），先清干净再重来
  if (hasTranslations()) removeAllTranslations()

  const run = { canceled: false }
  currentRun = run

  state.status = 'translating'
  state.progress = { done: 0, total: blocks.length }
  state.lastError = null
  applyDisplayMode(state.settings.displayMode)
  emit()

  let failed = 0

  await translateBlocks(blocks, options, {
    onResult: (block, text) => {
      const entry = ensureEntry(block)
      entry.translatedText = text
      entry.error = null
      setTranslationText(entry.node, entry.body, text)
    },
    onError: (block, error) => {
      failed += 1
      const entry = ensureEntry(block)
      entry.error = error
      setTranslationError(entry.node, entry.body, error, () => {
        void retryEntry(entry)
      })
      if (!state.lastError) state.lastError = error
    },
    onProgress: (done, total) => {
      state.progress = { done, total }
      emit()
    },
  })

  const canceled = run.canceled
  if (currentRun === run) currentRun = null
  if (canceled) return

  state.lastRunFailed = failed > 0
  state.status = state.entries.size > 0 ? 'translated' : 'idle'
  emit()

  const success = blocks.length - failed
  if (failed === 0) toast(`已翻译 ${success} 段`, 'success')
  else toast(`已翻译 ${success} 段，${failed} 段失败`, 'error')
}

/** 恢复原文（FR-02） */
export function restorePage(): void {
  if (currentRun) currentRun.canceled = true
  cancelActiveTranslation()
  removeAllTranslations()
  state.entries.clear()
  state.status = 'idle'
  state.progress = { done: 0, total: 0 }
  state.lastError = null
  state.lastRunFailed = false
  destroyToast()
  emit()
  toast('已恢复原文', 'success')
}

/** 翻译 / 恢复 的统一切换入口（FAB、快捷键、Popup 共用） */
export function toggleTranslatePage(): void {
  if (isTranslating()) {
    if (currentRun) currentRun.canceled = true
    cancelActiveTranslation()
    state.lastRunFailed = false
    state.status = state.entries.size > 0 ? 'translated' : 'idle'
    emit()
    toast('已取消翻译')
    return
  }
  if (hasTranslations()) {
    restorePage()
    return
  }
  void runFullPageTranslation()
}

/** 点击侧边栏条目时定位到页面上的对应块 */
export function revealEntry(entry: PageEntry): void {
  if (entry.el.isConnected) focusSourceBlock(entry.el)
}

/* ------------------------------------------------------------------ */
/* 划词翻译                                                            */
/* ------------------------------------------------------------------ */

export interface SelectionTranslateResult {
  ok: boolean
  translatedText: string
  error: ErrorInfo | null
  modelName: string
  /** G5 元信息行：耗时（ms）与 token 用量；失败或命中缓存时可能为 0 */
  latencyMs: number
  totalTokens: number
}

/**
 * 翻译一段选中文本（FR-03 / FR-04）。
 * 划词**不含多模型对比**（docs/00 §A1）；`sourceLangOverride` 只对本次生效，不回写设置。
 */
export async function translateSelectionText(
  text: string,
  sourceLangOverride?: string,
  modelIdOverride?: string,
): Promise<SelectionTranslateResult> {
  const model = modelIdOverride
    ? (state.models.find((m) => m.id === modelIdOverride) ?? activeModel())
    : activeModel()
  if (!model) {
    const error = errorInfoOf('no-model')
    return { ok: false, translatedText: '', error, modelName: '', latencyMs: 0, totalTokens: 0 }
  }

  const sourceLang = sourceLangOverride ?? state.settings.sourceLang
  const targetLang = state.settings.targetLang

  const result = await translateText(text, {
    model,
    sourceLang,
    targetLang,
    useCache: state.settings.cacheEnabled,
    type: 'selection',
  })

  const record: SelectionRecord = {
    id: uid('sel'),
    sourceText: text,
    translatedText: result.ok ? result.text : '',
    modelName: model.name,
    sourceLang,
    targetLang,
    timestamp: Date.now(),
    error: result.ok ? null : result.error.message,
  }
  state.selectionRecords.unshift(record)
  if (state.selectionRecords.length > MAX_SELECTION_RECORDS) {
    state.selectionRecords.length = MAX_SELECTION_RECORDS
  }
  emit()

  if (result.ok) {
    return {
      ok: true,
      translatedText: result.text,
      error: null,
      modelName: model.name,
      latencyMs: result.latencyMs,
      totalTokens: result.totalTokens,
    }
  }
  return {
    ok: false,
    translatedText: '',
    error: result.error,
    modelName: model.name,
    latencyMs: 0,
    totalTokens: 0,
  }
}

/**
 * 划词内容块的展示函数由 selection 模块在挂载时注册进来。
 *
 * 这样 actions 不必反向 import selection —— 否则 actions → selection → ui/selection-card → actions
 * 会构成循环依赖，只能靠动态 import 绕开（那会把模块拆成额外 chunk 并写进 web_accessible_resources）。
 */
type SelectionCardShower = (text: string) => void | Promise<void>

let selectionShower: SelectionCardShower | null = null

export function registerSelectionShower(fn: SelectionCardShower): void {
  selectionShower = fn
}

/** 翻译「当前选区」（右键菜单 / 快捷键入口，FR-13 / FR-14） */
export async function translateCurrentSelection(): Promise<void> {
  const selection = window.getSelection()
  const text = selection?.toString().replace(/\s+/g, ' ').trim() ?? ''
  if (!text) {
    toast('请先选中要翻译的文字')
    return
  }
  if (!selectionShower) {
    toast('划词模块尚未就绪，请刷新页面后重试')
    return
  }
  await selectionShower(text)
}

/* ------------------------------------------------------------------ */
/* 指令分发（Background → Content）                                     */
/* ------------------------------------------------------------------ */

export function dispatchCommand(command: ContentCommand): void {
  switch (command) {
    case 'toggle-translate':
      toggleTranslatePage()
      break
    case 'restore':
      restorePage()
      break
    case 'translate-selection':
      void translateCurrentSelection()
      break
    case 'toggle-sidebar':
      toggleSidebar()
      break
  }
}
