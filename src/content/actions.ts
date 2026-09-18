/**
 * 动作层：内容脚本内所有「用户意图」的唯一入口。
 * 注入 UI（FAB / 侧边栏 / 划词内容块）与 Background 下发的指令都调用这里，
 * 保证同一动作在任何入口下行为一致。
 */

import { GUIDE_DOC_HASH, TOAST_COPY } from '@/shared/copy'
import { isAllFailed, hasAnyFailure } from '@/shared/compare'
import { CONCURRENCY, MAX_COMPARE_MODELS, MIN_COMPARE_MODELS } from '@/shared/constants'
import { errorInfoOf } from '@/shared/errors'
import { splitSegments } from '@/shared/history'
import { langDisplayName } from '@/shared/langs'
import { MSG, sendToBackground, type ContentCommand } from '@/shared/messages'
import { providerOf } from '@/shared/providers'
import type { DisplayMode, ErrorInfo, ModelConfig, TranslateType } from '@/shared/types'
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
  compareColumnOf,
  emit,
  refreshColumnStatus,
  state,
  targetLangFor,
  type CompareColumn,
  type PageEntry,
  type SelectionRecord,
  type SidebarTab,
} from './state'
import {
  cancelActiveTranslation,
  cancelCompare,
  isComparing,
  isTranslating,
  translateBlocks,
  translateForCompare,
  translateText,
  type CompareRunHooks,
  type CompareTarget,
} from './translator'
import type { RunOptions } from './translator'
import { destroyToast, toast } from './ui/toast'

const MAX_SELECTION_RECORDS = 50

/* ------------------------------------------------------------------ */
/* Toast 快捷方式（H2 三态 + 单一动作）                                  */
/* ------------------------------------------------------------------ */

/**
 * 未配置模型：文案取 docs/00 §D-1 表格（唯一口径），动作取该行的 `[去配置]`。
 * **不自动跳转** —— D-4 要求「就地渲染引导卡」，把选择权留给用户。
 */
function toastNoModel(): void {
  toast(errorInfoOf('no-model').message, {
    kind: 'error',
    persistent: true,
    action: { label: TOAST_COPY.goConfigure, onClick: () => openApp('models') },
  })
}

/** 引导卡次按钮「查看配置指引」：指向新标签页的使用文档（S6） */
export function openGuide(): void {
  openApp(GUIDE_DOC_HASH)
}

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
  if (tab === 'compare') ensureCompareSelection()
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
  if (tab === 'compare') ensureCompareSelection()
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

/** Alt+Shift+M 的循环次序（H1 / F6 冻结文案：切换 对照 / 译文 / 原文） */
const MODE_CYCLE: readonly DisplayMode[] = ['bilingual', 'translation-only', 'original-only']

/**
 * 按设计稿次序循环切换三态。
 * 只改显示，**不重新请求**（FR-16）—— 译文块的 DOM 一直在，靠 documentElement 上的 class 控制可见性。
 */
export function cycleDisplayMode(): void {
  const current = state.settings.displayMode
  const next = MODE_CYCLE[(MODE_CYCLE.indexOf(current) + 1) % MODE_CYCLE.length] ?? 'bilingual'
  void setDisplayMode(next)
}

/** 目标语言（G7 状态栏 / 设置页共用）。已有译文不会被改写，重新翻译后才生效。 */
export async function setTargetLang(lang: string): Promise<void> {
  if (lang === state.settings.targetLang) return
  state.settings.targetLang = lang
  emit()
  await sendToBackground({ type: MSG.PATCH_SETTINGS, patch: { targetLang: lang } })
  if (state.entries.size > 0) {
    toast(`目标语言已设为 ${langDisplayName(lang)}，重新翻译后生效`)
  }
}

/* ------------------------------------------------------------------ */
/* H3 工具栏角标                                                        */
/* ------------------------------------------------------------------ */

/**
 * 上报整页翻译进度，供 Background 更新工具栏角标（A2 / H3）。
 * 总块数只有内容脚本知道（批次切分在内容侧），所以必须由这里推上去。
 */
function reportProgress(
  phase: 'progress' | 'done' | 'failed' | 'clear',
  done: number,
  total: number,
): void {
  void sendToBackground({ type: MSG.TRANSLATE_PROGRESS, phase, done, total })
}

/* ------------------------------------------------------------------ */
/* 翻译历史（FR-05）                                                    */
/* ------------------------------------------------------------------ */

/** 拼接整页原文/译文用的分隔符；`splitSegments()` 就是按它切回来的 */
const HISTORY_JOIN = '\n\n'

interface HistoryDraft {
  model: ModelConfig
  sourceText: string
  translatedText: string | null
  error: string | null
  sourceType: TranslateType
  sourceLang: string
  targetLang: string
  latencyMs?: number
  totalTokens?: number
}

/**
 * 上报一条历史记录。
 *
 * 这里只「把这次翻译报上去」，落库由 Background 完成 —— IndexedDB 按源隔离，
 * 内容脚本开库会落在**宿主页面的源**上，换个网站就读不到（见 shared/history-db.ts）。
 *
 * 不 await、不提示、不重试：历史是记账，记账失败不该打断已经完成的翻译。
 *
 * 记账点只有三处：整页翻译收尾、划词翻译完成、对比收尾（每列一条）。
 * **单块重试不记账** —— 那是对同一次翻译的修补，逐块记会在历史里刷出一片同页记录。
 */
function recordHistory(draft: HistoryDraft): void {
  if (draft.sourceText.trim() === '') return
  void sendToBackground({
    type: MSG.HISTORY_ADD,
    modelId: draft.model.id,
    modelName: draft.model.name,
    sourceText: draft.sourceText,
    translatedText: draft.translatedText,
    error: draft.error,
    sourceType: draft.sourceType,
    sourceLang: draft.sourceLang,
    targetLang: draft.targetLang,
    latencyMs: draft.latencyMs,
    totalTokens: draft.totalTokens,
  })
}

/**
 * 整页结果 → 一条记录（设计稿 F3 头行的「12 段 · 1,840 字」就是这么来的）。
 *
 * 部分失败也照记：成功段的译文按原顺序拼起来，失败段数写进 `error`。
 * 完全不记的话，用户「翻了一半」的那次会凭空消失。
 */
function historyDraftOfBlocks(
  blocks: readonly BlockCandidate[],
  model: ModelConfig,
  sourceLang: string,
  targetLang: string,
  failed: number,
  latencyMs?: number,
  totalTokens?: number,
): HistoryDraft {
  const sourceText = blocks.map((b) => b.text).join(HISTORY_JOIN)

  const parts: string[] = []
  for (const block of blocks) {
    const text = state.entries.get(block.el)?.translatedText
    if (text) parts.push(text)
  }

  return {
    model,
    sourceText,
    translatedText: parts.length > 0 ? parts.join(HISTORY_JOIN) : null,
    error: failed > 0 ? `其中 ${failed} 段翻译失败` : null,
    sourceType: 'fullpage',
    sourceLang,
    targetLang,
    latencyMs,
    totalTokens,
  }
}

/**
 * 对比结果 → **每个模型一条**历史。
 *
 * 为什么不是「整轮一条」：FR-05 记的是「每次翻译的模型 + 译文」。对比时每个模型确实
 * 各做了一次整页翻译（各自计费），合并成一条就分不清谁翻了什么，
 * 按模型筛选与导出都会失效。
 */
function recordCompareHistory(
  columns: readonly CompareColumn[],
  blocks: readonly BlockCandidate[],
  sourceLang: string,
): void {
  const sourceText = blocks.map((b) => b.text).join(HISTORY_JOIN)
  if (sourceText.trim() === '') return

  for (const column of columns) {
    // 整列一段都没成功 → 不记空记录（与「应用」按钮的禁用判据同一口径）
    if (column.done - column.failed === 0) continue

    const parts: string[] = []
    for (const text of column.translations) {
      if (text) parts.push(text)
    }
    if (parts.length === 0) continue

    const model = state.models.find((m) => m.id === column.modelId)
    if (!model) continue

    recordHistory({
      model,
      sourceText,
      translatedText: parts.join(HISTORY_JOIN),
      error: column.failed > 0 ? `其中 ${column.failed} 段翻译失败` : null,
      sourceType: 'fullpage',
      sourceLang,
      targetLang: targetLangFor(model),
      latencyMs: column.latencyMs,
      totalTokens: column.totalTokens,
    })
  }
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
    targetLang: targetLangFor(model),
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
    toastNoModel()
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

/** 已翻译块数（成功 + 失败都算已出块，用于「恢复原文」等判定） */
function failedEntries(): PageEntry[] {
  return [...state.entries.values()].filter((entry) => entry.error !== null)
}

/**
 * D6「重试失败批次」：只重跑当前页上失败的块，并发与全文一致（docs/00 §D-2 上限 3）。
 * 已成功的块与已写入的译文**完全不动**。
 */
export async function retryFailedEntries(): Promise<void> {
  const targets = failedEntries()
  if (targets.length === 0) {
    toast('没有需要重试的段落')
    return
  }
  if (!currentOptions('fullpage')) {
    toastNoModel()
    return
  }
  if (isTranslating()) return

  const run = { canceled: false }
  currentRun = run
  state.status = 'translating'
  state.lastError = null

  const already = state.entries.size - targets.length
  state.progress = { done: already, total: state.entries.size }
  emit()
  toast(`正在重试… ${already} / ${state.entries.size} 段`, {
    action: { label: TOAST_COPY.cancel, muted: true, onClick: () => toggleTranslatePage() },
  })

  const queue = [...targets]
  let done = already

  const worker = async (): Promise<void> => {
    for (;;) {
      if (run.canceled) return
      const next = queue.shift()
      if (!next) return
      await retryEntry(next)
      done += 1
      state.progress = { done, total: state.entries.size }
      emit()
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY.FULL_PAGE, targets.length) }, worker))

  const canceled = run.canceled
  if (currentRun === run) currentRun = null
  if (canceled) return

  const stillFailed = failedEntries().length
  state.lastRunFailed = stillFailed > 0
  state.status = state.entries.size > 0 ? 'translated' : 'idle'
  emit()

  if (stillFailed === 0) {
    toast('失败段落已全部重试成功', {
      kind: 'success',
      action: { label: TOAST_COPY.undo, onClick: () => restorePage() },
    })
  } else {
    toast(`仍有 ${stillFailed} 段失败`, {
      kind: 'error',
      persistent: true,
      action: { label: TOAST_COPY.goSettings, onClick: () => openApp('models') },
    })
  }
}

/** 翻译整页（FR-01） */
export async function runFullPageTranslation(): Promise<void> {
  // 与多模型对比互斥：两者都要吃满并发槽，同时跑会突破 docs/00 §D-2 的全局上限 3
  if (isComparing()) {
    toast('多模型对比进行中，请先取消或等它结束')
    return
  }

  const options = currentOptions('fullpage')
  if (!options) {
    state.lastError = errorInfoOf('no-model')
    emit()
    // docs/00 §D-4：不进入「翻译中」，就地引导；不自动跳转设置页
    toastNoModel()
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

  // H3：进「翻译中」先点亮角标（0 段时数字留空，只有橙色底）
  reportProgress('progress', 0, blocks.length)

  // H2 进行中态：带进度 + 单一动作「取消」（弱化为次要文字色）
  toast(`正在翻译… 0 / ${blocks.length} 段`, {
    action: { label: TOAST_COPY.cancel, muted: true, onClick: () => toggleTranslatePage() },
  })

  let failed = 0
  const startedAt = Date.now()
  // 历史（FR-05）要的整页用量：逐批累加耗时与 token
  let latencyMs = 0
  let totalTokens = 0

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
      // H3：工具栏角标同步显示已译块数
      reportProgress('progress', done, total)
      // 与起始 Toast 同一实例：冷却窗口内只更新文案，不堆叠（docs/00 §D-1）
      toast(`正在翻译… ${done} / ${total} 段`, {
        action: { label: TOAST_COPY.cancel, muted: true, onClick: () => toggleTranslatePage() },
      })
    },
    onBatchMeta: (batchLatency, batchTokens) => {
      latencyMs += batchLatency
      totalTokens += batchTokens
    },
  })

  const canceled = run.canceled
  if (currentRun === run) currentRun = null
  if (canceled) return

  state.lastRunFailed = failed > 0
  state.status = state.entries.size > 0 ? 'translated' : 'idle'
  emit()

  // H3：收尾角标 —— 完成 ✓ / 失败 !
  reportProgress(failed > 0 ? 'failed' : 'done', state.progress.done, state.progress.total)

  // FR-05：整页一次翻译 = 一条历史（含部分失败）
  recordHistory(
    historyDraftOfBlocks(
      blocks,
      options.model,
      options.sourceLang,
      options.targetLang,
      failed,
      latencyMs,
      totalTokens,
    ),
  )

  const success = blocks.length - failed
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)

  if (failed === 0) {
    // H2 成功态：主文案带耗时 + 单一动作「撤销」（= 恢复原文）
    toast(`已翻译 ${success} 段 · ${seconds}s`, {
      kind: 'success',
      action: { label: TOAST_COPY.undo, onClick: () => restorePage() },
    })
  } else {
    // G9 Toast：失败态常驻 6s，动作给「重试」（失败批次可就地重跑）
    toast(`已翻译 ${success} 段 · ${failed} 段失败`, {
      kind: 'error',
      persistent: true,
      action: { label: TOAST_COPY.retry, onClick: () => void retryFailedEntries() },
    })
  }
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
  // 页面译文已清空，「已应用」标记随之失效（对比结果本身保留，随时可再应用）
  state.compare.appliedModelId = null
  destroyToast()
  emit()
  // H3：退出对照，工具栏角标一并清空
  reportProgress('clear', 0, 0)
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
    toast('已取消')
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
/* G6 多模型对比（FR-09 / FR-10）                                       */
/* ------------------------------------------------------------------ */

/** 勾选 / 取消勾选一个模型；超过上限（Q5：3 个）直接拒绝并提示 */
export function toggleCompareModel(modelId: string): void {
  const selected = state.compare.selectedIds
  const at = selected.indexOf(modelId)

  if (at >= 0) {
    selected.splice(at, 1)
  } else {
    if (selected.length >= MAX_COMPARE_MODELS) {
      toast(`最多同时对比 ${MAX_COMPARE_MODELS} 个模型`)
      return
    }
    selected.push(modelId)
  }
  emit()
}

/** 默认勾选：当前生效模型打头，再按列表顺序补到上限（用户可再改，不改设置） */
function defaultCompareSelection(): string[] {
  const ids: string[] = []
  const active = activeModel()
  if (active) ids.push(active.id)

  const ceiling = Math.min(MAX_COMPARE_MODELS, state.models.length)
  for (const model of state.models) {
    if (ids.length >= ceiling) break
    if (!ids.includes(model.id)) ids.push(model.id)
  }
  return ids
}

/** 进入对比 Tab 时若还没勾选，给一份合理预选（否则用户面对空列表不知从哪开始） */
export function ensureCompareSelection(): void {
  if (state.compare.selectedIds.length > 0) return
  if (state.models.length < MIN_COMPARE_MODELS) return
  state.compare.selectedIds = defaultCompareSelection()
  emit()
}

/** 对比整体进度：所有列已处理块数 / 列数 × 块数 */
function compareProgressOf(columns: readonly CompareColumn[]): { done: number; total: number } {
  const perColumn = state.compare.blocks.length
  const done = columns.reduce((sum, column) => sum + column.done, 0)
  return { done, total: perColumn * columns.length }
}

/**
 * 构造对比回调。
 *
 * `columns` 的下标 = `translateForCompare` 回调里的 `modelIndex`：
 * 整轮对比传全部列；单列重试只传 `[column]`，于是同一套回调能服务两种场景。
 */
function compareHooks(
  columns: CompareColumn[],
  runId: string,
  toastLabel: string,
): CompareRunHooks {
  const alive = (): boolean => state.compare.runId === runId

  return {
    onResult: (modelIndex, blockIndex, text) => {
      if (!alive()) return
      const column = columns[modelIndex]
      if (!column) return
      column.translations[blockIndex] = text
      column.errors[blockIndex] = null
      column.done += 1
      refreshColumnStatus(column)
      emit()
    },

    onError: (modelIndex, blockIndex, error) => {
      if (!alive()) return
      const column = columns[modelIndex]
      if (!column) return
      // 同一块可能先后被「漏返回」与致命错误各报一次，只计一次
      const counted = column.errors[blockIndex] !== null || column.translations[blockIndex] !== ''
      column.errors[blockIndex] = error
      if (counted) return
      column.done += 1
      column.failed += 1
      refreshColumnStatus(column)
      emit()
    },

    onBatchMeta: (modelIndex, latencyMs, totalTokens, cacheHits) => {
      if (!alive()) return
      const column = columns[modelIndex]
      if (!column) return
      column.latencyMs += latencyMs
      column.totalTokens += totalTokens
      column.cacheHits += cacheHits
      refreshColumnStatus(column)
      emit()

      // 进度 Toast 与全文翻译同一套「突发语义」：冷却窗口内只更新文案，不堆叠
      const { done, total } = compareProgressOf(columns)
      toast(`${toastLabel} ${done} / ${total} 段`, {
        action: { label: TOAST_COPY.cancel, muted: true, onClick: () => cancelCompareRun() },
      })
    },

    onColumnFatal: (modelIndex, error) => {
      if (!alive()) return
      const column = columns[modelIndex]
      if (!column) return
      column.error = error
      // 把该列剩下没填的块一并标失败并计为已处理，否则列状态会永远停在「翻译中」
      column.errors.forEach((existing, index) => {
        if (existing !== null || column.translations[index]) return
        column.errors[index] = error
        column.done += 1
        column.failed += 1
      })
      refreshColumnStatus(column)
      emit()
    },
  }
}

function compareBase(): { sourceLang: string; useCache: boolean; type: 'fullpage' } {
  return {
    sourceLang: state.settings.sourceLang,
    useCache: state.settings.cacheEnabled,
    type: 'fullpage',
  }
}

/** 发起对比（FR-09） */
export async function startCompare(): Promise<void> {
  if (state.models.length < MIN_COMPARE_MODELS) {
    toast(`多模型对比至少需要 ${MIN_COMPARE_MODELS} 个已启用的模型`)
    return
  }
  if (isTranslating()) {
    toast('整页翻译进行中，请先等它结束或取消')
    return
  }
  if (isComparing()) return

  const selectedIds =
    state.compare.selectedIds.length >= MIN_COMPARE_MODELS
      ? state.compare.selectedIds.slice(0, MAX_COMPARE_MODELS)
      : defaultCompareSelection()

  const targets: CompareTarget[] = []
  for (const id of selectedIds) {
    const model = state.models.find((m) => m.id === id)
    if (model) targets.push({ model, targetLang: targetLangFor(model) })
  }
  if (targets.length < MIN_COMPARE_MODELS) {
    toast(`请至少勾选 ${MIN_COMPARE_MODELS} 个模型`)
    return
  }

  // 块快照：本轮对比只处理此刻页面上存在的块（FR-11 动态补翻属阶段 3）
  const blocks = sortByViewportFirst(collectBlocks(document))
  if (blocks.length === 0) {
    toast('未找到可对比的内容')
    return
  }

  const columns: CompareColumn[] = targets.map(({ model }) => ({
    modelId: model.id,
    modelName: model.name,
    provider: providerOf(model).label,
    status: 'queued',
    translations: new Array<string>(blocks.length).fill(''),
    errors: new Array<ErrorInfo | null>(blocks.length).fill(null),
    done: 0,
    failed: 0,
    latencyMs: 0,
    totalTokens: 0,
    cacheHits: 0,
    error: null,
  }))

  // 页面此刻已经在用的模型，若也在对比之列 —— 它天然就是「已应用」的那一列（G6 标橙）
  const current = activeModel()
  const appliedModelId =
    hasTranslations() && current && selectedIds.includes(current.id) ? current.id : null

  const runId = uid('cmp')
  state.compare = {
    selectedIds: [...selectedIds],
    columns,
    blocks,
    appliedModelId,
    status: 'running',
    runId,
  }
  state.sidebarOpen = true
  state.sidebarTab = 'compare'
  state.fabMenuOpen = false
  emit()

  const startedAt = Date.now()
  toast(`正在对比… 0 / ${blocks.length * columns.length} 段`, {
    action: { label: TOAST_COPY.cancel, muted: true, onClick: () => cancelCompareRun() },
  })

  await translateForCompare(targets, blocks, compareBase(), compareHooks(columns, runId, '正在对比…'))

  if (state.compare.runId !== runId) return

  columns.forEach(refreshColumnStatus)
  state.compare.runId = null
  state.compare.status = 'done'
  emit()

  // FR-05：对比的每个模型各记一条
  recordCompareHistory(columns, blocks, compareBase().sourceLang)

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  const failed = hasAnyFailure(columns)

  if (isAllFailed(columns)) {
    toast(`对比失败 · ${seconds}s`, {
      kind: 'error',
      persistent: true,
      action: { label: TOAST_COPY.retry, onClick: () => void startCompare() },
    })
  } else if (failed) {
    toast(`对比完成 · 部分列有失败段落 · ${seconds}s`, {
      kind: 'error',
      persistent: true,
      action: { label: TOAST_COPY.retry, onClick: () => void startCompare() },
    })
  } else {
    toast(`对比完成 · ${columns.length} 个模型 × ${blocks.length} 段 · ${seconds}s`, {
      kind: 'success',
    })
  }
}

/** 取消对比（保留已完成的部分结果，与全文翻译「已完成的批次结果保留」同一口径） */
export function cancelCompareRun(): void {
  if (state.compare.status !== 'running') return
  cancelCompare()
  state.compare.columns.forEach(refreshColumnStatus)
  state.compare.runId = null
  state.compare.status = 'done'
  emit()
  toast('已取消对比')
}

/**
 * 单列重试。
 *
 * 只把该列当成本轮唯一目标重跑：**已成功的块靠缓存免费命中**（`useCache` 开时），
 * 所以「重跑整列」等价于「只重试失败块」，但代码只有一条路径。
 * 缓存关闭时会真的重发整列 —— 这是显式用户动作，可接受。
 */
export async function retryCompareColumn(modelId: string): Promise<void> {
  if (state.compare.status === 'running' || isTranslating()) return

  const column = compareColumnOf(modelId)
  if (!column) return
  const model = state.models.find((m) => m.id === modelId)
  if (!model) return

  const blocks = state.compare.blocks
  if (blocks.length === 0) return

  const size = blocks.length
  column.translations = new Array<string>(size).fill('')
  column.errors = new Array<ErrorInfo | null>(size).fill(null)
  column.done = 0
  column.failed = 0
  column.latencyMs = 0
  column.totalTokens = 0
  column.cacheHits = 0
  column.error = null
  column.status = 'running'

  const runId = uid('cmp')
  state.compare.runId = runId
  state.compare.status = 'running'
  emit()

  toast(`正在重试… 0 / ${size} 段`, {
    action: { label: TOAST_COPY.cancel, muted: true, onClick: () => cancelCompareRun() },
  })

  await translateForCompare(
    [{ model, targetLang: targetLangFor(model) }],
    blocks,
    compareBase(),
    compareHooks([column], runId, '正在重试…'),
  )

  if (state.compare.runId !== runId) return

  refreshColumnStatus(column)
  state.compare.runId = null
  state.compare.status = 'done'
  emit()

  if (column.failed > 0) {
    toast(`「${column.modelName}」仍有 ${column.failed} 段失败`, {
      kind: 'error',
      persistent: true,
      action: { label: TOAST_COPY.goSettings, onClick: () => openApp('models') },
    })
  } else {
    toast(`「${column.modelName}」已全部重试成功`, { kind: 'success' })
  }
}

/**
 * FR-10「应用」= 把该模型在本页的译文映射设为当前生效版本（docs/00 §D-3）。
 * 页面立即按它渲染；**不重新请求、不覆盖缓存**，其余列的结果原样保留随时可切换。
 */
export async function applyCompareColumn(modelId: string): Promise<void> {
  const column = compareColumnOf(modelId)
  const blocks = state.compare.blocks
  if (!column || blocks.length === 0) return

  let applied = 0
  let failedBlocks = 0

  blocks.forEach((block, index) => {
    const text = column.translations[index]
    const error = column.errors[index]

    if (text) {
      const entry = ensureEntry(block)
      entry.translatedText = text
      entry.error = null
      setTranslationText(entry.node, entry.body, text)
      applied += 1
      return
    }
    if (error) {
      const entry = ensureEntry(block)
      entry.error = error
      setTranslationError(entry.node, entry.body, error, () => {
        void retryEntry(entry)
      })
      failedBlocks += 1
    }
  })

  if (applied === 0) {
    toast(`「${column.modelName}」这一列没有可应用的译文`)
    return
  }

  state.compare.appliedModelId = modelId
  state.status = state.entries.size > 0 ? 'translated' : 'idle'
  state.lastRunFailed = failedBlocks > 0
  emit()

  // 「仅原文」模式下属看不见译文，切到「对照」让结果可见 —— 与 D-3「换显」同一意图
  if (state.settings.displayMode === 'original-only') await setDisplayMode('bilingual')

  const suffix = failedBlocks > 0 ? ` · ${failedBlocks} 段失败` : ''
  toast(`已应用「${column.modelName}」的译文 · ${applied} 段${suffix}`, {
    kind: 'success',
    action: { label: TOAST_COPY.undo, onClick: () => restorePage() },
  })
}

/**
 * F3 行内操作「应用到页面」：把某条历史记录的译文套回**它自己的来源页**。
 *
 * 与 FR-10「应用」（换显已缓存的对比结果）不是一回事：这里的数据来自 IndexedDB，
 * 页面可能已经刷新过、块顺序可能变了，所以按**原文文本**配对，而不是按下标硬塞。
 *
 * 配不上的情况一律给一句人话，不静默失败：
 *  - 页面还没有译文块 → 先翻译本页；
 *  - 原文/译文段数不等 → 这条记录本身有失败段，无法精确对照（冻死的数据模型里没有对齐信息）。
 */
export async function applyHistoryRecord(
  sourceText: string,
  translatedText: string,
): Promise<void> {
  if (state.entries.size === 0) {
    toast('该页面还没有译文，先翻译本页再应用')
    return
  }

  const sources = splitSegments(sourceText)
  const translated = splitSegments(translatedText)
  if (sources.length === 0 || sources.length !== translated.length) {
    toast('这条记录有失败的段落，无法精确对照应用到页面')
    return
  }

  const pairs = new Map<string, string>()
  sources.forEach((source, index) => pairs.set(source, translated[index]))

  let applied = 0
  state.entries.forEach((entry) => {
    const hit = pairs.get(entry.sourceText)
    if (hit === undefined) return
    entry.translatedText = hit
    entry.error = null
    setTranslationText(entry.node, entry.body, hit)
    applied += 1
  })

  if (applied === 0) {
    toast('这条记录与当前页面没有可对应的段落')
    return
  }

  state.status = 'translated'
  state.lastRunFailed = false
  emit()

  if (state.settings.displayMode === 'original-only') await setDisplayMode('bilingual')
  toast(`已应用 ${applied} 段历史译文`, { kind: 'success' })
}

/** 回到勾选态（换一批模型再比一次） */
export function resetCompare(): void {
  if (state.compare.status === 'running') cancelCompare()
  state.compare = {
    ...state.compare,
    columns: [],
    blocks: [],
    appliedModelId: null,
    status: 'idle',
    runId: null,
  }
  emit()
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
  const targetLang = targetLangFor(model)

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

  // FR-05：划词也计入**全局历史**。
  // 注意与侧边栏「划词记录」区分（X4）：那个只属于当前页、刷新即散；
  // 这里落的是 IndexedDB，跨页面可查可筛可导出。
  recordHistory({
    model,
    sourceText: text,
    translatedText: result.ok ? result.text : null,
    error: result.ok ? null : result.error.message,
    sourceType: 'selection',
    sourceLang,
    targetLang,
    latencyMs: result.ok ? result.latencyMs : undefined,
    totalTokens: result.ok ? result.totalTokens : undefined,
  })

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
/* 复制（H1 右键菜单）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 写剪贴板。
 *
 * 为什么不用 `navigator.clipboard` 一条路走到底：内容脚本里的异步剪贴板 API 要求
 * 页面处于聚焦态，右键菜单点击后焦点在浏览器 UI 上，异步路径经常被判 `NotAllowedError`。
 * 所以先试异步 API，失败再退回 `execCommand('copy')` —— 后者只要还在用户手势的调用栈里就能成功。
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* 落到下面的兜底路径 */
  }

  try {
    const holder = document.createElement('textarea')
    holder.value = text
    holder.setAttribute('readonly', '')
    holder.setAttribute('aria-hidden', 'true')
    holder.className = 'transora-clip-holder'
    holder.style.cssText =
      'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none'
    document.body.appendChild(holder)
    holder.select()
    const ok = document.execCommand('copy')
    holder.remove()
    return ok
  } catch {
    return false
  }
}

/** 取当前选区文本；右键菜单入口会把浏览器算好的 `selectionText` 直接带下来 */
function currentSelectionText(fallback?: string): string {
  const fromDom = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? ''
  const text = fromDom || fallback?.replace(/\s+/g, ' ').trim() || ''
  return text
}

/**
 * H1：复制「原文」。
 * 原文就是选区本身，不依赖任何翻译状态。
 */
export async function copySelectionSource(fallback?: string): Promise<void> {
  const text = currentSelectionText(fallback)
  if (!text) {
    toast('请先选中要复制的文字')
    return
  }
  const ok = await writeClipboard(text)
  if (ok) toast('已复制原文', 'success')
  else toast('复制失败，请手动选中复制', 'error')
}

/**
 * H1：复制「译文」。
 *
 * 优先取本页已有的划词结果（同一次选区在 `selectionRecords` 里能找到就直接用）；
 * 找不到才真的去翻译一次 —— 否则用户右键「复制译文」时会拿到空字符串，比明确报错更糟。
 */
export async function copySelectionTranslation(fallback?: string): Promise<void> {
  const text = currentSelectionText(fallback)
  if (!text) {
    toast('请先选中要复制译文的文字')
    return
  }

  const cached = state.selectionRecords.find((record) => record.sourceText === text)
  if (cached?.translatedText) {
    const ok = await writeClipboard(cached.translatedText)
    if (ok) toast('已复制译文', 'success')
    else toast('复制失败，请手动选中复制', 'error')
    return
  }

  if (!activeModel()) {
    toastNoModel()
    return
  }

  // 单实例 Toast：这条会被下面的结果 Toast 原地替换（冷却窗口内只更新文案）
  toast('正在翻译选中的文字…')
  const result = await translateSelectionText(text)

  if (!result.ok) {
    toast(result.error?.message ?? '翻译失败', 'error')
    return
  }
  const ok = await writeClipboard(result.translatedText)
  if (ok) toast('已复制译文', 'success')
  else toast('复制失败，请手动选中复制', 'error')
}

/* ------------------------------------------------------------------ */
/* 指令分发（Background → Content）                                     */
/* ------------------------------------------------------------------ */

export function dispatchCommand(
  command: ContentCommand,
  payload?: { text?: string; sourceText?: string; translatedText?: string },
): void {
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
    case 'retry-failed':
      void retryFailedEntries()
      break
    case 'toggle-display-mode':
      cycleDisplayMode()
      break
    case 'copy-source':
      void copySelectionSource(payload?.text)
      break
    case 'copy-translation':
      void copySelectionTranslation(payload?.text)
      break
    case 'apply-history':
      void applyHistoryRecord(payload?.sourceText ?? '', payload?.translatedText ?? '')
      break
  }
}
