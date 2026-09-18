/**
 * Background Service Worker（MV3）
 *
 * 职责边界（docs/04 §二）：
 *   - 唯一的网络出口：所有 LLM 请求在这里发起（内容脚本发出会被 CORS 拦截，见 docs/00 §G-2）
 *   - 安全的模型解析：只接受 modelId，URL 由自己拼（绝不接受内容脚本传入的任意 URL）
 *   - 右键菜单 / 快捷键 / 安装落地页
 *   - 不操作 DOM
 */

import { TransoraError, fromUnknown } from '@/shared/errors'
import { addRecord } from '@/shared/history-db'
import { chatCompletion } from '@/shared/llm'
import {
  MSG,
  getActiveTabId,
  isTransoraMessage,
  sendToTab,
  type ApplyHistoryRequest,
  type ApplyHistoryResponse,
  type CancelRequest,
  type ContentCommand,
  type GetStateResponse,
  type HistoryAddRequest,
  type HistoryAddResponse,
  type OpenAppPageRequest,
  type PatchSettingsRequest,
  type TestConnectionRequest,
  type TestConnectionResponse,
  type TranslateBatchRequest,
  type TranslateBatchResponse,
  type TranslateProgressRequest,
} from '@/shared/messages'
import { buildBatchPrompt, parseBatchResponse } from '@/shared/prompt'
import {
  getModelById,
  getModels,
  getSettings,
  openAppPage,
  resetSettings,
  setSettings,
} from '@/shared/storage'
import { cancelSession, finishSession, getSession } from './sessions'
import { translateBatch } from './translate-service'

/* ------------------------------------------------------------------ */
/* A2 / H3 工具栏图标角标三态                                           */
/* ------------------------------------------------------------------ */

/** 与 FAB 角标同一套语义：进行中 = 已译块数，完成 = ✓，失败 = ! */
const BADGE = {
  done: { text: '✓', color: '#1F8A65' },
  error: { text: '!', color: '#C2410C' },
  progress: { color: '#F54E00' },
} as const

/** 完成 / 失败角标只停留一小会儿，之后回到「无角标」的安静状态 */
const BADGE_CLEAR_MS = 3500
let badgeClearTimer: ReturnType<typeof setTimeout> | null = null

function clearBadgeTimer(): void {
  if (badgeClearTimer !== null) {
    clearTimeout(badgeClearTimer)
    badgeClearTimer = null
  }
}

/** 进行中：角标显示已译块数（42 / 56 里的 42） */
async function showProgressBadge(done: number, total: number): Promise<void> {
  clearBadgeTimer()
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE.progress.color })
    await chrome.action.setBadgeText({ text: done > 0 ? String(done) : '' })
    await chrome.action.setTitle({
      title: `Transora · 翻译中 ${done} / ${total} 段`,
    })
  } catch {
    // 角标失败不应影响翻译主链路
  }
}

async function showResultBadge(failed: boolean): Promise<void> {
  clearBadgeTimer()
  const spec = failed ? BADGE.error : BADGE.done
  try {
    await chrome.action.setBadgeBackgroundColor({ color: spec.color })
    await chrome.action.setBadgeText({ text: spec.text })
    await chrome.action.setTitle({
      title: failed ? 'Transora · 部分段落翻译失败' : 'Transora · 翻译完成',
    })
  } catch {
    /* 同上 */
  }
  badgeClearTimer = setTimeout(() => {
    badgeClearTimer = null
    void resetBadge()
  }, BADGE_CLEAR_MS)
}

async function resetBadge(): Promise<void> {
  clearBadgeTimer()
  try {
    await chrome.action.setBadgeText({ text: '' })
    await chrome.action.setTitle({ title: 'Transora' })
  } catch {
    /* 同上 */
  }
}

/**
 * H1 右键菜单：4 项 + 1 条分隔线。
 * 次序与分组严格按设计稿 —— 上面两项是「翻译意图」，分隔线下面是「拿结果」。
 */
const MENU = {
  translateSelection: 'transora:translate-selection',
  togglePage: 'transora:toggle-page',
  separator: 'transora:separator',
  copySource: 'transora:copy-source',
  copyTranslated: 'transora:copy-translation',
} as const

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

function setupContextMenus(): void {
  // 先清后建，避免扩展重载时的 duplicate id 报错
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU.translateSelection,
      title: '翻译选中内容',
      contexts: ['selection'],
    })
    // 选中态也能直接用整页翻译，所以两个 context 都挂，保证右键菜单里 4 项始终同屏
    chrome.contextMenus.create({
      id: MENU.togglePage,
      title: '整页双语对照',
      contexts: ['page', 'selection'],
    })
    chrome.contextMenus.create({
      id: MENU.separator,
      type: 'separator',
      contexts: ['selection'],
    })
    chrome.contextMenus.create({
      id: MENU.copySource,
      title: '复制原文',
      contexts: ['selection'],
    })
    chrome.contextMenus.create({
      id: MENU.copyTranslated,
      title: '复制译文',
      contexts: ['selection'],
    })
  })
}

chrome.runtime.onInstalled.addListener((details) => {
  setupContextMenus()

  // X5：安装后自动打开一次「新标签页 · 模型配置」，仅首次（docs/00 §C1）
  if (details.reason === 'install') {
    openAppPage('models')
  }
})

chrome.runtime.onStartup.addListener(setupContextMenus)

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return

  switch (info.menuItemId) {
    case MENU.translateSelection:
      await sendToTab(tab.id, 'translate-selection')
      break
    case MENU.togglePage:
      await sendToTab(tab.id, 'toggle-translate')
      break
    case MENU.copySource:
      // 浏览器已经把选区文本算好了，直接带下去，内容脚本不必再读一次选区
      await sendToTab(tab.id, 'copy-source', { text: info.selectionText })
      break
    case MENU.copyTranslated:
      await sendToTab(tab.id, 'copy-translation', { text: info.selectionText })
      break
    default:
      break
  }
})

/** docs/00 §D-5 冻结键位 */
chrome.commands.onCommand.addListener(async (command: string) => {
  const tabId = await getActiveTabId()
  if (tabId === undefined) return
  const map: Record<string, ContentCommand> = {
    'toggle-translate': 'toggle-translate',
    'translate-selection': 'translate-selection',
    'toggle-sidebar': 'toggle-sidebar',
    // H1：Alt+Shift+M 切换 对照 / 译文 / 原文
    'toggle-display-mode': 'toggle-display-mode',
  }
  const mapped = map[command]
  if (mapped) await sendToTab(tabId, mapped)
})

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

async function handleTranslateBatch(
  request: TranslateBatchRequest,
): Promise<TranslateBatchResponse> {
  try {
    const model = await getModelById(request.modelId)
    if (!model) {
      return { ok: false, error: { kind: 'no-model', message: '尚未配置模型，完成配置后即可翻译', actions: ['configure'], retryable: false } }
    }

    const session = getSession(request.sessionId)
    if (session.canceled) {
      return { ok: false, error: { kind: 'canceled', message: '已取消', actions: [], retryable: false } }
    }

    const settings = await getSettings()
    const result = await translateBatch({
      model,
      texts: request.texts,
      sourceLang: request.sourceLang,
      targetLang: request.targetLang,
      useCache: request.useCache && settings.cacheEnabled,
      // E5「失败自动重试」开关：关掉就只发一次，不再指数退避
      autoRetry: settings.autoRetry,
      signal: session.controller.signal,
    })

    return {
      ok: true,
      translations: result.translations,
      latencyMs: result.latencyMs,
      totalTokens: result.totalTokens,
      cacheHits: result.cacheHits,
      missing: result.missing,
    }
  } catch (err) {
    const error = fromUnknown(err)
    if (error.info.kind === 'canceled') finishSession(request.sessionId)
    return { ok: false, error: error.info }
  }
}

async function handleTestConnection(
  request: TestConnectionRequest,
): Promise<TestConnectionResponse> {
  try {
    const prompt = buildBatchPrompt(
      [{ id: 1, text: 'Hello, world.' }],
      'en',
      'zh-CN',
    )
    const result = await chatCompletion({
      model: request.model,
      system: prompt.system,
      user: prompt.user,
      temperatureOverride: 0,
      timeoutMs: 30_000,
    })
    const parsed = parseBatchResponse(result.content, 1)
    return {
      ok: true,
      latencyMs: result.latencyMs,
      sample: parsed.get(1) ?? result.content.trim().slice(0, 80),
    }
  } catch (err) {
    return { ok: false, error: fromUnknown(err).info }
  }
}

/**
 * 落库一条翻译历史（FR-05）。
 *
 * 只做「收下 + 补上不可信的字段 + 写库」，不做内容加工 ——
 * 摘要、搜索、导出这些都在扩展页侧完成（那里能直接用同一份 IndexedDB）。
 */
async function handleHistoryAdd(
  request: HistoryAddRequest,
  sender: chrome.runtime.MessageSender,
): Promise<HistoryAddResponse> {
  try {
    const settings = await getSettings()
    const saved = await addRecord(
      {
        modelId: request.modelId,
        modelName: request.modelName,
        sourceText: request.sourceText,
        translatedText: request.translatedText,
        error: request.error,
        type: request.sourceType,
        // 来源页以发送方标签页为准，不信消息内容（同「URL 自拼」的安全边界）
        pageUrl: sender.tab?.url ?? '',
        sourceLang: request.sourceLang,
        targetLang: request.targetLang,
        // 时间戳由 Background 打：页面改不了记录时间，超限剪裁的顺序才可信
        timestamp: Date.now(),
        latencyMs: request.latencyMs,
        totalTokens: request.totalTokens,
      },
      settings.historyLimit,
    )
    return { ok: true, id: saved.id }
  } catch (err) {
    // 历史写入失败绝不能影响翻译主链路（翻译已经完成了，用户不该因为记不上账而看到报错）
    console.warn('[Transora] 翻译历史写入失败', err)
    return { ok: false }
  }
}

/**
 * F3 行内操作「应用到页面」：找到记录来源页那个标签页，把这段译文套回去。
 *
 * 找不到来源页**不算错误** —— 那只是最正常的降解路径（用户关掉页面了），
 * 所以返回 `reason: 'tab-not-open'` 让界面给一句人话，而不是抛一个「失败」。
 */
async function handleApplyHistory(request: ApplyHistoryRequest): Promise<ApplyHistoryResponse> {
  if (!request.pageUrl) return { ok: false, reason: 'tab-not-open' }

  const tabs = await chrome.tabs.query({ url: request.pageUrl })
  const target = tabs.find((tab) => tab.id !== undefined)
  if (target?.id === undefined) return { ok: false, reason: 'tab-not-open' }

  try {
    await chrome.tabs.sendMessage(target.id, {
      type: MSG.CMD,
      command: 'apply-history',
      payload: { sourceText: request.sourceText, translatedText: request.translatedText },
    })
    return { ok: true }
  } catch {
    // 来源页打开了但内容脚本不在（例如 chrome:// 或刚刷新还没注入）
    return { ok: false, reason: 'send-failed' }
  }
}

async function route(
  message: { type: string } & Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
) {
  switch (message.type) {
    case MSG.TRANSLATE_BATCH:
      return handleTranslateBatch(message as unknown as TranslateBatchRequest)

    case MSG.CANCEL: {
      const { sessionId } = message as unknown as CancelRequest
      return { ok: cancelSession(sessionId) }
    }

    case MSG.TEST_CONNECTION:
      return handleTestConnection(message as unknown as TestConnectionRequest)

    case MSG.GET_STATE: {
      const [models, settings] = await Promise.all([getModels(), getSettings()])
      const state: GetStateResponse = { models, settings }
      return state
    }

    case MSG.PATCH_SETTINGS: {
      const { patch } = message as unknown as PatchSettingsRequest
      return setSettings(patch)
    }

    case MSG.RESET_SETTINGS:
      return resetSettings()

    case MSG.TRANSLATE_PROGRESS: {
      const { phase, done, total } = message as unknown as TranslateProgressRequest
      if (phase === 'progress') await showProgressBadge(done, total)
      else if (phase === 'clear') await resetBadge()
      else await showResultBadge(phase === 'failed')
      return { ok: true }
    }

    case MSG.HISTORY_ADD:
      return handleHistoryAdd(message as unknown as HistoryAddRequest, sender)

    case MSG.APPLY_HISTORY:
      return handleApplyHistory(message as unknown as ApplyHistoryRequest)

    case MSG.OPEN_APP_PAGE: {
      const { hash } = message as unknown as OpenAppPageRequest
      openAppPage(hash)
      return { ok: true }
    }

    default:
      return { ok: false, error: { kind: 'unknown', message: `未知消息：${message.type}`, actions: [], retryable: false } }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTransoraMessage(message)) return undefined

  route(message as { type: string } & Record<string, unknown>, sender)
    .then(sendResponse)
    .catch((err: unknown) => {
      const error = err instanceof TransoraError ? err.info : fromUnknown(err).info
      sendResponse({ ok: false, error })
    })

  // 保持消息通道打开以支持异步响应
  return true
})
