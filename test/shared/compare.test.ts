/**
 * G6 多模型对比纯逻辑的单测。
 *
 * 为什么单独测这层：并发调度与列状态归并是「一写错就整列静默卡住」的地方
 * （例如失败块不计入 done，列状态会永远停在「翻译中」），而 e2e 里要复现
 * 「3 列并发 + 单列致命失败」既慢又不稳。纯函数在这里钉死口径，e2e 只验集成。
 */

import { describe, expect, it } from 'vitest'
import {
  columnStatusOf,
  formatColumnMeta,
  hasAnyFailure,
  isAllFailed,
  planCompareTasks,
} from '@/shared/compare'

describe('planCompareTasks', () => {
  it('按批次轮转：同一批的 N 个模型相邻，保证各列同时推进', () => {
    expect(planCompareTasks(2, 3)).toEqual([
      { modelIndex: 0, batchIndex: 0 },
      { modelIndex: 1, batchIndex: 0 },
      { modelIndex: 0, batchIndex: 1 },
      { modelIndex: 1, batchIndex: 1 },
      { modelIndex: 0, batchIndex: 2 },
      { modelIndex: 1, batchIndex: 2 },
    ])
  })

  it('三模型单批：首屏批次里三列都在最前面', () => {
    expect(planCompareTasks(3, 1)).toEqual([
      { modelIndex: 0, batchIndex: 0 },
      { modelIndex: 1, batchIndex: 0 },
      { modelIndex: 2, batchIndex: 0 },
    ])
  })

  it('任务总数 = 模型数 × 批次数', () => {
    expect(planCompareTasks(3, 5)).toHaveLength(15)
  })

  it('空输入不产生任务（模型 0 个 / 批次 0 批都算）', () => {
    expect(planCompareTasks(0, 4)).toEqual([])
    expect(planCompareTasks(3, 0)).toEqual([])
  })
})

describe('columnStatusOf', () => {
  it('未跑完：一块都没处理是排队中，处理过一部分是翻译中', () => {
    expect(columnStatusOf(0, 10, 0)).toBe('queued')
    expect(columnStatusOf(4, 10, 1)).toBe('running')
  })

  it('失败块也算「已处理」，否则失败列会永远停在翻译中', () => {
    expect(columnStatusOf(10, 10, 10)).toBe('failed')
    expect(columnStatusOf(10, 10, 3)).toBe('partial')
  })

  it('零失败 = 已完成；空列（total 0）也算已完成而不是排队中', () => {
    expect(columnStatusOf(10, 10, 0)).toBe('done')
    expect(columnStatusOf(0, 0, 0)).toBe('done')
  })
})

describe('formatColumnMeta', () => {
  it('正常请求展示耗时与 token（G6 图例格式）', () => {
    expect(formatColumnMeta(812, 128, 0)).toBe('0.8s · 128 tok')
  })

  it('耗时与 token 都是 0 且有缓存命中 → 显示「命中缓存」而不是 0.0s', () => {
    expect(formatColumnMeta(0, 0, 5)).toBe('命中缓存')
  })

  it('既无耗时也无缓存（整列在发出前被取消）→ 占位符', () => {
    expect(formatColumnMeta(0, 0, 0)).toBe('—')
  })
})

describe('整体收尾判定', () => {
  it('isAllFailed：只有全部列失败才算「全部失败」', () => {
    expect(isAllFailed([{ status: 'failed' }, { status: 'failed' }])).toBe(true)
    expect(isAllFailed([{ status: 'failed' }, { status: 'done' }])).toBe(false)
    expect(isAllFailed([])).toBe(false)
  })

  it('hasAnyFailure：partial 与 failed 都算「有失败」', () => {
    expect(hasAnyFailure([{ status: 'done' }, { status: 'partial' }])).toBe(true)
    expect(hasAnyFailure([{ status: 'done' }, { status: 'queued' }])).toBe(false)
  })
})
