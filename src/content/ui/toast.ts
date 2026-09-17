/**
 * H2 Toast —— 单实例、限流、三态。
 *
 * 设计稿口径：「固定底部居中，宽 300–360；**深墨底 + 橙色单动作**（三态一致）。
 * 成功 / 进行中 3s 自动消失，失败常驻 6s 并可手动关闭。」
 *
 * 与旧实现的差异（审计 B3/B4/A12）：
 *   - 三态**不再换底色**（原来成功＝绿底、失败＝红底，设计稿是统一深墨底）；
 *   - 圆角 8 → 10、补 min-width 300、内边距 13/14/16；
 *   - 补「单一动作」槽位（撤销 / 取消 / 重试 / 去设置）与失败态的关闭 ×。
 *
 * docs/00 §D-1 统一规则：**同一批次只报一次 Toast**，避免刷屏 ——
 * 由单实例 + 冷却窗口实现：冷却期内只更新文案与动作，不堆叠。
 */

import { TOAST, Z } from '@/shared/constants'

export type ToastKind = 'info' | 'success' | 'error'

/** Toast 上的**唯一**动作（H2：三态各一个，不做多动作） */
export interface ToastAction {
  label: string
  onClick: () => void
  /** 进行中态的「取消」按设计稿弱化为次要文字色 */
  muted?: boolean
}

export interface ToastOptions {
  kind?: ToastKind
  action?: ToastAction
  /** 传 true 用常驻时长（失败 6s）+ 显示手动关闭 × */
  persistent?: boolean
}

let node: HTMLElement | null = null
let textEl: HTMLElement | null = null
let actionEl: HTMLButtonElement | null = null
let closeEl: HTMLButtonElement | null = null
let hideTimer: number | null = null
let lastShownAt = 0

function ensureNode(): HTMLElement {
  if (node && node.isConnected) return node

  const root = document.createElement('div')
  root.className = 'transora-toast'
  root.setAttribute('data-transora', 'toast')
  root.setAttribute('role', 'status')
  root.setAttribute('aria-live', 'polite')
  root.style.zIndex = String(Z.toast)

  textEl = document.createElement('span')
  textEl.className = 'transora-toast-text'
  root.appendChild(textEl)

  actionEl = document.createElement('button')
  actionEl.type = 'button'
  actionEl.className = 'transora-toast-action'
  actionEl.hidden = true
  root.appendChild(actionEl)

  closeEl = document.createElement('button')
  closeEl.type = 'button'
  closeEl.className = 'transora-toast-close'
  closeEl.title = '关闭'
  closeEl.setAttribute('aria-label', '关闭')
  closeEl.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round"/></svg>'
  closeEl.hidden = true
  closeEl.addEventListener('click', () => hide())
  root.appendChild(closeEl)

  // 挂到统一挂载点下，复用同一套字体与隔离样式；挂载点不存在时兜底挂到 documentElement
  const host = document.querySelector('[data-transora="root"]')
  ;(host ?? document.documentElement).appendChild(root)

  node = root
  return root
}

function hide(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer)
    hideTimer = null
  }
  node?.classList.remove('transora-toast--visible')
}

export function toast(message: string, options: ToastKind | ToastOptions = 'info'): void {
  const opts: ToastOptions = typeof options === 'string' ? { kind: options } : options
  const target = ensureNode()
  const now = Date.now()

  /*
   * 冷却窗口（docs/00 §D-1「同一批次只报一次」）：
   * 同一串连续调用算**一次突发** —— 只有突发内的第一条会重置消失计时器，
   * 后续只更新文案与动作。否则「正在翻译… n / N 段」这类高频进度回调
   * 会不断把计时器推后，Toast 永不消失。
   */
  const freshBurst = now - lastShownAt >= TOAST.cooldownMs
  if (freshBurst) lastShownAt = now

  if (textEl) textEl.textContent = message

  if (actionEl) {
    if (opts.action) {
      actionEl.hidden = false
      actionEl.textContent = opts.action.label
      actionEl.classList.toggle('transora-toast-action--muted', Boolean(opts.action.muted))
      const action = opts.action
      actionEl.onclick = () => {
        hide()
        action.onClick()
      }
    } else {
      actionEl.hidden = true
      actionEl.onclick = null
    }
  }

  if (closeEl) closeEl.hidden = !opts.persistent

  target.dataset.kind = opts.kind ?? 'info'
  target.classList.add('transora-toast--visible')

  if (freshBurst) {
    if (hideTimer !== null) window.clearTimeout(hideTimer)
    hideTimer = window.setTimeout(hide, opts.persistent ? TOAST.persistentMs : TOAST.durationMs)
  }
}

/** 页面卸载/恢复原文时清理 */
export function destroyToast(): void {
  if (hideTimer !== null) window.clearTimeout(hideTimer)
  hideTimer = null
  node?.remove()
  node = null
  textEl = null
  actionEl = null
  closeEl = null
}
