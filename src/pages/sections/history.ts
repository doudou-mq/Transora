/**
 * 区块三：翻译历史（F1–F5 / FR-05 / FR-06 / FR-15）—— 阶段 2 交付。
 *
 * 五态与设计稿 F 区的对应关系：
 *   F1 列表 + 搜索筛选   → 工具栏（搜索框 + 模型/类型/时间三枚 chip）+ 行列表
 *   F2 空态              → `buildEmpty()`
 *   F3 详情展开          → 点行展开的详情卡（原文 / 译文 / 来源 + 4 个行内操作）
 *   F4 清空二次确认      → 遮罩 + 480 宽模态
 *   F5 导出菜单          → 导出下拉（JSON / Markdown，作用于**当前筛选结果**）
 *
 * 两条实现要点：
 *
 * 1. **筛选态与列表分居两个宿主**。搜索框如果在每次重绘里重建，用户打一个字就会丢焦点 ——
 *    所以工具栏只建一次，重绘只换 `listHost` 里的内容。
 *
 * 2. **筛选态放在模块级**，不放 DOM 里。这样外部触发重绘（例如从别的标签页翻完页切回来）
 *    不会把用户正在用的筛选条件冲掉。
 */

import {
  ALL,
  defaultFilter,
  describeFilter,
  exportFileName,
  filterRecords,
  formatCorpusSize,
  formatHistoryMeta,
  isFilterActive,
  modelNamesOf,
  RANGE_OPTIONS,
  splitSegments,
  toJsonExport,
  toMarkdownExport,
  TYPE_LABEL,
  typesOf,
  type HistoryFilter,
} from '@/shared/history'
import { clearAll, deleteRecord, queryAll } from '@/shared/history-db'
import { MSG, sendToBackground } from '@/shared/messages'
import type { HistoryItem } from '@/shared/types'
import { el, getContext, type SectionContext } from '../store'

/* ------------------------------------------------------------------ */
/* 模块级状态                                                          */
/* ------------------------------------------------------------------ */

let records: HistoryItem[] = []
let filter: HistoryFilter = defaultFilter()
/** 展开详情的记录 id（F3）。同时只展开一条，避免长页面上一下铺出好几屏 */
let expandedId: number | null = null
let exportMenuOpen = false
let clearModalOpen = false
let loaded = false

let listHost: HTMLElement | null = null
let chipsHost: HTMLElement | null = null
let overlayHost: HTMLElement | null = null
let headerCtx: SectionContext | null = null
let visibilityHooked = false

/* ------------------------------------------------------------------ */
/* 数据                                                                */
/* ------------------------------------------------------------------ */

async function load(): Promise<void> {
  try {
    records = await queryAll()
  } catch (err) {
    // 读不出来（配额回收 / 隐私模式禁 IndexedDB）时不要把整页打崩，退化成空态并留个日志
    console.warn('[Transora] 读取翻译历史失败', err)
    records = []
  }
  loaded = true
}

function limit(): number {
  return getContext().settings.historyLimit
}

/* ------------------------------------------------------------------ */
/* 下载                                                                */
/* ------------------------------------------------------------------ */

function download(name: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  // 立刻撤销会让部分场景来不及取内容，这里交给下一轮事件循环
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/* ------------------------------------------------------------------ */
/* 页头（F1 / F2 / F3 的副标题 + 右上角导出 / 清空）                     */
/* ------------------------------------------------------------------ */

function headerDesc(): string {
  const base =
    records.length === 0
      ? '共 0 条记录 · 所有翻译记录仅存储在本机'
      : `共 ${records.length} 条记录 · 仅存储在本机（上限 ${limit()} 条，超出自动清理最早的记录）`

  // 设计稿 F3 的「已筛选「…」」只在用户真的动过筛选时加 ——
  // 默认值（全部 / 全部 / 近 7 天）照抄在副标题里只是噪音
  return isFilterActive(filter) ? `${base} · 已筛选「${describeFilter(filter)}」` : base
}

function updateHeader(): void {
  if (!headerCtx) return
  headerCtx.setHeaderDesc(headerDesc())

  const exportButton = el('button', 'tr-btn tr-btn--sm', '导出')
  exportButton.type = 'button'
  exportButton.disabled = records.length === 0
  exportButton.addEventListener('click', () => {
    exportMenuOpen = !exportMenuOpen
    clearModalOpen = false
    renderOverlays()
  })

  const clearButton = el('button', 'tr-btn tr-btn--sm', '清空')
  clearButton.type = 'button'
  clearButton.disabled = records.length === 0
  clearButton.addEventListener('click', () => {
    clearModalOpen = true
    exportMenuOpen = false
    renderOverlays()
  })

  headerCtx.setHeaderActions([exportButton, clearButton])
}

/* ------------------------------------------------------------------ */
/* 工具栏（F1：搜索 + 模型 / 类型 / 时间）                              */
/* ------------------------------------------------------------------ */

/**
 * 工具栏：搜索框**只建一次**（重绘会让它失焦），chips 交给 `chipsHost` 反复重建。
 *
 * 为什么 chips 必须能重建：选项是从**已有记录**里推出来的（模型名 / 类型）。
 * 记录是异步读出来的 —— 若 chips 也只在挂载时建一次，首屏永远只有「全部」一个选项，
 * 用户根本筛不了。
 */
function buildToolbar(): HTMLElement {
  const row = el('div', 'history-toolbar')

  const search = el('div', 'history-search')
  search.appendChild(svgIcon('search'))
  const input = document.createElement('input')
  input.type = 'search'
  input.className = 'history-search-input'
  input.placeholder = '搜索原文或译文…'
  input.value = filter.keyword
  input.setAttribute('aria-label', '搜索原文或译文')
  input.addEventListener('input', () => {
    filter = { ...filter, keyword: input.value }
    renderList()
  })
  search.appendChild(input)
  row.appendChild(search)

  chipsHost = el('div', 'history-chips')
  row.appendChild(chipsHost)
  renderChips()

  return row
}

function renderChips(): void {
  if (!chipsHost) return
  chipsHost.replaceChildren()

  chipsHost.appendChild(
    buildChip(
      '模型',
      [{ value: ALL, label: '全部' }, ...modelNamesOf(records).map((n) => ({ value: n, label: n }))],
      filter.modelName,
      (value) => {
        filter = { ...filter, modelName: value }
        renderList()
      },
    ),
  )
  chipsHost.appendChild(
    buildChip(
      '类型',
      [
        { value: ALL, label: '全部' },
        ...typesOf(records).map((t) => ({ value: t, label: TYPE_LABEL[t] })),
      ],
      filter.type,
      (value) => {
        filter = { ...filter, type: value as HistoryFilter['type'] }
        renderList()
      },
    ),
  )
  chipsHost.appendChild(
    buildChip(
      '时间',
      RANGE_OPTIONS.map((o) => ({ value: o.key, label: o.label })),
      filter.range,
      (value) => {
        filter = { ...filter, range: value }
        renderList()
      },
    ),
  )
}

interface ChipOption {
  value: string
  label: string
}

/** 一枚 chip = 「模型：」前缀 + 覆盖在上面的原生 select（保留键盘可达性，不自造弹层） */
function buildChip(
  prefix: string,
  options: ChipOption[],
  current: string,
  onChange: (value: string) => void,
): HTMLElement {
  const chip = el('label', 'history-chip')
  chip.appendChild(el('span', 'history-chip-prefix', `${prefix}：`))

  const select = document.createElement('select')
  select.className = 'history-chip-select'
  select.setAttribute('aria-label', prefix)
  for (const option of options) {
    const node = document.createElement('option')
    node.value = option.value
    node.textContent = option.label
    select.appendChild(node)
  }
  // 筛选值可能已不在当前选项里（例如记录被清空后原模型名消失），回落到「全部」
  select.value = options.some((o) => o.value === current) ? current : ALL
  select.addEventListener('change', () => onChange(select.value))
  chip.appendChild(select)

  return chip
}

function svgIcon(kind: 'search' | 'empty'): SVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')

  if (kind === 'search') {
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'var(--tr-muted-soft)')
    svg.setAttribute('stroke-width', '1.75')
    svg.setAttribute('stroke-linecap', 'round')
    const circle = document.createElementNS(NS, 'circle')
    circle.setAttribute('cx', '11')
    circle.setAttribute('cy', '11')
    circle.setAttribute('r', '6.5')
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', 'M16 16l4 4')
    svg.append(circle, path)
    return svg
  }

  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '44')
  svg.setAttribute('height', '44')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'var(--tr-ink-muted)')
  svg.setAttribute('stroke-width', '1.4')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const box = document.createElementNS(NS, 'path')
  box.setAttribute('d', 'M3 13l2.5-7.4A2 2 0 0 1 7.4 4h9.2a2 2 0 0 1 1.9 1.6L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z')
  const tray = document.createElementNS(NS, 'path')
  tray.setAttribute('d', 'M3 13h5l1 2h6l1-2h5')
  svg.append(box, tray)
  return svg
}

/* ------------------------------------------------------------------ */
/* 列表（F1）与详情（F3）                                              */
/* ------------------------------------------------------------------ */

function buildRow(item: HistoryItem, now: number): HTMLElement {
  const expanded = item.id !== undefined && item.id === expandedId
  const row = el('div', `history-row${expanded ? ' is-expanded' : ''}`)

  const head = el('button', 'history-row-head')
  head.type = 'button'
  head.appendChild(el('div', 'history-row-meta', formatHistoryMeta(item, now)))
  // F1 的行内只露原文的**第一段**：整页记录的原文可能很长，全铺出来列表就没法扫了
  head.appendChild(el('div', 'history-row-text', splitSegments(item.sourceText)[0] ?? ''))
  head.addEventListener('click', () => {
    expandedId = expanded ? null : (item.id ?? null)
    exportMenuOpen = false
    renderList()
  })
  row.appendChild(head)

  if (expanded) row.appendChild(buildDetail(item, now))
  return row
}

function buildDetail(item: HistoryItem, now: number): HTMLElement {
  const card = el('div', 'history-detail')

  const meta = el('div', 'history-detail-meta')
  meta.appendChild(
    el(
      'span',
      undefined,
      `${formatHistoryMeta(item, now)}　·　${formatCorpusSize(item)}`,
    ),
  )
  card.appendChild(meta)
  card.appendChild(el('div', 'history-detail-hairline'))

  card.appendChild(el('div', 'history-detail-label', '原文'))
  card.appendChild(el('div', 'history-detail-text', item.sourceText))

  card.appendChild(el('div', 'history-detail-label is-accent', `译文 · ${item.modelName}`))
  if (item.translatedText) {
    card.appendChild(el('div', 'history-detail-text is-translated', item.translatedText))
  } else {
    card.appendChild(
      el('div', 'history-detail-text is-error', `翻译失败：${item.error ?? '未知错误'}`),
    )
  }
  // 部分失败的记录：译文在，但有几段没回来 —— 单给一行说明，不塞进译文正文里
  if (item.translatedText && item.error) {
    card.appendChild(el('div', 'history-detail-note', item.error))
  }

  if (item.pageUrl) {
    card.appendChild(el('div', 'history-detail-url tr-mono', `来源　　${item.pageUrl}`))
  }

  card.appendChild(buildDetailActions(item))
  return card
}

function buildDetailActions(item: HistoryItem): HTMLElement {
  const row = el('div', 'history-detail-actions')

  const copy = el('button', 'history-action', '复制译文')
  copy.type = 'button'
  copy.disabled = !item.translatedText
  copy.addEventListener('click', () => {
    if (!item.translatedText) return
    void navigator.clipboard.writeText(item.translatedText).then(
      () => flash(copy, '已复制'),
      () => flash(copy, '复制失败'),
    )
  })
  row.appendChild(copy)

  const apply = el('button', 'history-action', '应用到页面')
  apply.type = 'button'
  apply.disabled = !item.translatedText || !item.pageUrl
  apply.addEventListener('click', () => {
    void applyToPage(item, apply)
  })
  row.appendChild(apply)

  const open = el('button', 'history-action', '打开来源')
  open.type = 'button'
  open.disabled = !item.pageUrl
  open.addEventListener('click', () => {
    if (item.pageUrl) void chrome.tabs.create({ url: item.pageUrl })
  })
  row.appendChild(open)

  const remove = el('button', 'history-action is-danger', '删除记录')
  remove.type = 'button'
  remove.addEventListener('click', () => {
    if (item.id === undefined) return
    void deleteRecord(item.id).then(async () => {
      expandedId = null
      await load()
      redraw()
    })
  })
  row.appendChild(remove)

  return row
}

/** 按钮上的一次性反馈（不引 Toast：这个页面没有注入 UI 的 Toast 通道） */
function flash(button: HTMLButtonElement, text: string): void {
  const original = button.textContent ?? ''
  button.textContent = text
  button.disabled = true
  setTimeout(() => {
    button.textContent = original
    button.disabled = false
  }, 1200)
}

async function applyToPage(item: HistoryItem, button: HTMLButtonElement): Promise<void> {
  if (!item.translatedText) return
  const response = await sendToBackground<{ ok: boolean; reason?: string }>({
    type: MSG.APPLY_HISTORY,
    pageUrl: item.pageUrl,
    sourceText: item.sourceText,
    translatedText: item.translatedText,
  })

  if (response.ok) {
    flash(button, '已发送')
    return
  }
  flash(button, response.reason === 'tab-not-open' ? '来源页未打开' : '来源页未就绪')
}

/** F2 空态（尚无记录） */
function buildEmpty(): HTMLElement {
  const wrap = el('div', 'history-empty')
  wrap.appendChild(svgIcon('empty'))
  wrap.appendChild(el('div', 'history-empty-title', '还没有翻译记录'))
  wrap.appendChild(
    el(
      'p',
      'history-empty-desc',
      '完成第一次翻译后，记录会自动出现在这里。\n记录只保存在本机，不会同步到任何服务器。',
    ),
  )
  return wrap
}

/** 有记录但被筛没了 —— 与 F2 的空态是两回事，文案必须不同，否则用户会以为数据丢了 */
function buildNoMatch(): HTMLElement {
  const wrap = el('div', 'history-empty')
  wrap.appendChild(el('div', 'history-empty-title', '没有符合条件的记录'))
  wrap.appendChild(
    el('p', 'history-empty-desc', '换个关键词，或把模型 / 类型 / 时间放宽到「全部」。'),
  )
  return wrap
}

function buildList(items: HistoryItem[]): HTMLElement {
  const now = Date.now()
  const list = el('div', 'history-list')
  for (const item of items) list.appendChild(buildRow(item, now))
  return list
}

/* ------------------------------------------------------------------ */
/* F5 导出菜单 / F4 清空模态                                            */
/* ------------------------------------------------------------------ */

function renderOverlays(): void {
  if (!overlayHost) return
  overlayHost.replaceChildren()

  if (exportMenuOpen) {
    const menu = el('div', 'history-export-menu')
    menu.appendChild(
      exportOption('导出为 JSON（含完整字段与时间戳）', () => {
        exportMenuOpen = false
        renderOverlays()
        download(
          exportFileName('json'),
          toJsonExport(filteredRecords()),
          'application/json;charset=utf-8',
        )
      }),
    )
    menu.appendChild(
      exportOption('导出为 Markdown（便于粘贴到笔记）', () => {
        exportMenuOpen = false
        renderOverlays()
        download(
          exportFileName('md'),
          toMarkdownExport(filteredRecords()),
          'text/markdown;charset=utf-8',
        )
      }),
    )
    overlayHost.appendChild(menu)
  }

  if (clearModalOpen) overlayHost.appendChild(buildClearModal())
}

function exportOption(label: string, onClick: () => void): HTMLElement {
  const button = el('button', 'history-export-option', label)
  button.type = 'button'
  button.addEventListener('click', onClick)
  return button
}

/** F4：遮罩 + 480 宽模态（文案照设计稿：先讲清「不可恢复」，再给「先导出」的退路） */
function buildClearModal(): HTMLElement {
  const overlay = el('div', 'history-overlay')
  overlay.addEventListener('click', () => {
    clearModalOpen = false
    renderOverlays()
  })

  const modal = el('div', 'history-modal')
  // 点模态内部不该把它关掉 —— 冒泡到遮罩会误触
  modal.addEventListener('click', (event) => event.stopPropagation())

  modal.appendChild(el('h4', 'history-modal-title', `清空全部 ${records.length} 条翻译记录？`))
  modal.appendChild(
    el(
      'p',
      'history-modal-desc',
      '记录仅保存在本机 IndexedDB 中，清空后无法恢复。若需要保留，请先导出为 JSON 或 Markdown。',
    ),
  )

  const warning = el('div', 'history-modal-warning')
  warning.appendChild(el('span', undefined, '此操作不可撤销'))
  modal.appendChild(warning)

  const actions = el('div', 'history-modal-actions')

  const confirm = el('button', 'tr-btn tr-btn--sm tr-btn--danger-solid', '确认清空')
  confirm.type = 'button'
  confirm.addEventListener('click', () => {
    void clearAll().then(async () => {
      clearModalOpen = false
      expandedId = null
      filter = defaultFilter()
      await load()
      // 清空后筛选值可能引用已不存在的模型名，整页重来最干净
      getContext().reload().catch(() => redraw())
    })
  })
  actions.appendChild(confirm)

  const cancel = el('button', 'tr-btn tr-btn--sm', '取消')
  cancel.type = 'button'
  cancel.addEventListener('click', () => {
    clearModalOpen = false
    renderOverlays()
  })
  actions.appendChild(cancel)

  modal.appendChild(actions)

  const host = el('div', 'history-modal-wrap')
  host.appendChild(modal)
  overlay.appendChild(host)
  return overlay
}

/* ------------------------------------------------------------------ */
/* 重绘                                                                */
/* ------------------------------------------------------------------ */

function filteredRecords(): HistoryItem[] {
  return filterRecords(records, filter)
}

/** 只重绘列表：工具栏里的搜索框必须活下来，否则打字即失焦 */
function renderList(): void {
  if (!listHost) return
  listHost.replaceChildren()

  const items = filteredRecords()
  if (records.length === 0) listHost.appendChild(buildEmpty())
  else if (items.length === 0) listHost.appendChild(buildNoMatch())
  else listHost.appendChild(buildList(items))

  updateHeader()
  renderOverlays()
}

function redraw(): void {
  // 记录变了 → chips 的选项（模型名 / 类型）要跟着变
  normalizeFilter()
  renderChips()
  renderList()
  syncSearchInput()
}

/**
 * 记录被删空之后，原来的筛选值可能已经没有对应选项了。
 * 归一化掉，否则会出现「chip 显示全部、列表却是空的」这种自相矛盾的画面。
 */
function normalizeFilter(): void {
  if (filter.modelName !== ALL && !modelNamesOf(records).includes(filter.modelName)) {
    filter = { ...filter, modelName: ALL }
  }
  if (filter.type !== ALL && !typesOf(records).includes(filter.type)) {
    filter = { ...filter, type: ALL }
  }
}

/** 清空 / 重置筛选后把搜索框同步回来（筛选态在模块级，DOM 只是它的投影） */
function syncSearchInput(): void {
  const input = document.querySelector<HTMLInputElement>('.history-search-input')
  if (input && input.value !== filter.keyword) input.value = filter.keyword
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export function renderHistory(ctx: SectionContext): HTMLElement {
  headerCtx = ctx

  const container = el('div', 'section section--history')

  // 工具栏只建一次（见文件头第 1 点）
  container.appendChild(buildToolbar())

  listHost = el('div', 'history-list-host')
  container.appendChild(listHost)

  overlayHost = el('div', 'history-overlay-host')
  container.appendChild(overlayHost)

  if (loaded) {
    redraw()
  } else {
    ctx.setHeaderDesc('正在读取本机记录…')
    renderList()
    void load().then(() => redraw())
  }

  // 切回本页时重新读一次：用户可能在别的标签页刚翻完页
  // （筛选态在模块级，所以这次重读不会把用户的条件冲掉）
  if (!visibilityHooked) {
    visibilityHooked = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      if (!listHost?.isConnected) return
      void load().then(() => redraw())
    })
  }

  return container
}
