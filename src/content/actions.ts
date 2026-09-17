/**
 * 动作层：内容脚本内所有「用户意图」的唯一入口。
 * 注入 UI（FAB / 侧边栏 / 划词内容块）与 Background 下发的指令都调用这里，
 * 保证同一动作在任何入口下行为一致。
 */

import { GUIDE_DOC_HASH, TOAST_COPY } from '@/shared/copy'
import { CONCURRENCY } from '@/shared/constants'
import { errorInfoOf } from '@/shared/errors'
import { langDisplayName } from '@/shared/langs'
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
  targetLangFor,
  type PageEntry,
  type SelectionRecord,
  type SidebarTab,
} from './state'
import { cancelActiveTranslation, isTranslating, translateBlocks, translateText } from './translator'
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
  })

  const canceled = run.canceled
  if (currentRun === run) currentRun = null
  if (canceled) return

  state.lastRunFailed = failed > 0
  state.status = state.entries.size > 0 ? 'translated' : 'idle'
  emit()

  // H3：收尾角标 —— 完成 ✓ / 失败 !
  reportProgress(failed > 0 ? 'failed' : 'done', state.progress.done, state.progress.total)

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

export function dispatchCommand(command: ContentCommand, payload?: { text?: string }): void {
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
  }
}
