/**
 * 通用小工具。仅基础函数，不含业务语义。
 */

export function uid(prefix = 'id'): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return function debounced(this: unknown, ...args: Parameters<T>) {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn.apply(this, args)
    }, wait)
  } as T
}

/** djb2 字符串哈希，用于缓存键 */
export function hashString(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 创建元素的小助手，减少重复样板 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  }
  return node
}

/** 判断节点是否由本扩展注入 */
export function isOwnNode(node: Node | null): boolean {
  if (!node) return false
  const parent = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return Boolean(parent?.closest?.('[data-transora]'))
}

/** 数组分块 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [items as T[]]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[])
  return out
}
