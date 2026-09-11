/**
 * H2 Toast —— 单实例、限流、自动消失。
 *
 * docs/00 §D-1 统一规则：**同一批次只报一次 Toast**，避免刷屏。
 * 实现上直接做成「单实例 + 冷却窗口」：冷却期内新的 toast 只更新文案，不堆叠。
 */

import { Z } from '@/shared/constants'

const COOLDOWN_MS = 1200
const DURATION_MS = 3200

let node: HTMLElement | null = null
let hideTimer: number | null = null
let lastShownAt = 0

function ensureNode(): HTMLElement {
  if (node && node.isConnected) return node

  node = document.createElement('div')
  node.className = 'transora-toast'
  node.setAttribute('data-transora', 'toast')
  node.setAttribute('role', 'status')
  node.style.zIndex = String(Z.toast)

  // 挂到统一挂载点下，复用同一套字体与隔离样式；挂载点不存在时兜底挂到 documentElement
  const root = document.querySelector('[data-transora="root"]')
  ;(root ?? document.documentElement).appendChild(node)
  return node
}

export type ToastKind = 'info' | 'success' | 'error'

export function toast(message: string, kind: ToastKind = 'info'): void {
  const now = Date.now()
  const target = ensureNode()

  // 冷却窗口内只更新文案（同一批次失败不刷屏）
  const withinCooldown = now - lastShownAt < COOLDOWN_MS
  if (!withinCooldown) lastShownAt = now

  target.textContent = message
  target.dataset.kind = kind
  target.classList.add('transora-toast--visible')

  if (hideTimer !== null) window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => {
    target.classList.remove('transora-toast--visible')
  }, DURATION_MS)
}

/** 页面卸载/恢复原文时清理 */
export function destroyToast(): void {
  if (hideTimer !== null) window.clearTimeout(hideTimer)
  hideTimer = null
  node?.remove()
  node = null
}
