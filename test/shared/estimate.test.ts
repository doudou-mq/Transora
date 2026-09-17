/**
 * D3 成本预估的纯函数单测。
 * 这些数字会直接出现在「翻译前确认」卡片上，所以口径必须锁住。
 */

import { describe, expect, it } from 'vitest'

import {
  PRICE_PER_MILLION,
  TOKEN_RATIO,
  estimateCost,
  formatCost,
  formatCount,
  formatTokens,
} from '@/shared/estimate'
import type { PagePlan } from '@/shared/messages'

const plan = (over: Partial<PagePlan> = {}): PagePlan => ({
  blocks: 12,
  chars: 1840,
  batches: 2,
  ...over,
})

describe('estimateCost', () => {
  it('token = 字符数 × 系数，费用按每百万 token 单价折算', () => {
    const result = estimateCost(plan())
    const tokens = Math.round(1840 * TOKEN_RATIO)
    expect(result.tokens).toBe(tokens)
    expect(result.cost).toBeCloseTo((tokens * PRICE_PER_MILLION) / 1_000_000, 10)
  })

  it('请求次数 = 批次数 × 模型数（阶段 1 恒为 1）', () => {
    expect(estimateCost(plan()).requests).toBe(2)
    expect(estimateCost(plan(), 3).requests).toBe(6)
  })

  it('多模型时 token 与费用按模型数线性放大', () => {
    const one = estimateCost(plan())
    const three = estimateCost(plan(), 3)
    expect(three.tokens).toBe(one.tokens * 3)
    expect(three.cost).toBeCloseTo(one.cost * 3, 10)
  })

  it('空计划不产生负值，也不会算出「0 批次」这种不存在的请求数', () => {
    const empty = estimateCost(plan({ blocks: 0, chars: 0, batches: 0 }))
    expect(empty.tokens).toBe(0)
    expect(empty.cost).toBe(0)
    expect(empty.requests).toBe(0)
  })

  it('模型数传入 0 或负数时按 1 处理', () => {
    expect(estimateCost(plan(), 0).tokens).toBe(estimateCost(plan(), 1).tokens)
    expect(estimateCost(plan(), -2).tokens).toBe(estimateCost(plan(), 1).tokens)
  })
})

describe('格式化', () => {
  it('千分位整数', () => {
    expect(formatCount(1840)).toBe('1,840')
    expect(formatCount(12)).toBe('12')
  })

  it('token 缩写', () => {
    expect(formatTokens(980)).toBe('980')
    expect(formatTokens(5240)).toBe('5.2K')
    expect(formatTokens(1_240_000)).toBe('1.2M')
  })

  it('金额按量级选小数位，避免小额被显示成 ¥0.00', () => {
    expect(formatCost(0)).toBe('¥0')
    expect(formatCost(0.0028)).toBe('¥0.0028')
    expect(formatCost(0.0123)).toBe('¥0.012')
    expect(formatCost(1.5)).toBe('¥1.50')
  })
})
