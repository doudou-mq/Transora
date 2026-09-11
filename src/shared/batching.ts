/**
 * 批次切分（docs/00 §D-2）。
 *
 * 规则：单批 ≤ 40 块 **且** ≤ 2000 字符，先到者为准。
 * 单块超长（> BLOCK_MAX_CHARS）时先截断，避免一个块独自撑爆整批。
 */

import { BATCH, BLOCK_MAX_CHARS } from './constants'

export interface BatchPlan {
  /** 每条文本归属的批次号 */
  batchOf: number[]
  /** 实际送往模型的文本（已按 BLOCK_MAX_CHARS 截断） */
  prepared: string[]
  batchCount: number
}

/**
 * 依据预算切分文本数组。
 * 返回的 batchOf[i] 表示 prepared[i] 属于第几批；调用方据此并发投递。
 */
export function planBatches(
  texts: readonly string[],
  maxBlocks: number = BATCH.MAX_BLOCKS,
  maxChars: number = BATCH.MAX_CHARS,
): BatchPlan {
  const prepared = texts.map((t) => (t.length > BLOCK_MAX_CHARS ? t.slice(0, BLOCK_MAX_CHARS) : t))
  const batchOf = new Array<number>(prepared.length).fill(0)

  let batchIndex = 0
  let blocksInBatch = 0
  let charsInBatch = 0

  for (let i = 0; i < prepared.length; i += 1) {
    const len = prepared[i].length
    const wouldOverflow =
      blocksInBatch >= maxBlocks ||
      (blocksInBatch > 0 && charsInBatch + len > maxChars)

    if (wouldOverflow) {
      batchIndex += 1
      blocksInBatch = 0
      charsInBatch = 0
    }

    batchOf[i] = batchIndex
    blocksInBatch += 1
    charsInBatch += len
  }

  return {
    batchOf,
    prepared,
    batchCount: prepared.length === 0 ? 0 : batchIndex + 1,
  }
}

/** 把数组按 batchOf 分组，返回 {batchIndex: 下标数组} */
export function groupByBatch(plan: BatchPlan): Map<number, number[]> {
  const groups = new Map<number, number[]>()
  plan.batchOf.forEach((batch, index) => {
    const list = groups.get(batch)
    if (list) list.push(index)
    else groups.set(batch, [index])
  })
  return groups
}
