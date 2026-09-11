/**
 * G11 侧边栏 Slide（阶段 1 交付「骨架 + 本页对照」）
 *
 * 形态：**内容脚本自绘 DOM + 固定定位**，不使用 chrome.sidePanel（docs/00 §A3②）。
 * 归属：跟着当前页面走，不跨页常驻（符合 docs/07 归属判据）。
 * X2：默认不打开，需手动唤起。
 *
 * 三 Tab：
 *  - 本页对照：阶段 1 可用
 *  - 划词记录：只在当前页内（全局历史走新标签页，X4）
 *  - 多模型对比：阶段 2 开放（S4/S5：最多 3 个模型、多列并排）
 */

import { SIDEBAR_WIDTH, Z } from '@/shared/constants'
import type { DisplayMode } from '@/shared/types'
import {
  closeSidebar,
  openApp,
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
  { key: 'original-only', label: '仅原文' },
  { key: 'bilingual', label: '双语对照' },
  { key: 'translation-only', label: '仅译文' },
]

function buildEntryRow(entry: PageEntry, index: number): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'transora-sb-entry'

  const head = document.createElement('div')
  head.className = 'transora-sb-entry-head'

  const indexTag = document.createElement('span')
  indexTag.className = 'transora-sb-entry-index'
  indexTag.textContent = String(index + 1)
  head.appendChild(indexTag)

  const source = document.createElement('div')
  source.className = 'transora-sb-entry-source'
  source.textContent = entry.sourceText
  head.appendChild(source)

  row.appendChild(head)

  const translated = document.createElement('div')
  translated.className = 'transora-sb-entry-translated'
  if (entry.error) {
    translated.classList.add('transora-sb-entry-translated--error')
    translated.textContent = entry.error.message
  } else if (entry.translatedText) {
    translated.textContent = entry.translatedText
  } else {
    translated.textContent = '翻译中…'
    translated.classList.add('transora-sb-entry-translated--muted')
  }
  row.appendChild(translated)

  row.addEventListener('click', () => revealEntry(entry))
  return row
}

function buildRecordRow(record: SelectionRecord): HTMLElement {
  const row = document.createElement('div')
  row.className = 'transora-sb-record'

  const source = document.createElement('div')
  source.className = 'transora-sb-entry-source'
  source.textContent = record.sourceText
  row.appendChild(source)

  const translated = document.createElement('div')
  translated.className = 'transora-sb-entry-translated'
  if (record.error) {
    translated.classList.add('transora-sb-entry-translated--error')
    translated.textContent = record.error
  } else {
    translated.textContent = record.translatedText
  }
  row.appendChild(translated)

  const meta = document.createElement('div')
  meta.className = 'transora-sb-record-meta'
  meta.textContent = `${record.modelName} · ${new Date(record.timestamp).toLocaleTimeString()}`
  row.appendChild(meta)

  return row
}

function buildComparePlaceholder(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'transora-sb-compare'

  const title = document.createElement('div')
  title.className = 'transora-sb-compare-title'
  title.textContent = '多模型对比'
  wrap.appendChild(title)

  const desc = document.createElement('div')
  desc.className = 'transora-sb-compare-desc'
  desc.textContent = '同一页内容交由多个模型分别翻译，在此并排查看，选中任意一列即可应用到页面。'
  wrap.appendChild(desc)

  const list = document.createElement('ul')
  list.className = 'transora-sb-compare-list'
  for (const line of [
    '最多同时对比 3 个模型',
    '各列独立加载 / 失败，互不影响',
    '「应用」只换显，不重新请求',
  ]) {
    const li = document.createElement('li')
    li.textContent = line
    list.appendChild(li)
  }
  wrap.appendChild(list)

  const pill = document.createElement('span')
  pill.className = 'transora-sb-compare-pill'
  pill.textContent = '阶段 2 开放'
  wrap.appendChild(pill)

  return wrap
}

function buildEmpty(text: string, actionLabel?: string, onAction?: () => void): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'transora-sb-empty'

  const label = document.createElement('div')
  label.textContent = text
  wrap.appendChild(label)

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
  const body = document.createElement('div')
  body.className = 'transora-sb-body'

  if (state.sidebarTab === 'page') {
    const entries = [...state.entries.values()]
    if (entries.length === 0) {
      body.appendChild(
        buildEmpty('本页还没有对照内容。点击「翻译本页」开始。', '翻译本页', () =>
          toggleTranslatePage(),
        ),
      )
    } else {
      entries.forEach((entry, index) => body.appendChild(buildEntryRow(entry, index)))
    }
    return body
  }

  if (state.sidebarTab === 'records') {
    if (state.selectionRecords.length === 0) {
      body.appendChild(buildEmpty('本页还没有划词记录。选中文字后点击跟随图标即可翻译。'))
    } else {
      state.selectionRecords.forEach((record) => body.appendChild(buildRecordRow(record)))
    }
    return body
  }

  body.appendChild(buildComparePlaceholder())
  return body
}

function buildFoot(): HTMLElement {
  const foot = document.createElement('div')
  foot.className = 'transora-sb-foot'

  if (state.sidebarTab === 'compare') {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'transora-sb-foot-btn'
    button.textContent = '了解多模型对比'
    button.addEventListener('click', () => openApp('models'))
    foot.appendChild(button)
    return foot
  }

  const segmented = document.createElement('div')
  segmented.className = 'transora-sb-segmented'

  for (const mode of MODES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'transora-sb-segment'
    button.textContent = mode.label
    if (state.settings.displayMode === mode.key) button.classList.add('is-active')
    button.addEventListener('click', () => {
      void setDisplayMode(mode.key)
    })
    segmented.appendChild(button)
  }

  foot.appendChild(segmented)

  if (state.entries.size > 0) {
    const restore = document.createElement('button')
    restore.type = 'button'
    restore.className = 'transora-sb-foot-btn'
    restore.textContent = '恢复原文'
    restore.addEventListener('click', () => restorePage())
    foot.appendChild(restore)
  }

  return foot
}

export interface SidebarController {
  render: () => void
}

export function mountSidebar(root: HTMLElement): SidebarController {
  const container = document.createElement('aside')
  container.className = 'transora-sidebar'
  container.setAttribute('data-transora', 'sidebar')
  container.style.width = `${SIDEBAR_WIDTH}px`
  container.style.zIndex = String(Z.sidebar)
  // 侧边栏宽度以常量为准，同时暴露给 CSS（悬浮按钮要按它让位）
  document.documentElement.style.setProperty('--transora-sidebar-w', `${SIDEBAR_WIDTH}px`)
  root.appendChild(container)

  const render = (): void => {
    container.classList.toggle('transora-sidebar--open', state.sidebarOpen)

    const header = document.createElement('header')
    header.className = 'transora-sb-header'

    const title = document.createElement('div')
    title.className = 'transora-sb-title'
    title.textContent = 'Transora'
    header.appendChild(title)

    if (state.status === 'translating') {
      const progress = document.createElement('span')
      progress.className = 'transora-sb-progress'
      progress.textContent = `${state.progress.done} / ${state.progress.total}`
      header.appendChild(progress)
    }

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'transora-sb-close'
    close.title = '关闭侧边栏'
    close.innerHTML = ICONS.close
    close.addEventListener('click', () => closeSidebar())
    header.appendChild(close)

    const tabs = document.createElement('nav')
    tabs.className = 'transora-sb-tabs'
    for (const tab of TABS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'transora-sb-tab'
      button.textContent = tab.label
      if (state.sidebarTab === tab.key) button.classList.add('is-active')
      button.addEventListener('click', () => setSidebarTab(tab.key))
      tabs.appendChild(button)
    }

    container.replaceChildren(header, tabs, buildBody(), buildFoot())
  }

  render()

  return { render }
}
