/**
 * G11 侧边栏 Slide（本页对照 · 划词记录 · 多模型对比）
 *
 * 形态：**内容脚本自绘 DOM + 固定定位**，不使用 chrome.sidePanel（docs/00 §A3②）。
 * 归属：跟着当前页面走，不跨页常驻。X2：默认不打开，需手动唤起。
 *
 * 结构照 G11：
 *   顶栏 =「T」章 + 侧边栏 + 设置图标 + 关闭
 *   Tab 行 = 药丸式「本页对照 / 划词记录 N / 多模型对比」（划词记录带计数）
 *   本页对照 = 翻译进度（4px 进度条）+ 三态切换 + **本页对照大纲**
 *   底部 = 只保留「恢复原文」这一页级动作（G11 本身无底栏，见文件末注释）
 *
 * 数据来源全部是 `state`：`entries` 是本页已注入的块，按 Map 插入序 = 文档出现序，
 * 因此可以直接当成大纲来读；层级由块自身的标签名（h1–h6）推断。
 */

import { COMPARE_STATUS_LABEL, formatColumnMeta, type CompareColumnStatus } from '@/shared/compare'
import { MAX_COMPARE_MODELS, MIN_COMPARE_MODELS, Z, sidebarWidthFor } from '@/shared/constants'
import { providerOf } from '@/shared/providers'
import type { DisplayMode } from '@/shared/types'
import {
  applyCompareColumn,
  cancelCompareRun,
  closeSidebar,
  openApp,
  resetCompare,
  restorePage,
  retryCompareColumn,
  revealEntry,
  setDisplayMode,
  setSidebarTab,
  startCompare,
  toggleCompareModel,
  toggleTranslatePage,
} from '../actions'
import { focusSourceBlock } from '../injector'
import {
  compareColumnOf,
  state,
  type CompareColumn,
  type PageEntry,
  type SelectionRecord,
  type SidebarTab,
} from '../state'
import { ICONS } from './icons'

const TABS: Array<{ key: SidebarTab; label: string }> = [
  { key: 'page', label: '本页对照' },
  { key: 'records', label: '划词记录' },
  { key: 'compare', label: '多模型对比' },
]

const MODES: Array<{ key: DisplayMode; label: string }> = [
  { key: 'original-only', label: '原文' },
  { key: 'translation-only', label: '译文' },
  { key: 'bilingual', label: '对照' },
]

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function div(className: string, text?: string): HTMLElement {
  const node = document.createElement('div')
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function iconButton(className: string, label: string, svg: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.title = label
  button.setAttribute('aria-label', label)
  button.innerHTML = svg
  button.addEventListener('click', onClick)
  return button
}

/**
 * 大纲层级：h1/h2 → 0，h3 → 1，h4–h6 → 2。
 * 非标题块（p / li / td…）归到 1 —— 它们是大纲里的正文条目，视觉上比标题轻一档。
 */
function outlineLevel(entry: PageEntry): 0 | 1 | 2 {
  const tag = entry.el.tagName.toLowerCase()
  if (tag === 'h1' || tag === 'h2') return 0
  if (tag === 'h3') return 1
  if (tag === 'h4' || tag === 'h5' || tag === 'h6') return 2
  return 1
}

/** 大纲条目文案：标题优先，空则退回首段文字 */
function outlineText(entry: PageEntry): string {
  const raw = entry.sourceText.trim()
  return raw.length > 0 ? raw : '（空块）'
}

/* ------------------------------------------------------------------ */
/* 本页对照：进度 / 三态 / 大纲                                          */
/* ------------------------------------------------------------------ */

function buildProgress(): HTMLElement {
  const block = div('transora-sb-progress-block')

  const row = div('transora-sb-progress-row')
  row.appendChild(div('transora-sb-progress-label', '翻译进度'))
  const { done, total } = state.progress
  row.appendChild(div('transora-sb-progress-count', `${done} / ${total} 段`))
  block.appendChild(row)

  const bar = document.createElement('span')
  bar.className = 'transora-sb-bar'
  const fill = document.createElement('i')
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  fill.style.width = `${percent}%`
  bar.appendChild(fill)
  block.appendChild(bar)

  return block
}

function buildModes(): HTMLElement {
  const wrap = div('transora-sb-modes')
  for (const mode of MODES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'transora-sb-mode'
    button.textContent = mode.label
    if (state.settings.displayMode === mode.key) button.classList.add('is-active')
    button.addEventListener('click', () => {
      void setDisplayMode(mode.key)
    })
    wrap.appendChild(button)
  }
  return wrap
}

function buildOutline(): HTMLElement {
  const wrap = div('transora-sb-outline')
  wrap.appendChild(div('transora-sb-outline-label', '本页对照大纲'))

  state.entries.forEach((entry) => {
    const level = outlineLevel(entry)
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `transora-sb-out-item transora-sb-out-item--${level}`
    if (level > 0) item.classList.add('transora-sb-out-item--indent')

    const text = document.createElement('span')
    text.className = 'transora-sb-out-text'
    text.textContent = outlineText(entry)
    text.title = outlineText(entry)
    item.appendChild(text)

    const status = document.createElement('span')
    status.className = 'transora-sb-out-status'
    if (entry.error) {
      status.classList.add('transora-sb-out-status--error')
      status.textContent = '失败'
    } else if (entry.translatedText) {
      status.textContent = '已译'
    } else {
      status.classList.add('transora-sb-out-status--busy')
      status.textContent = '进行中'
    }
    item.appendChild(status)

    item.addEventListener('click', () => revealEntry(entry))
    wrap.appendChild(item)
  })

  return wrap
}

/* ------------------------------------------------------------------ */
/* 其余两个 Tab                                                        */
/* ------------------------------------------------------------------ */

function buildRecordRow(record: SelectionRecord): HTMLElement {
  const row = div('transora-sb-record')
  row.appendChild(div('transora-sb-record-source', record.sourceText))

  const translated = div('transora-sb-record-translated')
  if (record.error) {
    translated.classList.add('transora-sb-record-translated--error')
    translated.textContent = record.error
  } else {
    translated.textContent = record.translatedText
  }
  row.appendChild(translated)

  row.appendChild(
    div('transora-sb-record-meta', `${record.modelName} · ${new Date(record.timestamp).toLocaleTimeString()}`),
  )
  return row
}

/* ------------------------------------------------------------------ */
/* G6 多模型对比（骨架：顶部模型应用条 + 逐块卡片）                       */
/*                                                                     */
/* 骨架口径（2026-09-17 用户裁决，方案 C）：                              */
/*   - 上层「模型条」= docs/00 §A2 所说的「列头」：名称 / 供应商 / 状态 /   */
/*     耗时·token / 应用。应用是**模型级、整页映射**（§D-3）。              */
/*   - 下层「逐块卡片」= 设计稿 G6 的画法：原文 + N 列译文 + 各自元信息。     */
/*     逐块渲染才有跨列对齐 —— 若按「每列一整页」渲染，行高不一致会错位。     */
/* ------------------------------------------------------------------ */

/** 一次最多渲染多少块卡片：超长页面下防止每次 emit 重建上万个节点 */
const COMPARE_MAX_CARDS = 120

/** 一个模型在一个块上的格子（译文 / 失败 / 骨架三态） */
function buildCompareCell(column: CompareColumn, index: number): HTMLElement {
  const cell = div('transora-cmp-col')
  if (state.compare.appliedModelId === column.modelId) cell.classList.add('is-applied')
  if (column.status === 'failed' || column.status === 'partial') cell.classList.add('is-failed')

  cell.appendChild(div('transora-cmp-col-name', column.modelName))

  const text = column.translations[index]
  const error = column.errors[index]

  if (text) {
    cell.appendChild(div('transora-cmp-col-text', text))
  } else if (error) {
    cell.appendChild(div('transora-cmp-col-text transora-cmp-col-text--error', error.message))
  } else {
    const skeleton = div('transora-cmp-skeleton')
    for (const width of ['100%', '72%']) {
      const bar = document.createElement('i')
      bar.style.width = width
      skeleton.appendChild(bar)
    }
    cell.appendChild(skeleton)
  }

  return cell
}

/** 模型条的一项 = G6 的「列头」（§A2：列头可「应用该模型译文到页面」） */
function buildCompareBarItem(column: CompareColumn): HTMLElement {
  const item = div('transora-cmp-bar-item')
  const applied = state.compare.appliedModelId === column.modelId
  if (applied) item.classList.add('is-applied')
  if (column.status === 'failed' || column.status === 'partial') item.classList.add('is-failed')

  item.appendChild(div('transora-cmp-bar-name', column.modelName))
  item.appendChild(div('transora-cmp-bar-provider', column.provider))

  const running = state.compare.status === 'running' && column.status !== 'done'
  const stateText = running
    ? `${COMPARE_STATUS_LABEL[column.status as CompareColumnStatus]} ${column.done} / ${column.translations.length}`
    : COMPARE_STATUS_LABEL[column.status]
  item.appendChild(div('transora-cmp-bar-state', stateText))

  item.appendChild(
    div(
      'transora-cmp-bar-meta',
      formatColumnMeta(column.latencyMs, column.totalTokens, column.cacheHits),
    ),
  )

  const actions = div('transora-cmp-bar-actions')

  const apply = document.createElement('button')
  apply.type = 'button'
  apply.className = 'transora-cmp-apply'
  // 一个块都没成功时不给「应用」——点了也只会得到一句「没有可应用的译文」
  apply.disabled = applied || column.done - column.failed === 0
  apply.textContent = applied ? '已应用' : '应用'
  apply.title = '把这一列的译文应用到页面（换显，不重新请求）'
  apply.addEventListener('click', () => {
    void applyCompareColumn(column.modelId)
  })
  actions.appendChild(apply)

  if (column.status === 'partial' || column.status === 'failed') {
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'transora-cmp-retry'
    retry.textContent = '重试'
    retry.title = '只重跑这一列失败的段落'
    retry.addEventListener('click', () => {
      void retryCompareColumn(column.modelId)
    })
    actions.appendChild(retry)
  }

  item.appendChild(actions)
  return item
}

/** 勾选态（I4 场景 C 步骤 02：「在侧边栏「多模型对比」Tab 勾选 2–3 个模型」） */
function buildComparePicker(): HTMLElement {
  const wrap = div('transora-cmp')

  const head = div('transora-cmp-head')
  head.appendChild(div('transora-cmp-head-title', '选择要对比的模型'))
  head.appendChild(
    div(
      'transora-cmp-head-desc',
      `勾选 ${MIN_COMPARE_MODELS}–${MAX_COMPARE_MODELS} 个模型，各自翻译本页后逐块并排查看；选中任意一列可应用到页面。`,
    ),
  )
  wrap.appendChild(head)

  const list = div('transora-cmp-pick-list')
  for (const model of state.models) {
    const on = state.compare.selectedIds.includes(model.id)
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'transora-cmp-pick-row'
    if (on) row.classList.add('is-on')

    const box = document.createElement('span')
    box.className = 'transora-cmp-pick-box'
    if (on) box.innerHTML = ICONS.check
    row.appendChild(box)

    const names = div('transora-cmp-pick-names')
    names.appendChild(div('transora-cmp-pick-name', model.name))
    names.appendChild(div('transora-cmp-pick-sub', `${providerOf(model).label} · ${model.model}`))
    row.appendChild(names)

    row.addEventListener('click', () => toggleCompareModel(model.id))
    list.appendChild(row)
  }
  wrap.appendChild(list)

  const selected = state.compare.selectedIds.length
  const foot = div('transora-cmp-pick-foot')
  foot.appendChild(div('transora-cmp-pick-count', `已选 ${selected} / ${MAX_COMPARE_MODELS}`))

  const primary = document.createElement('button')
  primary.type = 'button'
  primary.className = 'transora-cmp-primary'
  primary.textContent = '开始对比'
  primary.disabled = selected < MIN_COMPARE_MODELS
  primary.addEventListener('click', () => {
    void startCompare()
  })
  foot.appendChild(primary)
  wrap.appendChild(foot)

  if (selected < MIN_COMPARE_MODELS) {
    wrap.appendChild(div('transora-cmp-hint', `至少勾选 ${MIN_COMPARE_MODELS} 个模型才能开始对比`))
  }

  return wrap
}

function buildCompare(): HTMLElement {
  // 少于 2 个可用模型时连勾选都没有意义 —— 直接给去配置的出口
  if (state.models.length < MIN_COMPARE_MODELS) {
    return buildEmpty(
      `多模型对比需要至少 ${MIN_COMPARE_MODELS} 个已启用的模型。Transora 不内置模型，先在「模型配置」里接入两个 OpenAI 兼容服务。`,
      '去配置模型',
      () => openApp('models'),
    )
  }

  if (state.compare.columns.length === 0) return buildComparePicker()

  const wrap = div('transora-cmp')

  const bar = div('transora-cmp-bar')
  state.compare.columns.forEach((column) => bar.appendChild(buildCompareBarItem(column)))
  wrap.appendChild(bar)

  const applied = state.compare.appliedModelId
    ? compareColumnOf(state.compare.appliedModelId)
    : null
  if (applied) {
    wrap.appendChild(div('transora-cmp-applied', `页面当前显示：「${applied.modelName}」的译文`))
  }

  const cards = div('transora-cmp-cards')
  const total = state.compare.blocks.length
  const limit = Math.min(total, COMPARE_MAX_CARDS)

  for (let index = 0; index < limit; index += 1) {
    const block = state.compare.blocks[index]
    const card = div('transora-cmp-card')

    const head = div('transora-cmp-card-head')
    const source = div('transora-cmp-card-src', block.text)
    source.title = block.text
    head.appendChild(source)

    const locate = document.createElement('button')
    locate.type = 'button'
    locate.className = 'transora-cmp-card-locate'
    locate.textContent = '定位'
    locate.title = '滚动到页面上的这一块'
    locate.addEventListener('click', () => focusSourceBlock(block.el))
    head.appendChild(locate)
    card.appendChild(head)

    const cols = div('transora-cmp-cols')
    state.compare.columns.forEach((column) => cols.appendChild(buildCompareCell(column, index)))
    card.appendChild(cols)

    cards.appendChild(card)
  }
  wrap.appendChild(cards)

  if (total > limit) {
    wrap.appendChild(
      div('transora-cmp-hint', `仅渲染前 ${limit} 块（共 ${total} 块）；「应用」仍会作用于全部块。`),
    )
  }

  return wrap
}

function buildEmpty(text: string, actionLabel?: string, onAction?: () => void): HTMLElement {
  const wrap = div('transora-sb-empty')
  wrap.appendChild(div('', text))

  if (actionLabel && onAction) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'transora-sb-empty-btn'
    button.textContent = actionLabel
    button.addEventListener('click', onAction)
    wrap.appendChild(button)
  }
  return wrap
}

function buildBody(): HTMLElement {
  const body = div('transora-sb-body')

  if (state.sidebarTab === 'page') {
    body.appendChild(buildProgress())
    body.appendChild(buildModes())

    if (state.entries.size === 0) {
      body.appendChild(
        buildEmpty('本页还没有对照内容。点击「翻译当前页面」开始。', '翻译当前页面', () =>
          toggleTranslatePage(),
        ),
      )
    } else {
      body.appendChild(buildOutline())
    }
    return body
  }

  if (state.sidebarTab === 'records') {
    if (state.selectionRecords.length === 0) {
      body.appendChild(buildEmpty('本页还没有划词记录。选中文字后悬停跟随图标即可翻译。'))
    } else {
      state.selectionRecords.forEach((record) => body.appendChild(buildRecordRow(record)))
    }
    return body
  }

  body.appendChild(buildCompare())
  return body
}

/**
 * 底栏：G11 的侧边栏**没有底栏**（三态切换移进「本页对照」正文，见 buildModes）。
 * 但「恢复原文」是页级动作、设计稿把它放在 G7 顶栏；侧边栏不带顶栏时它是唯一出口，
 * 故保留一个极简底栏，且只在有译文块时渲染（`.transora-sb-foot:empty` 会被隐藏）。
 */
function buildFoot(): HTMLElement {
  const foot = div('transora-sb-foot')

  const addButton = (label: string, onClick: () => void): void => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'transora-sb-foot-btn'
    button.textContent = label
    button.addEventListener('click', onClick)
    foot.appendChild(button)
  }

  if (state.sidebarTab === 'compare') {
    // 勾选态没有页级动作，底栏留空（`.transora-sb-foot:empty` 自动隐藏）
    if (state.compare.columns.length === 0) return foot

    if (state.compare.status === 'running') {
      addButton('取消对比', () => cancelCompareRun())
    } else {
      addButton('重新对比', () => {
        void startCompare()
      })
      addButton('换一批模型', () => resetCompare())
    }
    return foot
  }

  if (state.sidebarTab === 'page' && state.entries.size > 0) {
    addButton('恢复原文', () => restorePage())
  }

  return foot
}

/* ------------------------------------------------------------------ */
/* 挂载                                                                */
/* ------------------------------------------------------------------ */

export interface SidebarController {
  render: () => void
}

export function mountSidebar(root: HTMLElement): SidebarController {
  const container = document.createElement('aside')
  container.className = 'transora-sidebar'
  container.setAttribute('data-transora', 'sidebar')
  container.style.zIndex = String(Z.sidebar)
  root.appendChild(container)

  const render = (): void => {
    // 宽度**按 Tab 动态**（对比 Tab 需要 728px 才放得下三列，见 constants.sidebarWidthFor），
    // 同时暴露给 CSS：划词跟随图标要按它避让，宽度一变就得跟着变
    const width = sidebarWidthFor(state.sidebarTab)
    container.style.width = `${width}px`
    document.documentElement.style.setProperty('--transora-sidebar-w', `${width}px`)

    container.classList.toggle('transora-sidebar--open', state.sidebarOpen)

    // ---- 顶栏（G11） ----
    const header = document.createElement('header')
    header.className = 'transora-sb-header'

    const mark = div('transora-sb-mark', 'T')
    mark.setAttribute('aria-hidden', 'true')
    header.appendChild(mark)

    header.appendChild(div('transora-sb-title', '侧边栏'))

    header.appendChild(
      iconButton('transora-sb-settings', '模型配置 / 通用设置', ICONS.settings, () => openApp('models')),
    )
    header.appendChild(iconButton('transora-sb-close', '关闭侧边栏', ICONS.close, () => closeSidebar()))

    // ---- Tab 行（G11：药丸 + 计数） ----
    const tabs = document.createElement('nav')
    tabs.className = 'transora-sb-tabs'
    for (const tab of TABS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'transora-sb-tab'
      button.textContent = tab.label
      if (tab.key === 'records' && state.selectionRecords.length > 0) {
        const count = document.createElement('span')
        count.className = 'transora-sb-tab-count'
        count.textContent = String(state.selectionRecords.length)
        button.appendChild(count)
      }
      if (state.sidebarTab === tab.key) button.classList.add('is-active')
      button.addEventListener('click', () => setSidebarTab(tab.key))
      tabs.appendChild(button)
    }

    container.replaceChildren(header, tabs, buildBody(), buildFoot())
  }

  render()

  return { render }
}
