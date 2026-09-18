/**
 * 内容脚本侧的翻译调度。
 *
 * 分工：**内容脚本负责批次切分与并发控制，Background 只负责单批的模型调用**（含重试/缓存）。
 * 理由见 shared/messages.ts 顶部注释（MV3 Service Worker 休眠导致会话状态丢失）。
 *
 * 并发上限 3（docs/00 §D-2）；批内文本顺序与 `texts` 一一对应，靠下标回填，不依赖模型输出顺序。
 */

import { groupByBatch, planBatches } from '@/shared/batching'
import { planCompareTasks } from '@/shared/compare'
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
  /**
   * 每批成功后的用量回执（可选）。
   * 只给「要记账的人」用 —— 目前是翻译历史（FR-05）要累计耗时与 token，
   * 界面上并不展示整页的实时用量，所以不放进 onProgress 里强制所有人接。
   */
  onBatchMeta?: (latencyMs: number, totalTokens: number, cacheHits: number) => void
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
        hooks.onBatchMeta?.(
          response.latencyMs ?? 0,
          response.totalTokens ?? 0,
          response.cacheHits ?? 0,
        )
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

/* ------------------------------------------------------------------ */
/* G6 多模型对比调度（FR-09）                                            */
/* ------------------------------------------------------------------ */

/** 参与对比的一个目标：模型 + 它本次使用的目标语言（模型级覆盖 → 全局，由调用方解析） */
export interface CompareTarget {
  model: ModelConfig
  targetLang: string
}

export interface CompareRunBase {
  sourceLang: string
  useCache: boolean
  type: TranslateType
}

export interface CompareRunHooks {
  /** 某列某块成功 */
  onResult: (modelIndex: number, blockIndex: number, text: string) => void
  /** 某列某块失败（含「模型漏返回」） */
  onError: (modelIndex: number, blockIndex: number, error: ErrorInfo) => void
  /** 某列一批完成：累计耗时 / token / 缓存命中（G6 列头元信息） */
  onBatchMeta: (
    modelIndex: number,
    latencyMs: number,
    totalTokens: number,
    cacheHits: number,
  ) => void
  /** 某列遇到致命错误（auth / no-model…）：该列剩余批次不再发起，其余列不受影响 */
  onColumnFatal: (modelIndex: number, error: ErrorInfo) => void
}

let compareSession: { id: string; canceled: boolean } | null = null

/** 是否有一轮对比在进行（与整页翻译互斥，见 actions.startCompare） */
export function isComparing(): boolean {
  return compareSession !== null
}

/** 取消当前对比：通知 Background 中断在途请求，并丢弃后续任务 */
export function cancelCompare(): void {
  if (!compareSession) return
  const { id } = compareSession
  compareSession.canceled = true
  compareSession = null
  void sendToBackground({ type: MSG.CANCEL, sessionId: id })
}

/**
 * 多模型对比：**同一份块列表 × N 个模型**并发翻译。
 *
 * 并发口径（docs/00 §D-2「并发上限 3」是**全局**值）：
 * 不是「每个模型各 3 个槽」（那会是 9 个在途请求），而是**所有列共享 3 个 worker**，
 * 队列按批次轮转（planCompareTasks），保证各列同时推进而不是一列先跑完。
 *
 * 失败隔离：某一列致命失败只影响该列，其余列继续 —— 这是 §A2「每列独立 loading / 失败态」的实现。
 */
export async function translateForCompare(
  targets: readonly CompareTarget[],
  blocks: readonly BlockCandidate[],
  base: CompareRunBase,
  hooks: CompareRunHooks,
): Promise<void> {
  if (targets.length === 0 || blocks.length === 0) return

  const session = { id: uid('cmp'), canceled: false }
  compareSession = session

  // 所有模型共用同一份切分：块列表与文本完全一致，模型差异不影响批次边界
  const plan = planBatches(blocks.map((block) => block.text))
  const groups = groupByBatch(plan)
  const tasks = planCompareTasks(targets.length, plan.batchCount)

  /** 已判定致命失败的列：只跳过它的剩余任务，不牵连其他列 */
  const fatalColumns = new Set<number>()

  const worker = async (): Promise<void> => {
    for (;;) {
      if (session.canceled) return
      const task = tasks.shift()
      if (!task) return

      const { modelIndex, batchIndex } = task
      if (fatalColumns.has(modelIndex)) continue

      const indexes = groups.get(batchIndex)
      if (!indexes) continue

      const target = targets[modelIndex]
      const texts = indexes.map((i) => plan.prepared[i])

      let response: TranslateBatchResponse
      try {
        response = await requestBatch(session.id, target.model.id, texts, {
          model: target.model,
          sourceLang: base.sourceLang,
          targetLang: target.targetLang,
          useCache: base.useCache,
          type: base.type,
        })
      } catch {
        response = { ok: false, error: errorInfoOf('network') }
      }

      if (session.canceled) return

      if (!response.ok || !response.translations) {
        const info = response.error ?? errorInfoOf('unknown')
        indexes.forEach((i) => hooks.onError(modelIndex, i, info))
        if (FATAL_KINDS.has(info.kind)) {
          fatalColumns.add(modelIndex)
          hooks.onColumnFatal(modelIndex, info)
        }
      } else {
        const translations = response.translations
        indexes.forEach((i, order) => {
          const text = translations[order]
          if (text) hooks.onResult(modelIndex, i, text)
          else hooks.onError(modelIndex, i, errorInfoOf('refused', '本段未返回译文'))
        })
        hooks.onBatchMeta(
          modelIndex,
          response.latencyMs ?? 0,
          response.totalTokens ?? 0,
          response.cacheHits ?? 0,
        )
      }
    }
  }

  // 注意：tasks 会被 worker 用 shift 消耗，worker 数必须在开工前定好
  const taskCount = tasks.length
  const workerCount = Math.max(1, Math.min(CONCURRENCY.FULL_PAGE, taskCount))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  if (compareSession === session) compareSession = null
}
