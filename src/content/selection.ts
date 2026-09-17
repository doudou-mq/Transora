/**
 * G4 划词跟随图标 + 触发逻辑（FR-03，交互口径见设计稿 S5）
 *
 * 交互定义：
 *  - 选中文字（长度 ≥ 2，按码点计）→ 选区**右下方外扩 8px** 处出现跟随图标；
 *  - 图标 hover ≥ 120ms 展开「划词内容块」；单击图标同样直接展开（G4 图注）；
 *  - 遮挡避让：右下方放不下时上移到选区上方，右侧越界时贴左；
 *  - 收起：点击空白处、滚动、选区变化、Esc（S5「消失」四条，**不含鼠标移出**）；
 *  - 未配置模型时图标照常出现，由内容块把译文区替换成引导卡（S6 / docs/00 §D-4）。
 *
 * 次要入口：右键菜单与快捷键（H1），最终都调用 `showSelectionCardForText`。
 */

import { SELECTION, Z, sidebarWidthFor } from '@/shared/constants'
import { isOwnNode } from '@/shared/utils'
import { registerSelectionShower, toggleFabMenu } from './actions'
import { state } from './state'
import { mountSelectionCard, type SelectionCardController } from './ui/selection-card'

/** 图标到视口边缘的最小留白 */
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
let openTimer: number | null = null

/** 按码点计数：CJK 与 emoji 都算 1 个字（`String.length` 会把 emoji 算成 2） */
function charCount(text: string): number {
  return Array.from(text).length
}

function readSelection(): SelectionInfo | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const text = selection.toString().replace(/\s+/g, ' ').trim()
  if (charCount(text) < SELECTION.minChars) return null

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

/** 返回当前可用的水平右边界：侧边栏打开时把它让出去，避免图标落到侧边栏底下 */
function availableRight(): number {
  // 侧边栏宽度按 Tab 变（对比 Tab 是 728px），避让宽度必须跟着走，否则图标会被压到侧边栏下
  const reserved = state.sidebarOpen ? sidebarWidthFor(state.sidebarTab) : 0
  return Math.max(160, window.innerWidth - reserved)
}

function positionIcon(rect: DOMRect, icon: HTMLElement): void {
  const size = SELECTION.iconSize
  const right = availableRight()

  // 默认：选区末端右下方外扩 8px（S5）
  let left = rect.right + SELECTION.offset
  let top = rect.bottom + SELECTION.offset

  // 右侧越界 → 贴左（不让图标跑出可视区）
  if (left + size > right - GAP) {
    left = Math.max(GAP, Math.min(rect.right - size, right - size - GAP))
  }
  // 下方放不下 → 翻到选区上方
  if (top + size > window.innerHeight - GAP) {
    top = Math.max(GAP, rect.top - size - SELECTION.offset)
  }

  icon.style.left = `${Math.round(left)}px`
  icon.style.top = `${Math.round(top)}px`
}

/* ------------------------------------------------------------------ */
/* 图标显隐                                                            */
/* ------------------------------------------------------------------ */

function cancelPendingOpen(): void {
  if (openTimer !== null) {
    window.clearTimeout(openTimer)
    openTimer = null
  }
}

function hideIcon(): void {
  cancelPendingOpen()
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

/**
 * 展开内容块。
 *
 * 图标**保持可见**：内容块锚定在图标正下方（S5「内容块锚定图标」，视觉上像气泡挂在图标上），
 * 同时图标仍是可再次触发的入口 —— 卡片被 Esc / 点击空白处收起后，重新 hover 图标即可再看一次。
 * 图标的消失只跟「选区级事件」走（见下方 hideAll）。
 */
function openCard(): void {
  if (!pendingText || card?.isVisible()) return
  const text = pendingText
  // S5：内容块**锚定图标**（不是锚定选区左端，否则长段落的卡片会跑到屏幕外）
  const iconRect = iconButton?.getBoundingClientRect()
  const rect = iconRect && iconRect.width > 0 ? iconRect : anchorRect
  card?.show(text, rect)
}

/** 供右键菜单 / 快捷键入口复用（H1）：直接对指定文本弹卡片 */
export async function showSelectionCardForText(text: string): Promise<void> {
  const info = readSelection()
  anchorRect = info?.rect ?? null
  hideIcon()
  card?.show(text, anchorRect)
}

/* ------------------------------------------------------------------ */
/* 挂载                                                                */
/* ------------------------------------------------------------------ */

export function mountSelection(root: HTMLElement): SelectionController {
  // 跟随图标：字符「译」（Q1-A），fixed 定位
  iconButton = document.createElement('button')
  iconButton.type = 'button'
  iconButton.className = 'transora-sel-icon'
  iconButton.setAttribute('data-transora', 'selection-icon')
  iconButton.title = '翻译选中文本'
  iconButton.textContent = '译'
  iconButton.style.zIndex = String(Z.selectionIcon)

  iconButton.addEventListener('mousedown', (event) => {
    // 阻止 mousedown 导致选区被清空（选区一清空就再也读不到原文了）
    event.preventDefault()
    event.stopPropagation()
  })

  // S5：hover ≥120ms 展开内容块
  iconButton.addEventListener('mouseenter', () => {
    if (card?.isVisible() || openTimer !== null || !pendingText) return
    openTimer = window.setTimeout(() => {
      openTimer = null
      openCard()
    }, SELECTION.hoverOpenDelayMs)
  })
  iconButton.addEventListener('mouseleave', cancelPendingOpen)

  // G4 图注：单击即翻译（hover 之外的显式入口，触屏上也靠它）
  iconButton.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    cancelPendingOpen()
    openCard()
  })

  root.appendChild(iconButton)

  card = mountSelectionCard(root)

  const onMouseUp = (event: MouseEvent): void => {
    const target = event.target as Node | null
    if (isOwnNode(target) || card?.contains(target)) return

    // 延后一帧再读选区：部分站点在 mouseup 时才更新 selection
    window.setTimeout(() => {
      const info = readSelection()
      if (!info) {
        hideIcon()
        return
      }
      pendingText = info.text
      anchorRect = info.rect
      showIcon(info.rect)
    }, 0)
  }

  const onMouseDown = (event: MouseEvent): void => {
    const target = event.target as Node | null
    if (isOwnNode(target) || card?.contains(target)) return
    card?.hide()
    hideIcon()
    // 点页面空白处也收起悬浮菜单（菜单自身在 isOwnNode 里已被放行）
    if (state.fabMenuOpen) toggleFabMenu(false)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') hideAll()
  }

  // S5「消失」：滚动 / 窗口尺寸变化时图标与内容块一起收起
  const onScrollOrResize = (): void => hideAll()

  // S5「消失」：选区变化（被清空）时收起
  const onSelectionChange = (): void => {
    if (!card?.isVisible() && !iconButton?.classList.contains('transora-sel-icon--open')) return
    const text = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? ''
    if (!text) hideAll()
  }

  // 把「展示划词内容块」注册给 actions（右键菜单 / 快捷键路径复用同一实现）
  registerSelectionShower((text: string) => showSelectionCardForText(text))

  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('mousedown', onMouseDown, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('selectionchange', onSelectionChange)
  window.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true })
  window.addEventListener('resize', onScrollOrResize, { passive: true })

  return {
    render: () => card?.render(),
    hideAll,
  }
}
