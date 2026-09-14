/**
 * 内容脚本侧的翻译调度。
 *
 * 分工：**内容脚本负责批次切分与并发控制，Background 只负责单批的模型调用**（含重试/缓存）。
 * 理由见 shared/messages.ts 顶部注释（MV3 Service Worker 休眠导致会话状态丢失）。
 *
 * 并发上限 3（docs/00 §D-2）；批内文本顺序与 `texts` 一一对应，靠下标回填，不依赖模型输出顺序。
 */

import { groupByBatch, planBatches } from '@/shared/batching'
import { CONCURRENCY } from '@/shared/constants'
import { errorInfoOf } from '@/shared/errors'
import { MSG, sendToBackground, type TranslateBatchResponse } from '@/shared/messages'
import type { ErrorInfo, ModelConfig, TranslateType } from '@/shared/types'
import { uid } from '@/shared/utils'
import type { BlockCandidate } from './extractor'

export interface RunOptions {
  model: ModelConfig
  sourceLang: string
  targetLang: string
  useCache: boolean
  type: TranslateType
}

export interface RunHooks {
  onResult: (block: BlockCandidate, text: string) => void
  onError: (block: BlockCandidate, error: ErrorInfo) => void
  onProgress: (done: number, total: number) => void
}

/** 会让后续批次全部无意义的错误：直接终止整轮 */
const FATAL_KINDS = new Set(['no-model', 'auth', 'quota', 'invalid-config', 'canceled'])

let activeSession: { id: string; canceled: boolean } | null = null

export function isTranslating(): boolean {
  return activeSession !== null
}

/** 取消当前翻译会话：通知 Background 中断在途请求，并丢弃后续批次 */
export function cancelActiveTranslation(): void {
  if (!activeSession) return
  const { id } = activeSession
  activeSession.canceled = true
  activeSession = null
  void sendToBackground({ type: MSG.CANCEL, sessionId: id })
}

async function requestBatch(
  sessionId: string,
  modelId: string,
  texts: string[],
  options: RunOptions,
): Promise<TranslateBatchResponse> {
  return sendToBackground<TranslateBatchResponse>({
    type: MSG.TRANSLATE_BATCH,
    sessionId,
    modelId,
    texts,
    sourceLang: options.sourceLang,
    targetLang: options.targetLang,
    useCache: options.useCache,
    sourceType: options.type,
  })
}

/** 整页翻译：切批 → 并发 3 → 逐批回填 */
export async function translateBlocks(
  blocks: BlockCandidate[],
  options: RunOptions,
  hooks: RunHooks,
): Promise<void> {
  if (blocks.length === 0) return

  const session = { id: uid('sess'), canceled: false }
  activeSession = session

  const plan = planBatches(blocks.map((b) => b.text))
  const groups = groupByBatch(plan)
  const queue = [...groups.entries()].sort((a, b) => a[0] - b[0])
  const total = blocks.length

  let done = 0
  let fatal: ErrorInfo | null = null

  const worker = async (): Promise<void> => {
    for (;;) {
      if (session.canceled || fatal) return
      const item = queue.shift()
      if (!item) return

      const [, indexes] = item
      const texts = indexes.map((i) => plan.prepared[i])

      let response: TranslateBatchResponse
      try {
        response = await requestBatch(session.id, options.model.id, texts, options)
      } catch {
        response = { ok: false, error: errorInfoOf('network') }
      }

      if (session.canceled) return

      if (!response.ok || !response.translations) {
        const info = response.error ?? errorInfoOf('unknown')
        indexes.forEach((i) => hooks.onError(blocks[i], info))
        if (FATAL_KINDS.has(info.kind)) {
          fatal = info
          return
        }
      } else {
        const translations = response.translations
        indexes.forEach((i, order) => {
          const text = translations[order]
          if (text) hooks.onResult(blocks[i], text)
          else hooks.onError(blocks[i], errorInfoOf('refused', '本段未返回译文'))
        })
      }

      done += indexes.length
      hooks.onProgress(done, total)
    }
  }

  const workerCount = Math.max(1, Math.min(CONCURRENCY.FULL_PAGE, queue.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  if (activeSession === session) activeSession = null
}

/** 单条文本翻译结果（划词 / 单块重试）。耗时与 token 供 G5 元信息行展示 */
export type SingleTranslateResult =
  | { ok: true; text: string; latencyMs: number; totalTokens: number }
  | { ok: false; error: ErrorInfo }

/** 单条文本翻译（划词 / 单块重试） */
export async function translateText(
  text: string,
  options: RunOptions,
): Promise<SingleTranslateResult> {
  const sessionId = uid('one')
  try {
    const response = await requestBatch(sessionId, options.model.id, [text], options)
    if (!response.ok || !response.translations) {
      return { ok: false, error: response.error ?? errorInfoOf('unknown') }
    }
    const translated = response.translations[0]
    if (!translated) return { ok: false, error: errorInfoOf('refused') }
    return {
      ok: true,
      text: translated,
      latencyMs: response.latencyMs ?? 0,
      totalTokens: response.totalTokens ?? 0,
    }
  } catch {
    return { ok: false, error: errorInfoOf('network') }
  }
}
