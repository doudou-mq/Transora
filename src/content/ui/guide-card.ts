/**
 * G12 未配置引导卡 —— **跨表面复用的同一个组件**（docs/00 §D-4）。
 *
 * 挂载点：悬浮菜单顶部（compact）/ 划词内容块译文区 /
 * Popup 空态（Popup 用自己那份 DOM，走同一份 GUIDE_COPY）/
 * 新标签页模型配置空态。
 *
 * 文案一律取自 `shared/copy.ts`（Q8-A：以 docs/00 + 设计稿 S 区为唯一口径），
 * 视觉取 G12：30×30 圆角主色软底图标块 + 16px 标题 + 3 条编号要点 + 主/次按钮 + 脚注。
 */

import { GUIDE_COPY } from '@/shared/copy'
import { ICONS } from './icons'

export interface GuideCardOptions {
  /** 紧凑版：用于悬浮菜单内嵌（尺寸整体小一档） */
  compact?: boolean
  /** 主按钮「去配置模型」 */
  onConfigure: () => void
  /** 次按钮「查看配置指引」；不传则不渲染（例如空间极窄的挂载点） */
  onGuide?: () => void
}

export function createGuideCard(options: GuideCardOptions): HTMLElement {
  const { compact = false, onConfigure, onGuide } = options

  const card = document.createElement('div')
  card.className = `transora-guide${compact ? ' transora-guide--compact' : ''}`
  card.setAttribute('data-transora', 'guide')

  // ---- 头部：图标块 + 主文案 ----
  const head = document.createElement('div')
  head.className = 'transora-guide-head'

  const icon = document.createElement('span')
  icon.className = 'transora-guide-icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.innerHTML = ICONS.sliders
  head.appendChild(icon)

  const title = document.createElement('div')
  title.className = 'transora-guide-title'
  title.textContent = GUIDE_COPY.title
  head.appendChild(title)
  card.appendChild(head)

  // ---- 副文案 ----
  const desc = document.createElement('div')
  desc.className = 'transora-guide-desc'
  desc.textContent = GUIDE_COPY.desc
  card.appendChild(desc)

  // ---- 要点 3 条（编号 + Mono 小字） ----
  const steps = document.createElement('ol')
  steps.className = 'transora-guide-steps'
  GUIDE_COPY.steps.forEach((text, index) => {
    const li = document.createElement('li')
    li.className = 'transora-guide-step'

    const num = document.createElement('span')
    num.className = 'transora-guide-num'
    num.textContent = String(index + 1)
    li.appendChild(num)

    const body = document.createElement('span')
    body.className = 'transora-guide-step-text'
    body.textContent = text
    li.appendChild(body)

    steps.appendChild(li)
  })
  card.appendChild(steps)

  // ---- 动作行 ----
  const actions = document.createElement('div')
  actions.className = 'transora-guide-actions'

  const primary = document.createElement('button')
  primary.type = 'button'
  primary.className = 'transora-guide-btn'
  primary.textContent = GUIDE_COPY.primary
  primary.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onConfigure()
  })
  actions.appendChild(primary)

  if (onGuide) {
    const ghost = document.createElement('button')
    ghost.type = 'button'
    ghost.className = 'transora-guide-btn transora-guide-btn--ghost'
    ghost.textContent = GUIDE_COPY.secondary
    ghost.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onGuide()
    })
    actions.appendChild(ghost)
  }

  card.appendChild(actions)

  // ---- 脚注 ----
  const note = document.createElement('div')
  note.className = 'transora-guide-note'
  note.textContent = GUIDE_COPY.note
  card.appendChild(note)

  return card
}
