/**
 * G4 划词跟随图标 + 触发逻辑（FR-03）
 *
 * 交互定义（S7 / D7）：选中文字 → 选区**右下方**出现跟随图标 → 点击弹出划词内容块。
 * 遮挡避让：右下方放不下时自动上移到选区上方。
 * 次要入口：右键菜单与快捷键（H1），最终都调用 `showSelectionCardForText`。
 */

import { SIDEBAR_WIDTH, Z } from '@/shared/constants'
import { isOwnNode } from '@/shared/utils'
import { toggleFabMenu } from './actions'
import { state } from './state'
import { registerSelectionShower } from './actions'
import { mountSelectionCard, type SelectionCardController } from './ui/selection-card'
import { ICONS } from './ui/icons'

const ICON_SIZE = 28
const OFFSET = 6
const GAP = 8

export interface SelectionController {
  render: () => void
  hideAll: () => void
}

interface SelectionInfo {
  text: string
  rect: DOMRect
}

let card: SelectionCardController | null = null
let iconButton: HTMLButtonElement | null = null
let anchorRect: DOMRect | null = null
let pendingText = ''

function readSelection(): SelectionInfo | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const text = selection.toString().replace(/\s+/g, ' ').trim()
  if (!text) return null

  const range = selection.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  if (!rect || (rect.width === 0 && rect.height === 0)) return null

  // 选区落在输入框 / 我们自己的 UI 内时不打扰
  const container = range.startContainer
  const element =
    container.nodeType === Node.ELEMENT_NODE
      ? (container as Element)
      : container.parentElement
  if (element?.closest('input, textarea, [contenteditable="true"]')) return null
  if (isOwnNode(element)) return null

  return { text, rect }
}

function positionIcon(rect: DOMRect, icon: HTMLElement): void {
  // 侧边栏打开时把可用宽度让出去，避免图标落在侧边栏底下（看得见点不动）
  const reserved = state.sidebarOpen ? SIDEBAR_WIDTH : 0
  const available = Math.max(160, window.innerWidth - reserved)

  let left = rect.right + OFFSET
  let top = rect.bottom + OFFSET

  if (left + ICON_SIZE > available - GAP) {
    left = Math.max(GAP, Math.min(rect.right - ICON_SIZE, available - ICON_SIZE - GAP))
  }
  // 下方放不下 → 上移到选区上方（避让遮挡）
  if (top + ICON_SIZE > window.innerHeight - GAP) {
    top = Math.max(GAP, rect.top - ICON_SIZE - OFFSET)
  }

  icon.style.left = `${Math.round(left)}px`
  icon.style.top = `${Math.round(top)}px`
}

function hideIcon(): void {
  if (iconButton) iconButton.classList.remove('transora-sel-icon--open')
  pendingText = ''
  anchorRect = null
}

function showIcon(rect: DOMRect): void {
  if (!iconButton) return
  positionIcon(rect, iconButton)
  iconButton.classList.add('transora-sel-icon--open')
}

function hideAll(): void {
  hideIcon()
  card?.hide()
}

/** 供右键菜单 / 快捷键入口复用（H1）：直接对指定文本弹卡片 */
export async function showSelectionCardForText(text: string): Promise<void> {
  const info = readSelection()
  anchorRect = info?.rect ?? null
  hideIcon()
  card?.show(text, anchorRect)
}

export function mountSelection(root: HTMLElement): SelectionController {
  // 跟随图标（fixed 定位，用 absolute 承载滚动偏移）
  iconButton = document.createElement('button')
  iconButton.type = 'button'
  iconButton.className = 'transora-sel-icon'
  iconButton.setAttribute('data-transora', 'selection-icon')
  iconButton.title = '翻译选中文本'
  iconButton.innerHTML = ICONS.translate
  iconButton.style.zIndex = String(Z.selectionIcon)
  iconButton.addEventListener('mousedown', (event) => {
    // 阻止 mousedown 导致选区被清空
    event.preventDefault()
    event.stopPropagation()
  })
  iconButton.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!pendingText) return
    card?.show(pendingText, anchorRect)
    hideIcon()
  })
  root.appendChild(iconButton)

  card = mountSelectionCard(root)

  const onMouseUp = (event: MouseEvent): void => {
    const target = event.target as Node | null
    if (isOwnNode(target) || card?.contains(target)) return

    // 延后一帧再读选区：部分站点在 mouseup 时才更新 selection
    window.setTimeout(() => {
      const info = readSelection()
      if (!info || info.text.length < 1) {
        hideIcon()
        return
      }
      pendingText = info.text
      anchorRect = info.rect

      // 未配置模型时不弹跟随图标，改由悬浮按钮承载引导（D-4）
      showIcon(info.rect)
    }, 0)
  }

  const onMouseDown = (event: MouseEvent): void => {
    const target = event.target as Node | null
    if (isOwnNode(target) || card?.contains(target)) return
    if (card?.isVisible()) card.hide()
    hideIcon()
    // 点页面空白处也收起悬浮菜单（菜单自身在 isOwnNode 里已被放行）
    if (state.fabMenuOpen) toggleFabMenu(false)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') hideAll()
  }

  const onScrollOrResize = (): void => {
    // 位置已失效，收起图标；卡片保留（用户可能正在阅读）
    hideIcon()
  }

  // 把「展示划词内容块」注册给 actions（右键菜单 / 快捷键路径复用同一实现）
  registerSelectionShower((text: string) => showSelectionCardForText(text))

  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('mousedown', onMouseDown, true)
  document.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true })
  window.addEventListener('resize', onScrollOrResize, { passive: true })

  return {
    render: () => card?.render(),
    hideAll,
  }
}
