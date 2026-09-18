/**
 * G10 悬浮按钮（FAB）
 *
 * 设计约束：
 *  - 严格贴靠视口右侧（距右 18px），**固定不可拖拽**（X1）；
 *  - 侧边栏打开期间隐藏（否则会被贴右滑出的侧边栏盖住，看得见点不动）；
 *  - 按钮字形 = 白色字符「T」；悬停放大并加深投影，同时向左滑出菜单；
 *  - 悬停 ≥120ms 才展开（防误触），移出 250ms 后收起；Esc 关闭；↑↓ 移动、Enter 执行；
 *  - 角标三态：进行中（已译块数）/ 完成（对勾）/ 失败（感叹号），复用 H3 规范；
 *  - 菜单 = 功能导航中枢（S4）：①–③ 留在当前页面，④–⑦ 进新标签页，两组之间发丝线分隔；
 *  - D-4：未配置模型时，顶部插入引导卡，「翻译当前页面」「多模型对比」置灰。
 */

import { FAB, Z } from '@/shared/constants'
import {
  openApp,
  openGuide,
  openSidebar,
  restorePage,
  toggleFabMenu,
  toggleTranslatePage,
} from '../actions'
import { isUnconfigured, state, type SidebarTab } from '../state'
import { createGuideCard } from './guide-card'
import { ICONS } from './icons'

const COMPLETED_BADGE_MS = 3500

/** 移出 250ms 后收起（S3 / S4） */
const HOVER_CLOSE_DELAY_MS = 250

/**
 * 两段式悬停的时序（S3 / S4）：
 *   第一段「露出」= CSS transition，在 `FAB.revealMs` 内完成位移 + 透明度 + 缩放；
 *   第二段「展开菜单」必须**等第一段播完**再开始 —— 否则菜单会从半隐藏的位置滑出来，
 *   两段动画糊在一起，看不出「先露出、再展开」的层次。
 * 防误触语义不变：180ms 比原阈值 120ms 更长。
 */
const HOVER_OPEN_DELAY_MS = FAB.revealMs

/** 键盘导航高亮：用 class 而非 DOM focus，避免 render 重建时焦点丢失 */
const ACTIVE_CLASS = 'is-active'

let completedAt = 0
let completedFailed = false
let completedTimer: number | null = null

export interface FabController {
  render: () => void
  /** 翻译结束时调用：短暂显示完成 / 失败角标 */
  markCompleted: (failed?: boolean) => void
}

interface MenuItem {
  key: string
  label: string
  icon: string
  disabled?: boolean
  hint?: string
  onClick: () => void
  /** true = 本项之后插入分组发丝线 */
  sepAfter?: boolean
}

/** S4 菜单 ①–⑦：与设计稿逐项对齐 */
function buildMenuItems(): MenuItem[] {
  const unconfigured = isUnconfigured()
  const translating = state.status === 'translating'
  const translated = state.status === 'translated'

  return [
    {
      key: 'translate',
      label: translating ? '取消翻译' : translated ? '恢复原文' : '翻译当前页面',
      icon: translated ? ICONS.restore : ICONS.translate,
      disabled: unconfigured,
      hint: 'Alt+Shift+S',
      onClick: () => {
        if (translated && !translating) restorePage()
        else toggleTranslatePage()
      },
    },
    {
      key: 'sidebar',
      label: '打开侧边栏',
      icon: ICONS.sidebar,
      hint: 'Alt+Shift+R',
      onClick: () => openSidebar('page' satisfies SidebarTab),
    },
    {
      key: 'compare',
      label: '多模型对比',
      icon: ICONS.compare,
      // 未配置模型时置灰（docs/00 §D-4）；已配置则直接打开侧边栏的对比 Tab
      disabled: unconfigured,
      hint: '最多 3 个模型',
      sepAfter: true,
      onClick: () => openSidebar('compare' satisfies SidebarTab),
    },
    {
      key: 'history',
      label: '翻译历史',
      icon: ICONS.history,
      onClick: () => openApp('history'),
    },
    {
      key: 'models',
      label: '模型配置',
      icon: ICONS.sliders,
      onClick: () => openApp('models'),
    },
    {
      key: 'general',
      label: '通用设置',
      icon: ICONS.settings,
      onClick: () => openApp('general'),
    },
    {
      key: 'about',
      label: '关于 Transora',
      icon: ICONS.info,
      onClick: () => openApp('about'),
    },
  ]
}

/** H3 三态角标 */
function buildBadge(): HTMLElement | null {
  if (state.status === 'translating') {
    const badge = document.createElement('span')
    badge.className = 'transora-fab-badge transora-fab-badge--progress'
    badge.textContent = String(state.progress.done)
    badge.title = `翻译中 ${state.progress.done} / ${state.progress.total}`
    return badge
  }

  if (completedAt > 0 && Date.now() - completedAt < COMPLETED_BADGE_MS) {
    const badge = document.createElement('span')
    badge.className = `transora-fab-badge ${
      completedFailed ? 'transora-fab-badge--error' : 'transora-fab-badge--done'
    }`
    badge.innerHTML = completedFailed ? '!' : ICONS.check
    badge.title = completedFailed ? '部分段落翻译失败' : '翻译完成'
    return badge
  }

  return null
}

export function mountFab(root: HTMLElement): FabController {
  // E2：注入 UI 的几何数字**唯一来源**是 `FAB`，一律通过自定义属性交给 CSS
  // （styles.css 写 `right: var(--transora-fab-offset)` / `translateX(var(--transora-fab-peek))`）。
  // 此前常量与样式分叉过一次，改常量不生效 —— 新增数字也必须走这条路。
  document.documentElement.style.setProperty('--transora-fab-offset', `${FAB.offset}px`)
  document.documentElement.style.setProperty('--transora-fab-peek', `${FAB.peek}px`)
  document.documentElement.style.setProperty('--transora-fab-reveal-ms', `${FAB.revealMs}ms`)

  const container = document.createElement('div')
  container.className = 'transora-fab'
  container.setAttribute('data-transora', 'fab')
  container.style.zIndex = String(Z.fab)

  let openTimer: number | null = null
  let closeTimer: number | null = null

  container.addEventListener('mouseenter', () => {
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer)
      closeTimer = null
    }
    if (state.fabMenuOpen || openTimer !== null) return
    openTimer = window.setTimeout(() => {
      openTimer = null
      toggleFabMenu(true)
    }, HOVER_OPEN_DELAY_MS)
  })

  container.addEventListener('mouseleave', () => {
    if (openTimer !== null) {
      window.clearTimeout(openTimer)
      openTimer = null
    }
    if (closeTimer !== null) window.clearTimeout(closeTimer)
    closeTimer = window.setTimeout(() => {
      closeTimer = null
      if (container.matches(':hover')) return
      toggleFabMenu(false)
    }, HOVER_CLOSE_DELAY_MS)
  })

  root.appendChild(container)

  const render = (): void => {
    // 角标必须先算：它决定按钮要不要强制保持露出（见下）
    const badge = buildBadge()

    container.classList.toggle('transora-fab--hidden', state.settings.fabHidden)
    container.classList.toggle('transora-fab--open', state.fabMenuOpen)
    // 有角标（翻译进行中 / 刚完成）时保持完整露出：隐藏式静止态只露一半，
    // 而角标画在按钮右上角 —— 半隐藏时整枚角标都落在视口外，
    // H3 的「进行中 / 完成 / 失败」三态就无从可见，角标规范会形同虚设。
    container.classList.toggle('transora-fab--badged', Boolean(badge))

    const translating = state.status === 'translating'

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'transora-fab-btn'
    button.title = translating ? '取消翻译' : 'Transora'
    // 字形固定为字符「T」：状态差异只由角标表达（G10 / H3）
    button.textContent = 'T'
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      // Q4：hover 已会展开菜单，点击始终执行主操作，不再用「菜单开着则收起」的语义
      toggleTranslatePage()
      if (state.fabMenuOpen) toggleFabMenu(false)
    })

    if (badge) button.appendChild(badge)

    const menu = document.createElement('div')
    menu.className = 'transora-fab-menu'

    const head = document.createElement('div')
    head.className = 'transora-fab-menu-head'
    const mark = document.createElement('span')
    mark.className = 'transora-fab-menu-mark'
    mark.textContent = 'T'
    const title = document.createElement('span')
    title.className = 'transora-fab-menu-title'
    title.textContent = 'Transora'
    head.append(mark, title)
    menu.appendChild(head)

    if (isUnconfigured()) {
      menu.appendChild(
        createGuideCard({
          compact: true,
          onConfigure: () => {
            toggleFabMenu(false)
            openApp('models')
          },
          onGuide: () => {
            toggleFabMenu(false)
            openGuide()
          },
        }),
      )
    }

    const list = document.createElement('div')
    list.className = 'transora-fab-list'

    for (const item of buildMenuItems()) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'transora-fab-item'
      row.disabled = Boolean(item.disabled)

      const icon = document.createElement('span')
      icon.className = 'transora-fab-item-icon'
      icon.innerHTML = item.icon

      const label = document.createElement('span')
      label.className = 'transora-fab-item-label'
      label.textContent = item.label

      row.append(icon, label)

      if (item.hint) {
        const hint = document.createElement('span')
        hint.className = 'transora-fab-item-hint'
        hint.textContent = item.hint
        row.appendChild(hint)
      }

      row.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (item.disabled) return
        item.onClick()
        toggleFabMenu(false)
      })

      list.appendChild(row)

      if (item.sepAfter) {
        const sep = document.createElement('div')
        sep.className = 'transora-fab-sep'
        list.appendChild(sep)
      }
    }

    menu.appendChild(list)

    container.replaceChildren(menu, button)
  }

  /** Esc 关闭 / ↑↓ 移动 / Enter 执行（S4 键盘操作） */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!state.fabMenuOpen) return

    if (event.key === 'Escape') {
      event.stopPropagation()
      toggleFabMenu(false)
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const items = [
        ...container.querySelectorAll<HTMLButtonElement>('.transora-fab-item:not(:disabled)'),
      ]
      if (items.length === 0) return
      event.preventDefault()
      const current = items.findIndex((el) => el.classList.contains(ACTIVE_CLASS))
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next =
        current < 0
          ? step > 0
            ? 0
            : items.length - 1
          : (current + step + items.length) % items.length
      items.forEach((el, index) => el.classList.toggle(ACTIVE_CLASS, index === next))
      return
    }

    if (event.key === 'Enter') {
      const active = container.querySelector<HTMLButtonElement>(
        `.transora-fab-item.${ACTIVE_CLASS}`,
      )
      if (!active) return
      event.preventDefault()
      active.click()
    }
  }

  document.addEventListener('keydown', onKeyDown, true)

  render()

  return {
    render,
    markCompleted(failed = false): void {
      completedAt = Date.now()
      completedFailed = failed
      if (completedTimer !== null) window.clearTimeout(completedTimer)
      completedTimer = window.setTimeout(() => {
        completedAt = 0
        completedFailed = false
        completedTimer = null
        render()
      }, COMPLETED_BADGE_MS)
      render()
    },
  }
}
