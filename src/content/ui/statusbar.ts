/**
 * G7 页面顶部状态栏（Sticky）
 *
 * 设计稿原文：「滚动时吸顶；左侧为当前页面与进度，右侧为三态切换、目标语言与退出入口。」
 *
 * 落地取舍（两处明确偏离视觉稿，都是有意的）：
 *  1. 用 `position: fixed` 而不是 `position: sticky`。注入 UI 的统一约束是「不参与宿主页布局」
 *     （docs/00 §G-3），sticky 需要插进宿主页的流里，会把别人的首屏挤下去，且父级 overflow 一改就失效。
 *  2. 形态取设计稿那张 56 高的圆角卡片（圆角 10 / 发丝线 / 卡片底），左右沿用 FAB 的 18px 安全边。
 *
 * 出现条件：页面上存在译文块（翻译中 / 已翻译）。idle 时不占视口，不打扰阅读。
 */

import { CLS, STATUS_BAR, Z } from '@/shared/constants'
import { TARGET_LANGS } from '@/shared/langs'
import type { DisplayMode } from '@/shared/types'
import { restorePage, setDisplayMode, setTargetLang } from '../actions'
import { state } from '../state'
import { ICONS } from './icons'

/** 设计稿 G7 药丸行：原文 / 译文 / 对照（左→右） */
const MODES: ReadonlyArray<{ key: DisplayMode; label: string }> = [
  { key: 'original-only', label: '原文' },
  { key: 'translation-only', label: '译文' },
  { key: 'bilingual', label: '对照' },
]

export interface StatusBarController {
  render: () => void
}

function div(className: string, text?: string): HTMLElement {
  const node = document.createElement('div')
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function span(className: string, text?: string): HTMLElement {
  const node = document.createElement('span')
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** 状态栏左侧的区域标识：域名 + 路径（设计稿示例 `arxiv.org/abs/1706.03762`） */
function locationLabel(): string {
  const { host, pathname } = window.location
  if (!host) return ''
  const path = pathname === '/' ? '' : pathname
  return `${host}${path}`
}

function buildLeft(): HTMLElement {
  const left = div('transora-st-left')
  left.appendChild(span(CLS.stMark, '译'))
  left.appendChild(span(CLS.stTitle, '双语对照已开启'))
  const host = span(CLS.stHost, locationLabel())
  host.title = location.href
  left.appendChild(host)
  return left
}

function buildProgress(): HTMLElement {
  const wrap = span(`${CLS.stBar}-wrap`)
  const bar = span(CLS.stBar)
  const fill = span(`${CLS.stBar}-fill`)
  const { done, total } = state.progress
  const ratio = total > 0 ? Math.min(1, done / total) : 1
  fill.style.width = `${Math.round(ratio * 100)}%`
  bar.appendChild(fill)
  wrap.appendChild(bar)
  return wrap
}

function buildModes(): HTMLElement {
  const wrap = span(CLS.stModes)
  for (const mode of MODES) {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = CLS.stMode
    node.textContent = mode.label
    if (state.settings.displayMode === mode.key) node.classList.add('is-active')
    node.title = '切换 对照 / 译文 / 原文（Alt+Shift+M）'
    node.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void setDisplayMode(mode.key)
    })
    wrap.appendChild(node)
  }
  return wrap
}

function buildLangSelect(): HTMLElement {
  const select = document.createElement('select')
  select.className = CLS.stLang
  select.title = '目标语言'
  for (const lang of TARGET_LANGS) {
    const option = document.createElement('option')
    option.value = lang.value
    option.textContent = lang.label
    if (lang.value === state.settings.targetLang) option.selected = true
    select.appendChild(option)
  }
  select.addEventListener('change', (event) => {
    event.stopPropagation()
    void setTargetLang(select.value)
  })
  return select
}

function buildRight(): HTMLElement {
  const right = div('transora-st-right')

  const { done, total } = state.progress
  right.appendChild(span(CLS.stCount, `${done} / ${total} 段`))
  right.appendChild(buildProgress())
  right.appendChild(buildModes())
  right.appendChild(buildLangSelect())

  const exit = document.createElement('button')
  exit.type = 'button'
  exit.className = CLS.stExit
  exit.innerHTML = ICONS.close
  exit.title = '退出对照，恢复原文'
  exit.setAttribute('aria-label', '退出对照')
  exit.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    restorePage()
  })
  right.appendChild(exit)

  return right
}

export function mountStatusBar(root: HTMLElement): StatusBarController {
  const container = document.createElement('div')
  container.className = CLS.st
  container.setAttribute('data-transora', 'statusbar')
  container.style.zIndex = String(Z.statusbar)
  container.style.setProperty('--transora-st-h', `${STATUS_BAR.height}px`)

  root.appendChild(container)

  const render = (): void => {
    // 只在页面上真的有译文时才出现（翻译中 / 已翻译）
    const visible = state.entries.size > 0
    container.classList.toggle(`${CLS.st}--hidden`, !visible)
    if (!visible) {
      container.replaceChildren()
      return
    }

    const inner = div('transora-st-inner')
    inner.append(buildLeft(), buildRight())
    container.replaceChildren(inner)
  }

  render()

  return { render }
}
