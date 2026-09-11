/**
 * G12 未配置引导卡 —— **跨表面复用的同一个组件**（docs/00 §D-4）。
 *
 * 四处挂载点：悬浮菜单顶部 / 划词内容块译文区 / Popup 空态（Popup 用自己那份 DOM，样式同源）/
 * 新标签页空态。文案保持一致，去向统一为「新标签页 · 模型配置」。
 */

export interface GuideCardOptions {
  /** 紧凑版用于悬浮菜单内嵌 */
  compact?: boolean
  onConfigure: () => void
}

export function createGuideCard(options: GuideCardOptions): HTMLElement {
  const { compact = false, onConfigure } = options

  const card = document.createElement('div')
  card.className = `transora-guide${compact ? ' transora-guide--compact' : ''}`
  card.setAttribute('data-transora', 'guide')

  const title = document.createElement('div')
  title.className = 'transora-guide-title'
  title.textContent = '尚未配置模型'
  card.appendChild(title)

  const desc = document.createElement('div')
  desc.className = 'transora-guide-desc'
  desc.textContent = '完成配置后即可翻译。模型由你自己接入，请求直达你的服务商，不经过任何中转。'
  card.appendChild(desc)

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'transora-guide-btn'
  button.textContent = '去配置模型'
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onConfigure()
  })
  card.appendChild(button)

  return card
}
