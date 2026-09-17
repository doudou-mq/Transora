/**
 * D3「翻译前确认」的成本预估 —— 纯函数，便于单测。
 *
 * ⚠️ 这是一份**粗估**，不是账单：
 *   - token 数按「字符数 × TOKEN_RATIO」折算。中英混排下 1 个字符约 0.3–0.8 token，
 *     取 0.75 是为了覆盖 CJK 偏多 + prompt 模板开销，宁可高估一点。
 *   - 单价用 `PRICE_PER_MILLION`（默认 ¥2 / 百万 token）。各服务商差异很大，
 *     所以 Popup 里必须把「估算口径」写在卡片下方，不能只给一个数字。
 *   - 真实费用还取决于缓存命中（命中缓存的批次不发请求，实际更低）。
 *
 * 不引入后端、不做汇率换算，纯本地计算。
 */

import type { PagePlan } from './messages'

/** 字符 → token 的折算系数（保守取值，见文件头说明） */
export const TOKEN_RATIO = 0.75

/** 默认单价：¥ / 百万 token。改这一个常量即可切换估算口径 */
export const PRICE_PER_MILLION = 2

export interface CostEstimate {
  /** 预估总 token（输入 + 输出） */
  tokens: number
  /** 预估费用（元） */
  cost: number
  /** 需要发起的请求次数（批次数 × 模型数） */
  requests: number
}

/**
 * 按待翻译计划估成本。
 * @param plan   内容脚本给出的待翻译块数 / 字数 / 批次数
 * @param models 参与本轮翻译的模型数（全文翻译恒为 1；多模型对比时为 2–3）
 */
export function estimateCost(plan: PagePlan, models = 1): CostEstimate {
  const modelCount = Math.max(1, models)
  const tokens = Math.round(plan.chars * TOKEN_RATIO)
  return {
    tokens: tokens * modelCount,
    cost: (tokens * modelCount * PRICE_PER_MILLION) / 1_000_000,
    requests: Math.max(0, plan.batches) * modelCount,
  }
}

/** 千分位整数（1,840） */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/** token 数缩写：980 → `980`；5,240 → `5.2K`；1,240,000 → `1.2M` */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
  return String(tokens)
}

/** 金额：小额保留更多小数位，避免一律显示成 ¥0.00 */
export function formatCost(cost: number): string {
  if (cost <= 0) return '¥0'
  if (cost < 0.01) return `¥${cost.toFixed(4)}`
  if (cost < 1) return `¥${cost.toFixed(3)}`
  return `¥${cost.toFixed(2)}`
}
