/**
 * 区块三：翻译历史（FR-05 / FR-06 / FR-15）—— **阶段 2 交付**。
 *
 * 阶段 1 先给出确定的形态与字段口径，避免用户以为功能缺失；
 * 数据模型见 docs/04 §7.2（HistoryItem），存储介质为 IndexedDB（D4）。
 */

import { el } from '../store'

const FIELDS: Array<[string, string]> = [
  ['模型', '记录使用的模型名，支持按模型筛选'],
  ['原文 / 译文', '完整保存，可复制、可删除'],
  ['来源类型', '划词 / 全文 / 动态补翻'],
  ['来源页面', '记录 pageUrl，可回溯到出处'],
  ['语言对', '源语言 → 目标语言'],
  ['时间与耗时', '时间戳、请求耗时、token 消耗'],
]

const CAPABILITIES: string[] = [
  '按关键词搜索原文与译文',
  '按模型、类型、时间范围筛选',
  '导出 JSON / Markdown / CSV（作用于当前筛选结果）',
  '上限 1000 条，超出自动清理最早记录',
  '一键清空（二次确认）',
]

export function renderHistory(): HTMLElement {
  const container = el('div', 'section')

  const card = el('div', 'tr-card onboarding')
  card.appendChild(el('div', 'onboarding-title', '翻译历史将在阶段 2 开放'))

  card.appendChild(
    el(
      'p',
      'onboarding-desc',
      '历史完全保存在本机（IndexedDB），不联网、不上传、无账号。它记录每一次翻译的原文、译文与所用模型，方便你回查与导出。',
    ),
  )

  const fieldTitle = el('div', 'subsection-title', '记录的字段')
  card.appendChild(fieldTitle)

  const fieldList = el('div', 'history-fields')
  for (const [name, desc] of FIELDS) {
    const item = el('div', 'history-field')
    item.appendChild(el('div', 'history-field-name', name))
    item.appendChild(el('div', 'history-field-desc', desc))
    fieldList.appendChild(item)
  }
  card.appendChild(fieldList)

  const capTitle = el('div', 'subsection-title', '计划提供的能力')
  card.appendChild(capTitle)

  const caps = el('ul', 'history-caps')
  for (const line of CAPABILITIES) {
    caps.appendChild(el('li', undefined, line))
  }
  card.appendChild(caps)

  container.appendChild(card)

  const footnote = el('p', 'section-footnote')
  footnote.textContent = '当前版本（v0.1.0）聚焦「配置模型 → 划词翻译 → 全文对照翻译」这条最小闭环。'
  container.appendChild(footnote)

  return container
}
