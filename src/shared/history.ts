/**
 * 翻译历史（F1–F5 / FR-05 / FR-06 / FR-15）—— 纯逻辑层。
 *
 * 为什么单独抽一层：筛选匹配、相对时间、导出序列化、超限剪裁全都是**可判定的纯函数**，
 * 放这里就能被 vitest 直接覆盖，不必靠 e2e 去点页面（e2e 只验「接上了没有」）。
 *
 * 一条记录的口径（以设计稿 F3 为准）：
 *   **一次翻译动作 = 一条记录**。整页翻译不是「每段一条」，而是把整页原文/译文
 *   拼接成一条（F3 头行写「12 段 · 1,840 字」，说明段数是这条记录的统计量）。
 *   多模型对比时，每个模型各算一次翻译动作 → 每列各一条。
 */

import { formatCount } from './estimate'
import type { HistoryItem, TranslateType } from './types'

/** 来源类型的中文名（设计稿 F1 行内用词：「整页翻译 / 划词翻译 / 动态补翻（SPA）」） */
export const TYPE_LABEL: Record<TranslateType, string> = {
  selection: '划词翻译',
  fullpage: '整页翻译',
  dynamic: '动态补翻（SPA）',
}

export const ALL = 'all' as const

/** 时间范围选项（设计稿工具栏第三枚 chip 的展开项） */
export interface RangeOption {
  key: string
  label: string
  /** 毫秒窗口；null = 不限（「全部时间」） */
  windowMs: number | null
}

export const RANGE_OPTIONS: RangeOption[] = [
  { key: 'all', label: '全部时间', windowMs: null },
  { key: '1d', label: '近 24 小时', windowMs: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '近 7 天', windowMs: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '近 30 天', windowMs: 30 * 24 * 60 * 60 * 1000 },
]

/**
 * 默认筛选（设计稿 F3 副标题：「已筛选「模型：全部 / 类型：全部 / 近 7 天」」）
 * → 三个默认值以设计稿为准：全部 / 全部 / 近 7 天。
 */
export const DEFAULT_RANGE = '7d'

export interface HistoryFilter {
  keyword: string
  modelName: string
  type: TranslateType | typeof ALL
  range: string
}

export function defaultFilter(): HistoryFilter {
  return { keyword: '', modelName: ALL, type: ALL, range: DEFAULT_RANGE }
}

export function isFilterActive(filter: HistoryFilter): boolean {
  return (
    filter.keyword.trim() !== '' ||
    filter.modelName !== ALL ||
    filter.type !== ALL ||
    filter.range !== DEFAULT_RANGE
  )
}

/** 筛选状态的一句话描述（F3 副标题用） */
export function describeFilter(filter: HistoryFilter): string {
  const model = filter.modelName === ALL ? '模型：全部' : `模型：${filter.modelName}`
  const type = filter.type === ALL ? '类型：全部' : `类型：${TYPE_LABEL[filter.type]}`
  const range = RANGE_OPTIONS.find((o) => o.key === filter.range) ?? RANGE_OPTIONS[0]
  return `${model} / ${type} / ${range.label}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 同一天（按本地时区） */
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * 相对时间（设计稿 F1 行内：「今天 16:42」/「昨天 21:37」）。
 * 更早的记录依次退化为「9月12日 10:05」→「2025年9月12日」。
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const then = new Date(timestamp)
  const today = new Date(now)
  const hm = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`

  if (sameDay(then, today)) return `今天 ${hm}`

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(then, yesterday)) return `昨天 ${hm}`

  if (then.getFullYear() === today.getFullYear()) {
    return `${then.getMonth() + 1}月${then.getDate()}日 ${hm}`
  }
  return `${then.getFullYear()}年${then.getMonth() + 1}月${then.getDate()}日`
}

/** 列表行的元信息：「DeepSeek-V3 · 整页翻译 · 今天 16:42」 */
export function formatHistoryMeta(item: HistoryItem, now: number = Date.now()): string {
  return `${item.modelName} · ${TYPE_LABEL[item.type]} · ${formatRelativeTime(item.timestamp, now)}`
}

/** 原文按空行切段（拼接时用的分隔符就是 `\n\n`，所以这里能切回来） */
export function splitSegments(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * 规模摘要：「12 段 · 1,840 字」。
 *
 * 「字」取**字符数**而不是词数：原文常是英文，按词计数会显著低估篇幅，
 * 而这里的作用是让用户一眼判断这条记录有多大（设计稿 F3 头行的用法）。
 */
export function formatCorpusSize(item: HistoryItem): string {
  const segments = splitSegments(item.sourceText).length
  const chars = item.sourceText.replace(/\s/g, '').length
  return `${segments} 段 · ${formatCount(chars)} 字`
}

/** 时间窗口判定 */
export function inRange(timestamp: number, range: string, now: number = Date.now()): boolean {
  const option = RANGE_OPTIONS.find((o) => o.key === range)
  if (!option || option.windowMs === null) return true
  return timestamp >= now - option.windowMs
}

/** 单条是否命中筛选：关键词同时匹配原文与译文（FR-06） */
export function matchesFilter(
  item: HistoryItem,
  filter: HistoryFilter,
  now: number = Date.now(),
): boolean {
  if (filter.modelName !== ALL && item.modelName !== filter.modelName) return false
  if (filter.type !== ALL && item.type !== filter.type) return false
  if (!inRange(item.timestamp, filter.range, now)) return false

  const keyword = filter.keyword.trim().toLowerCase()
  if (keyword === '') return true
  const haystack = `${item.sourceText}\n${item.translatedText ?? ''}`.toLowerCase()
  return haystack.includes(keyword)
}

/** 按 timestamp 倒序（最新的在最上面） */
export function sortByRecency(records: HistoryItem[]): HistoryItem[] {
  return [...records].sort((a, b) => b.timestamp - a.timestamp)
}

export function filterRecords(
  records: HistoryItem[],
  filter: HistoryFilter,
  now: number = Date.now(),
): HistoryItem[] {
  return records.filter((item) => matchesFilter(item, filter, now))
}

/**
 * 超限剪裁（S11）：返回**应当删除**的记录 id。
 *
 * `records` 允许乱序，内部先按时间倒序再取「超出上限的最早若干条」。
 * 只回 id 不回记录，是因为调用方只需要拿它去删，不必关心内容。
 */
export function pruneIds(records: HistoryItem[], limit: number): number[] {
  const safeLimit = Math.max(0, Math.floor(limit))
  const ordered = sortByRecency(records)
  return ordered
    .slice(safeLimit)
    .map((item) => item.id)
    .filter((id): id is number => typeof id === 'number')
}

/** 可筛选的模型名（按记录里实际出现过的去重，保持最近使用的顺序） */
export function modelNamesOf(records: HistoryItem[]): string[] {
  const seen: string[] = []
  for (const item of sortByRecency(records)) {
    if (!seen.includes(item.modelName)) seen.push(item.modelName)
  }
  return seen
}

/** 可筛选的来源类型（同上） */
export function typesOf(records: HistoryItem[]): TranslateType[] {
  const seen: TranslateType[] = []
  for (const item of records) {
    if (!seen.includes(item.type)) seen.push(item.type)
  }
  return seen
}

/** 导出用的稳定时间戳：`2026-09-18 14:30:05`（本地时区，人看） */
export function formatStamp(timestamp: number): string {
  const d = new Date(timestamp)
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  )
}

/**
 * 导出为 JSON（F5：「含完整字段与时间戳」）。
 * 除了 `timestamp`（毫秒，机器读）额外给一个 `time`（人读），避免导出后还要自己换算。
 */
export function toJsonExport(records: HistoryItem[], now: number = Date.now()): string {
  return JSON.stringify(
    {
      app: 'Transora',
      exportedAt: formatStamp(now),
      count: records.length,
      records: records.map((item) => ({ ...item, time: formatStamp(item.timestamp) })),
    },
    null,
    2,
  )
}

function escapeMd(text: string): string {
  // 只处理会破坏结构的字符，不做过度的转义（导出目标是笔记软件，不是严苛的 Markdown 解析器）
  return text.replace(/^([#>*-])/gm, '\\$1')
}

function metaLine(item: HistoryItem): string {
  const bits = [`\`${item.sourceLang} → ${item.targetLang}\``]
  if (item.latencyMs !== undefined) bits.push(`耗时 ${(item.latencyMs / 1000).toFixed(1)}s`)
  if (item.totalTokens !== undefined) bits.push(`token ${formatCount(item.totalTokens)}`)
  return bits.join(' ｜ ')
}

/** 导出为 Markdown（F5：「便于粘贴到笔记」） */
export function toMarkdownExport(records: HistoryItem[], now: number = Date.now()): string {
  const lines: string[] = [
    '# Transora 翻译历史',
    '',
    `导出时间：${formatStamp(now)} ｜ 共 ${records.length} 条`,
    '',
  ]

  records.forEach((item, index) => {
    lines.push('---', '')
    lines.push(`## ${index + 1}. ${item.modelName} · ${TYPE_LABEL[item.type]}`)
    lines.push('')
    lines.push(`- 时间：${formatStamp(item.timestamp)}`)
    lines.push(`- ${metaLine(item)}`)
    lines.push(`- 来源：${item.pageUrl || '—'}`)
    lines.push('', '**原文**', '', escapeMd(item.sourceText), '')
    lines.push('**译文**', '')
    lines.push(item.translatedText ? escapeMd(item.translatedText) : `> 翻译失败：${item.error ?? '未知错误'}`)
    lines.push('')
  })

  return lines.join('\n')
}

/** 导出文件名：`transora-history-20260918-1430.json` */
export function exportFileName(ext: 'json' | 'md', now: number = Date.now()): string {
  const d = new Date(now)
  const stamp =
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}`
  return `transora-history-${stamp}.${ext}`
}
