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

import { SIDEBAR_WIDTH, Z } from '@/shared/constants'
import type { DisplayMode } from '@/shared/types'
import {
  closeSidebar,
  openApp,
  openSidebar,
  restorePage,
  revealEntry,
  setDisplayMode,
  setSidebarTab,
  toggleTranslatePage,
} from '../actions'
import { state, type PageEntry, type SelectionRecord, type SidebarTab } from '../state'
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

function buildComparePlaceholder(): HTMLElement {
  const wrap = div('transora-sb-compare')
  wrap.appendChild(div('transora-sb-compare-title', '多模型对比'))

  const desc = div('transora-sb-compare-desc')
  desc.textContent = '同一页内容交由多个模型分别翻译，在此并排查看，选中任意一列即可应用到页面。'
  wrap.appendChild(desc)

  const list = document.createElement('ul')
  list.className = 'transora-sb-compare-list'
  for (const line of ['最多同时对比 3 个模型', '各列独立加载 / 失败，互不影响', '「应用」只换显，不重新请求']) {
    const li = document.createElement('li')
    li.textContent = line
    list.appendChild(li)
  }
  wrap.appendChild(list)

  wrap.appendChild(div('transora-sb-compare-pill', '阶段 2 开放'))
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

  body.appendChild(buildComparePlaceholder())
  return body
}

/**
 * 底栏：G11 的侧边栏**没有底栏**（三态切换移进「本页对照」正文，见 buildModes）。
 * 但「恢复原文」是页级动作、设计稿把它放在 G7 顶栏；侧边栏不带顶栏时它是唯一出口，
 * 故保留一个极简底栏，且只在有译文块时渲染（`.transora-sb-foot:empty` 会被隐藏）。
 */
function buildFoot(): HTMLElement {
  const foot = div('transora-sb-foot')

  if (state.sidebarTab === 'compare') {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'transora-sb-foot-btn'
    button.textContent = '了解多模型对比'
    button.addEventListener('click', () => openApp('models'))
    foot.appendChild(button)
    return foot
  }

  if (state.sidebarTab === 'page' && state.entries.size > 0) {
    const restore = document.createElement('button')
    restore.type = 'button'
    restore.className = 'transora-sb-foot-btn'
    restore.textContent = '恢复原文'
    restore.addEventListener('click', () => restorePage())
    foot.appendChild(restore)
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
  container.style.width = `${SIDEBAR_WIDTH}px`
  container.style.zIndex = String(Z.sidebar)
  // 侧边栏宽度以常量为准，同时暴露给 CSS（划词图标要按它避让）
  document.documentElement.style.setProperty('--transora-sidebar-w', `${SIDEBAR_WIDTH}px`)
  root.appendChild(container)

  const render = (): void => {
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
