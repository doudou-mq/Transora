/**
 * 单批翻译服务（在 Background 内执行）。
 *
 * 职责：
 *  1. 按文本粒度查缓存（S12），命中即跳过请求；
 *  2. 对未命中的文本发起一次模型请求，失败按 S13 重试（2 次 + 指数退避）；
 *  3. 解析后对「模型漏返回的段落」做补救轮询，最多 3 轮；
 *  4. 回写缓存。
 *
 * 为什么缓存是**文本粒度**而不是批次粒度：同一段落在不同批次、不同页面里会反复出现，
 * 按文本缓存才能真正做到「同文本不重复请求」。
 */

import { RETRY } from '@/shared/constants'
import { TransoraError, fromUnknown, isRetryableKind } from '@/shared/errors'
import { chatCompletion } from '@/shared/llm'
import { buildBatchPrompt, parseBatchResponse } from '@/shared/prompt'
import { getCache, writeCacheEntry } from '@/shared/storage'
import type { ModelConfig, Segment } from '@/shared/types'
import { hashString, sleep } from '@/shared/utils'

export interface TranslateBatchArgs {
  model: ModelConfig
  texts: string[]
  sourceLang: string
  targetLang: string
  useCache: boolean
  signal: AbortSignal
}

export interface TranslateBatchResult {
  /** 与入参 texts 等长、下标一一对应；失败段落为空字符串 */
  translations: string[]
  latencyMs: number
  totalTokens: number
  cacheHits: number
  /** 模型未返回译文的段落数 */
  missing: number
}

function cacheKeyOf(
  model: ModelConfig,
  sourceLang: string,
  targetLang: string,
  text: string,
): string {
  return `${model.id}|${model.model}|${sourceLang}|${targetLang}|${hashString(text)}`
}

interface SingleRoundResult {
  map: Map<number, string>
  latencyMs: number
  totalTokens: number
}

/** 一次模型请求（含 S13 重试） */
async function requestWithRetry(
  model: ModelConfig,
  segments: readonly Segment[],
  sourceLang: string,
  targetLang: string,
  signal: AbortSignal,
): Promise<SingleRoundResult> {
  const { system, user } = buildBatchPrompt(segments, sourceLang, targetLang)

  let lastError: TransoraError | null = null

  for (let attempt = 0; attempt <= RETRY.MAX; attempt += 1) {
    if (signal.aborted) throw TransoraError.of('canceled')

    try {
      const result = await chatCompletion({ model, system, user, signal })
      return {
        map: parseBatchResponse(result.content, segments.length),
        latencyMs: result.latencyMs,
        totalTokens: result.usage?.total_tokens ?? 0,
      }
    } catch (err) {
      const error = fromUnknown(err)
      lastError = error

      // 用户取消 / 不可重试错误：直接抛出
      if (error.info.kind === 'canceled' || !isRetryableKind(error.info.kind)) throw error

      // 已用尽重试次数
      if (attempt === RETRY.MAX) throw error

      const delay = RETRY.BASE_DELAY_MS * RETRY.FACTOR ** attempt
      await sleep(delay)
    }
  }

  throw lastError ?? TransoraError.of('unknown')
}

export async function translateBatch(args: TranslateBatchArgs): Promise<TranslateBatchResult> {
  const { model, texts, sourceLang, targetLang, useCache, signal } = args
  const translations = new Array<string>(texts.length).fill('')

  /* ---------- 1. 文本级缓存 ---------- */
  const missingIndexes: number[] = []
  let cacheHits = 0

  if (useCache) {
    const cache = await getCache()
    texts.forEach((text, index) => {
      const hit = cache[cacheKeyOf(model, sourceLang, targetLang, text)]
      if (typeof hit === 'string' && hit.trim()) {
        translations[index] = hit
        cacheHits += 1
      } else {
        missingIndexes.push(index)
      }
    })
  } else {
    texts.forEach((_, index) => missingIndexes.push(index))
  }

  if (missingIndexes.length === 0) {
    return { translations, latencyMs: 0, totalTokens: 0, cacheHits, missing: 0 }
  }

  /* ---------- 2. 构造 segment（id 稳定，便于多轮补救） ---------- */
  const segments: Segment[] = missingIndexes.map((textIndex, order) => ({
    id: order + 1,
    text: texts[textIndex],
  }))

  let latencyMs = 0
  let totalTokens = 0
  const resolved = new Map<number, string>()

  /* ---------- 3. 请求 + 漏段补救（最多 3 轮） ---------- */
  let pending: Segment[] = segments
  for (let round = 0; round < 3 && pending.length > 0; round += 1) {
    const result = await requestWithRetry(model, pending, sourceLang, targetLang, signal)
    latencyMs += result.latencyMs
    totalTokens += result.totalTokens

    // 模型整批失败（一条都没解析出来）：再问也是一样，跳出
    if (result.map.size === 0) break

    const stillPending: Segment[] = []
    for (const segment of pending) {
      const value = result.map.get(segment.id)
      if (value && value.trim()) resolved.set(segment.id, value.trim())
      else stillPending.push(segment)
    }
    pending = stillPending
  }

  /* ---------- 4. 回填 + 写缓存 ---------- */
  segments.forEach((segment, order) => {
    const value = resolved.get(segment.id)
    if (!value) return
    const textIndex = missingIndexes[order]
    translations[textIndex] = value
    if (useCache) {
      void writeCacheEntry(cacheKeyOf(model, sourceLang, targetLang, texts[textIndex]), value)
    }
  })

  return {
    translations,
    latencyMs,
    totalTokens,
    cacheHits,
    missing: segments.length - resolved.size,
  }
}
