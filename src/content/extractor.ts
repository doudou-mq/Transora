/**
 * 块级元素提取（docs/04 §5.1 / docs/03 FR-01 边界）。
 *
 * 基本单位是**块级元素**，不是文本节点。
 * 叶子判定：候选块内部若还含有候选块，则跳过外层只翻内层（如 `li > p` 只翻 `p`），
 * 避免同一段文字被翻两遍。
 */

import {
  MIN_BLOCK_CHARS,
  SKIP_ANCESTOR_SELECTOR,
  TRANSLATABLE_SELECTOR,
} from '@/shared/constants'

export interface BlockCandidate {
  el: HTMLElement
  /** 归一化后的原文 */
  text: string
  /** 是否在首屏可视区（用于「首屏优先」排序，docs/00 §D-2） */
  inViewport: boolean
}

/** 至少含一个「字母类」字符才值得翻译：过滤纯数字、纯符号、纯空白 */
const LETTER_RE =
  /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/

export function normalizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

/** 元素是否可见（跳过 display:none / visibility:hidden / 零尺寸） */
export function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false
  }
  return el.getClientRects().length > 0
}

export function shouldTranslate(text: string): boolean {
  if (text.length < MIN_BLOCK_CHARS) return false
  return LETTER_RE.test(text)
}

function isInViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  return rect.bottom > 0 && rect.top < viewportHeight
}

/** 该元素内部是否还含有可翻译块（含则说明它不是叶子） */
function hasTranslatableDescendant(el: HTMLElement): boolean {
  return el.querySelector(TRANSLATABLE_SELECTOR) !== null
}

export interface CollectOptions {
  /** 已处理过的元素（动态补翻时去重用） */
  skip?: WeakSet<HTMLElement>
  /** 是否要求可见（默认 true） */
  requireVisible?: boolean
}

/**
 * 扫描 root 下的可翻译块。
 * 返回顺序 = 文档顺序，调用方如需「首屏优先」再自行排序（见 sortByViewportFirst）。
 */
export function collectBlocks(
  root: ParentNode = document,
  options: CollectOptions = {},
): BlockCandidate[] {
  const { skip, requireVisible = true } = options
  const out: BlockCandidate[] = []
  const nodes = root.querySelectorAll<HTMLElement>(TRANSLATABLE_SELECTOR)

  for (const el of nodes) {
    if (skip?.has(el)) continue

    // 噪声容器内（代码块、脚本、编辑区、我们自己的 UI…）
    if (el.closest(SKIP_ANCESTOR_SELECTOR)) continue

    // 只翻叶子块，避免同一段文字被翻两遍
    if (hasTranslatableDescendant(el)) continue

    if (requireVisible && !isVisible(el)) continue

    const text = normalizeText(el.innerText || el.textContent || '')
    if (!shouldTranslate(text)) continue

    out.push({ el, text, inViewport: isInViewport(el) })
  }

  return out
}

/**
 * 首屏优先排序（docs/00 §D-2「首屏优先」）。
 * 稳定排序：可视区内的块排前面，组内保持文档顺序。
 */
export function sortByViewportFirst(blocks: BlockCandidate[]): BlockCandidate[] {
  const inView = blocks.filter((b) => b.inViewport)
  const rest = blocks.filter((b) => !b.inViewport)
  return [...inView, ...rest]
}
