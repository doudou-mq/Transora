/**
 * 翻译历史（F1–F5）纯逻辑的单测。
 *
 * 重点钉死三件容易悄悄写错的事：
 *  ① 相对时间的日/年边界（「今天」「昨天」是按**本地日历日**判的，不是按 24 小时）
 *  ② 筛选必须是「模型 + 类型 + 时间窗」三者同时生效（漏一个就变成筛选失灵）
 *  ③ 超限剪裁删的是**最早**的记录，不是最新的（删反了会像「记录凭空消失」）
 */

import { describe, expect, it } from 'vitest'
import {
  ALL,
  defaultFilter,
  describeFilter,
  exportFileName,
  filterRecords,
  formatCorpusSize,
  formatHistoryMeta,
  formatRelativeTime,
  formatStamp,
  inRange,
  isFilterActive,
  matchesFilter,
  modelNamesOf,
  pruneIds,
  sortByRecency,
  splitSegments,
  toJsonExport,
  toMarkdownExport,
  TYPE_LABEL,
  typesOf,
} from '@/shared/history'
import type { HistoryItem } from '@/shared/types'

/** 固定「当前时间」，让所有时间断言语义稳定：2026-09-18 14:30 本地时间 */
const NOW = new Date(2026, 8, 18, 14, 30, 0).getTime()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function item(patch: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id: 1,
    modelId: 'm1',
    modelName: 'DeepSeek-V3',
    sourceText: 'Hello world',
    translatedText: '你好，世界',
    error: null,
    type: 'fullpage',
    pageUrl: 'https://example.com/a',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    timestamp: NOW - HOUR,
    ...patch,
  }
}

describe('formatRelativeTime', () => {
  it('当天 → 今天 HH:mm', () => {
    expect(formatRelativeTime(new Date(2026, 8, 18, 16, 42).getTime(), NOW)).toBe('今天 16:42')
  })

  it('前一天 → 昨天 HH:mm', () => {
    expect(formatRelativeTime(new Date(2026, 8, 17, 21, 37).getTime(), NOW)).toBe('昨天 21:37')
  })

  it('「昨天」按日历日算，不是按 24 小时：25 小时前只跨了 1 天', () => {
    // NOW(18 日 14:30) 往前 25 小时 = 17 日 13:30 → 昨天
    expect(formatRelativeTime(NOW - 25 * HOUR, NOW)).toBe('昨天 13:30')
    // 往前 13 小时 = 18 日 01:30 → 仍是今天
    expect(formatRelativeTime(NOW - 13 * HOUR, NOW)).toBe('今天 01:30')
  })

  it('更早的同年记录 → M月D日 HH:mm', () => {
    expect(formatRelativeTime(new Date(2026, 8, 12, 10, 5).getTime(), NOW)).toBe('9月12日 10:05')
  })

  it('跨年记录 → 2025年9月12日', () => {
    expect(formatRelativeTime(new Date(2025, 8, 12, 10, 5).getTime(), NOW)).toBe('2025年9月12日')
  })

  it('补零：个位数小时与分钟也占两位', () => {
    expect(formatRelativeTime(new Date(2026, 8, 18, 9, 5).getTime(), NOW)).toBe('今天 09:05')
  })
})

describe('formatHistoryMeta', () => {
  it('模型 · 类型 · 时间（设计稿 F1 行内格式）', () => {
    expect(formatHistoryMeta(item({ timestamp: new Date(2026, 8, 18, 16, 42).getTime() }), NOW)).toBe(
      'DeepSeek-V3 · 整页翻译 · 今天 16:42',
    )
  })

  it('三种来源类型的中文名与设计稿一致', () => {
    expect(TYPE_LABEL.selection).toBe('划词翻译')
    expect(TYPE_LABEL.fullpage).toBe('整页翻译')
    expect(TYPE_LABEL.dynamic).toBe('动态补翻（SPA）')
  })
})

describe('splitSegments / formatCorpusSize', () => {
  it('按空行切段，忽略空白段', () => {
    expect(splitSegments('a\n\nb\n\n\n\nc')).toEqual(['a', 'b', 'c'])
    expect(splitSegments('   ')).toEqual([])
  })

  it('单段也成立', () => {
    expect(splitSegments('只有一段')).toEqual(['只有一段'])
  })

  it('规模摘要 = 段数 · 字数（字数不含空白，带千分位）', () => {
    const text = `${'a'.repeat(1000)}\n\n${'b '.repeat(840).trim()}`
    expect(formatCorpusSize(item({ sourceText: text }))).toBe('2 段 · 1,840 字')
  })
})

describe('inRange', () => {
  it('已知窗口键的边界', () => {
    expect(inRange(NOW - 1 * DAY, '7d', NOW)).toBe(true)
    expect(inRange(NOW - 8 * DAY, '7d', NOW)).toBe(false)
    expect(inRange(NOW - 2 * DAY, '1d', NOW)).toBe(false)
    expect(inRange(NOW - 40 * DAY, 'all', NOW)).toBe(true)
  })

  it('未知窗口键按「不限」处理，不会把记录全筛掉', () => {
    expect(inRange(NOW - 400 * DAY, 'nonsense', NOW)).toBe(true)
  })
})

describe('matchesFilter', () => {
  const records: HistoryItem[] = [
    item({ id: 1, modelName: 'DeepSeek-V3', type: 'fullpage', sourceText: 'alpha', translatedText: '阿尔法', timestamp: NOW - 1 * HOUR }),
    item({ id: 2, modelName: '通义千问 Qwen', type: 'selection', sourceText: 'beta word', translatedText: '贝塔', timestamp: NOW - 2 * DAY }),
    item({ id: 3, modelName: 'Kimi', type: 'fullpage', sourceText: 'gamma', translatedText: '伽马', timestamp: NOW - 20 * DAY }),
  ]

  it('默认筛选 = 全部 / 全部 / 近 7 天', () => {
    const filter = defaultFilter()
    expect(filter).toEqual({ keyword: '', modelName: ALL, type: ALL, range: '7d' })
    expect(filterRecords(records, filter, NOW).map((r) => r.id)).toEqual([1, 2])
  })

  it('关键词同时搜原文与译文（FR-06）', () => {
    expect(filterRecords(records, { ...defaultFilter(), keyword: 'beta' }, NOW).map((r) => r.id)).toEqual([2])
    // 命中的是**译文**里的「贝塔」
    expect(filterRecords(records, { ...defaultFilter(), keyword: '贝塔' }, NOW).map((r) => r.id)).toEqual([2])
  })

  it('关键词大小写不敏感', () => {
    expect(filterRecords(records, { ...defaultFilter(), keyword: 'ALPHA' }, NOW).map((r) => r.id)).toEqual([1])
  })

  it('按模型筛：模型名里的空格也要精确匹配整名', () => {
    expect(filterRecords(records, { ...defaultFilter(), modelName: '通义千问 Qwen' }, NOW).map((r) => r.id)).toEqual([2])
    expect(filterRecords(records, { ...defaultFilter(), modelName: '通义千问' }, NOW)).toEqual([])
  })

  it('按类型筛', () => {
    expect(filterRecords(records, { ...defaultFilter(), type: 'fullpage' }, NOW).map((r) => r.id)).toEqual([1])
  })

  it('三个条件同时生效（不是「任一命中」）', () => {
    const filter = { keyword: 'gamma', modelName: 'Kimi', type: 'fullpage' as const, range: '30d' }
    expect(filterRecords(records, filter, NOW).map((r) => r.id)).toEqual([3])
    expect(matchesFilter(records[2], { ...filter, range: '7d' }, NOW)).toBe(false)
  })

  it('译文为 null 时不会因为读 null 而漏筛', () => {
    const failed = item({ id: 9, sourceText: 'needle', translatedText: null, error: 'timeout' })
    expect(matchesFilter(failed, { ...defaultFilter(), keyword: 'needle' }, NOW)).toBe(true)
    expect(matchesFilter(failed, { ...defaultFilter(), keyword: 'zzz' }, NOW)).toBe(false)
  })

  it('空白关键词视为不筛（避免敲个空格就把列表清空）', () => {
    expect(matchesFilter(records[0], { ...defaultFilter(), keyword: '   ' }, NOW)).toBe(true)
  })
})

describe('isFilterActive / describeFilter', () => {
  it('默认筛选不算「已筛选」', () => {
    expect(isFilterActive(defaultFilter())).toBe(false)
  })

  it('任一项变动即算已筛选', () => {
    expect(isFilterActive({ ...defaultFilter(), keyword: 'x' })).toBe(true)
    expect(isFilterActive({ ...defaultFilter(), modelName: 'Kimi' })).toBe(true)
    expect(isFilterActive({ ...defaultFilter(), range: 'all' })).toBe(true)
  })

  it('描述行与设计稿 F3 副标题同格式', () => {
    expect(describeFilter(defaultFilter())).toBe('模型：全部 / 类型：全部 / 近 7 天')
    expect(describeFilter({ keyword: '', modelName: 'Kimi', type: 'selection', range: 'all' })).toBe(
      '模型：Kimi / 类型：划词翻译 / 全部时间',
    )
  })
})

describe('sortByRecency / pruneIds', () => {
  it('倒序：最新的在最前', () => {
    const list = [item({ id: 1, timestamp: 100 }), item({ id: 2, timestamp: 300 }), item({ id: 3, timestamp: 200 })]
    expect(sortByRecency(list).map((r) => r.id)).toEqual([2, 3, 1])
  })

  it('不修改入参', () => {
    const list = [item({ id: 1, timestamp: 100 }), item({ id: 2, timestamp: 300 })]
    sortByRecency(list)
    expect(list.map((r) => r.id)).toEqual([1, 2])
  })

  it('未超限时不需要删任何东西', () => {
    expect(pruneIds([item({ id: 1 }), item({ id: 2 })], 5)).toEqual([])
  })

  it('超限时删除**最早**的若干条（保留最新 limit 条）', () => {
    const list = [1, 2, 3, 4, 5].map((id) => item({ id, timestamp: id * 1000 }))
    expect(pruneIds(list, 3)).toEqual([2, 1])
  })

  it('乱序输入也能正确剪裁', () => {
    const list = [item({ id: 3, timestamp: 3000 }), item({ id: 1, timestamp: 1000 }), item({ id: 2, timestamp: 2000 })]
    expect(pruneIds(list, 2)).toEqual([1])
  })

  it('limit 为 0 时全部删除', () => {
    expect(pruneIds([item({ id: 1, timestamp: 1000 }), item({ id: 2, timestamp: 2000 })], 0)).toEqual([2, 1])
  })

  it('没有 id 的记录（尚未落库）不参与删除', () => {
    const list = [{ ...item({ timestamp: 1000 }), id: undefined }, item({ id: 2, timestamp: 2000 })]
    expect(pruneIds(list, 1)).toEqual([])
  })
})

describe('modelNamesOf / typesOf', () => {
  it('模型名按最近使用顺序去重', () => {
    const list = [
      item({ id: 1, modelName: 'A', timestamp: 100 }),
      item({ id: 2, modelName: 'B', timestamp: 300 }),
      item({ id: 3, modelName: 'A', timestamp: 200 }),
    ]
    expect(modelNamesOf(list)).toEqual(['B', 'A'])
  })

  it('来源类型去重', () => {
    const list = [
      item({ id: 1, type: 'fullpage' }),
      item({ id: 2, type: 'selection' }),
      item({ id: 3, type: 'fullpage' }),
    ]
    expect(typesOf(list)).toEqual(['fullpage', 'selection'])
  })
})

describe('导出', () => {
  const records = [
    item({ id: 1, sourceText: 'Hello', translatedText: '你好', timestamp: new Date(2026, 8, 18, 16, 42).getTime(), latencyMs: 1200, totalTokens: 1840 }),
    item({ id: 2, sourceText: 'Failed one', translatedText: null, error: '请求超时', timestamp: new Date(2026, 8, 17, 9, 0).getTime() }),
  ]

  it('formatStamp 是人读格式', () => {
    expect(formatStamp(new Date(2026, 8, 18, 14, 30, 5).getTime())).toBe('2026-09-18 14:30:05')
  })

  it('JSON 导出含完整字段 + 人读时间', () => {
    const parsed = JSON.parse(toJsonExport(records, NOW))
    expect(parsed.app).toBe('Transora')
    expect(parsed.count).toBe(2)
    expect(parsed.records[0].modelId).toBe('m1')
    expect(parsed.records[0].sourceLang).toBe('en')
    expect(parsed.records[0].targetLang).toBe('zh-CN')
    expect(parsed.records[0].timestamp).toBeTypeOf('number')
    expect(parsed.records[0].time).toBe('2026-09-18 16:42:00')
  })

  it('Markdown 导出含头、计数与每条原文/译文', () => {
    const md = toMarkdownExport(records, NOW)
    expect(md).toContain('# Transora 翻译历史')
    expect(md).toContain('共 2 条')
    expect(md).toContain('## 1. DeepSeek-V3 · 整页翻译')
    expect(md).toContain('**原文**')
    expect(md).toContain('Hello')
    expect(md).toContain('你好')
    expect(md).toContain('`en → zh-CN`')
    expect(md).toContain('耗时 1.2s')
    expect(md).toContain('token 1,840')
  })

  it('Markdown 里失败的记录写成引用块，而不是留下空的译文段', () => {
    const md = toMarkdownExport(records, NOW)
    expect(md).toContain('> 翻译失败：请求超时')
  })

  it('Markdown 转义行首的 Markdown 记号，避免原文把结构顶坏', () => {
    const md = toMarkdownExport([item({ sourceText: '# 不是标题\n- 不是列表' })], NOW)
    expect(md).toContain('\\# 不是标题')
    expect(md).toContain('\\- 不是列表')
  })

  it('导出文件名带时间戳与扩展名', () => {
    expect(exportFileName('json', new Date(2026, 8, 18, 14, 30).getTime())).toBe(
      'transora-history-20260918-1430.json',
    )
    expect(exportFileName('md', new Date(2026, 0, 2, 3, 4).getTime())).toBe(
      'transora-history-20260102-0304.md',
    )
  })
})
