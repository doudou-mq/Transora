/**
 * G10 悬浮按钮（FAB）
 *
 * 设计约束：
 *  - X1：**固定不可拖拽**，可隐藏（隐藏后由 Popup / 设置页恢复）；
 *  - 悬停即在左侧展开菜单，点击也可锁定展开；
 *  - 角标三态：默认（无）/ 进行中（已译块数）/ 完成（对勾，短暂显示）；
 *  - D-4：未配置模型时，菜单顶部插入引导卡，「翻译本页」「翻译选中文本」「多模型对比」置灰。
 */

import { FAB, Z } from '@/shared/constants'
import {
  openApp,
  openSidebar,
  restorePage,
  setFabHidden,
  toggleFabMenu,
  toggleTranslatePage,
  translateCurrentSelection,
} from '../actions'
import { isUnconfigured, state, type SidebarTab } from '../state'
import { createGuideCard } from './guide-card'
import { ICONS } from './icons'

const COMPLETED_BADGE_MS = 3500

let completedAt = 0
let completedTimer: number | null = null

export interface FabController {
  render: () => void
  /** 翻译完成时调用：短暂显示完成角标 */
  markCompleted: () => void
}

interface MenuItem {
  key: string
  label: string
  icon: string
  disabled?: boolean
  hint?: string
  onClick: () => void
}

function buildMenuItems(): MenuItem[] {
  const unconfigured = isUnconfigured()
  const translating = state.status === 'translating'
  const translated = state.status === 'translated'

  return [
    {
      key: 'translate',
      label: translating ? '取消翻译' : translated ? '恢复原文' : '翻译本页',
      icon: translated ? ICONS.restore : ICONS.translate,
      disabled: unconfigured && !translating,
      hint: unconfigured ? '需先配置模型' : 'Alt+Shift+S',
      onClick: () => {
        if (translated) restorePage()
        else toggleTranslatePage()
      },
    },
    {
      key: 'selection',
      label: '翻译选中文本',
      icon: ICONS.page,
      disabled: unconfigured,
      hint: unconfigured ? '需先配置模型' : 'Alt+Shift+T',
      onClick: () => {
        void translateCurrentSelection()
      },
    },
    {
      key: 'page',
      label: '本页对照',
      icon: ICONS.sidebar,
      hint: 'Alt+Shift+R',
      onClick: () => openSidebar('page' satisfies SidebarTab),
    },
    {
      key: 'records',
      label: '划词记录',
      icon: ICONS.history,
      onClick: () => openSidebar('records' satisfies SidebarTab),
    },
    {
      key: 'compare',
      label: '多模型对比',
      icon: ICONS.compare,
      disabled: true,
      hint: '阶段 2 开放',
      onClick: () => openSidebar('compare' satisfies SidebarTab),
    },
    {
      key: 'settings',
      label: '模型配置',
      icon: ICONS.settings,
      onClick: () => openApp('models'),
    },
    {
      key: 'hide',
      label: '隐藏悬浮按钮',
      icon: ICONS.eyeOff,
      hint: '可在设置页恢复',
      onClick: () => {
        void setFabHidden(true)
      },
    },
  ]
}

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
    badge.className = 'transora-fab-badge transora-fab-badge--done'
    badge.innerHTML = ICONS.check
    badge.title = '翻译完成'
    return badge
  }

  return null
}

export function mountFab(root: HTMLElement): FabController {
  const container = document.createElement('div')
  container.className = 'transora-fab'
  container.setAttribute('data-transora', 'fab')
  container.style.zIndex = String(Z.fab)

  // 悬停开合：移出后延迟判定，避免鼠标经过时闪断
  container.addEventListener('mouseenter', () => toggleFabMenu(true))
  container.addEventListener('mouseleave', () => {
    window.setTimeout(() => {
      if (container.matches(':hover')) return
      toggleFabMenu(false)
    }, 220)
  })

  root.appendChild(container)

  const render = (): void => {
    container.classList.toggle('transora-fab--hidden', state.settings.fabHidden)
    container.classList.toggle('transora-fab--open', state.fabMenuOpen)

    const translating = state.status === 'translating'

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'transora-fab-btn'
    button.title = translating ? '取消翻译' : 'Transora'
    button.innerHTML = translating ? ICONS.close : ICONS.translate
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      // 悬停已经会展开菜单，所以点击不能再简单 toggle —— 否则鼠标一移上来菜单就被点没了。
      // 语义定为：菜单开着 → 收起（不做任何翻译，避免误触）；菜单没开 → 直接执行主操作。
      if (state.fabMenuOpen) {
        toggleFabMenu(false)
        return
      }
      toggleTranslatePage()
    })

    const badge = buildBadge()
    if (badge) button.appendChild(badge)

    const menu = document.createElement('div')
    menu.className = 'transora-fab-menu'
    menu.style.width = `${FAB.menuWidth - 24}px`

    if (isUnconfigured()) {
      menu.appendChild(
        createGuideCard({
          compact: true,
          onConfigure: () => {
            toggleFabMenu(false)
            openApp('models')
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
        if (item.key !== 'hide') toggleFabMenu(false)
      })

      list.appendChild(row)
    }

    menu.appendChild(list)

    container.replaceChildren(menu, button)
  }

  render()

  return {
    render,
    markCompleted(): void {
      completedAt = Date.now()
      if (completedTimer !== null) window.clearTimeout(completedTimer)
      completedTimer = window.setTimeout(() => {
        completedAt = 0
        completedTimer = null
        render()
      }, COMPLETED_BADGE_MS)
      render()
    },
  }
}
