/**
 * 译文注入 / 恢复 / 三态切换（docs/04 §五）。
 *
 * 插入策略（对应 docs/00 §G-3 风险 1「flex/grid 容器内插入译文块导致重排」）：
 *   - 父级是普通流布局 → 译文块作为**兄弟节点**插在原文块之后（标准「上下交错式」，S1）；
 *   - 父级是 flex / grid → **不改动父级的子节点数量**，把译文块**内嵌**到原文块末尾，
 *     避免多出一个 flex item 把原文挤走。
 *
 * 内嵌场景的代价与对策：
 *   内嵌后「仅译文」模式无法用 `display:none` 隐藏原文（会把译文一起藏掉），
 *   因此改为对原文块设 `font-size: 0`，译文块自身用注入时锁定的 `--transora-fs` 还原字号。
 *
 * 所有节点都带 `data-transora` 标记与 `transora-` 前缀 class，
 * 恢复原文时按标记精确清理，不依赖任何映射表（不残留、不误删）。
 */

import { CLS, MODE_CLASS } from '@/shared/constants'
import type { DisplayMode, ErrorInfo } from '@/shared/types'
import { el } from '@/shared/utils'

const DATA_ATTR = 'data-transora'

function chevronSvg(): string {
  return (
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M4 6.5L8 10l4-3.5" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>'
  )
}

/** 创建一个译文块节点（含正文容器与折叠按钮） */
export function createTranslationNode(
  source: HTMLElement,
  targetLang: string,
): { node: HTMLElement; body: HTMLElement } {
  const node = el('div', `${CLS.tr} ${CLS.tr}--loading`, {
    [DATA_ATTR]: 'tr',
    lang: targetLang,
    role: 'note',
  }) as HTMLElement

  // 锁定原文计算字号：内嵌场景下父级会被设为 font-size:0，译文靠这个变量自保
  const fontSize = window.getComputedStyle(source).fontSize
  if (fontSize) node.style.setProperty('--transora-fs', fontSize)

  const body = el('div', CLS.trBody)
  node.appendChild(body)

  const fold = el('button', CLS.trFold, { type: 'button', title: '收起 / 展开译文' })
  fold.innerHTML = chevronSvg()
  fold.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    node.classList.toggle(CLS.folded)
  })
  node.appendChild(fold)

  return { node, body }
}

/** 把译文块插入 DOM：返回是否为内嵌插入 */
export function insertTranslationNode(source: HTMLElement, node: HTMLElement): boolean {
  const parent = source.parentElement
  if (!parent) return false

  const display = window.getComputedStyle(parent).display
  const isFlexOrGrid = /flex|grid/.test(display)

  if (isFlexOrGrid) {
    source.classList.add(CLS.srcInline)
    source.appendChild(node)
    return true
  }

  source.classList.add(CLS.src)
  parent.insertBefore(node, source.nextSibling)
  return false
}

/** 写入译文正文 */
export function setTranslationText(node: HTMLElement, body: HTMLElement, text: string): void {
  node.classList.remove(`${CLS.tr}--loading`, `${CLS.tr}--error`)
  body.textContent = text
  // 短文本无需折叠
  if (text.length < 120) node.classList.add(`${CLS.tr}--short`)
  else node.classList.remove(`${CLS.tr}--short`)
}

/** 写入错误占位（不弹 alert，保持块内联，docs/00 §D-1 统一规则） */
export function setTranslationError(
  node: HTMLElement,
  body: HTMLElement,
  error: ErrorInfo,
  onRetry?: () => void,
): void {
  node.classList.remove(`${CLS.tr}--loading`)
  node.classList.add(`${CLS.tr}--error`)
  body.textContent = ''

  const message = el('span', `${CLS.tr}-error-text`)
  message.textContent = error.message
  body.appendChild(message)

  if (onRetry && error.retryable) {
    const retry = el('button', `${CLS.tr}-error-retry`, { type: 'button' })
    retry.textContent = '重试'
    retry.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onRetry()
    })
    body.appendChild(retry)
  }
}

/** 标记某块回到 loading 态（重试时使用） */
export function setTranslationLoading(node: HTMLElement, body: HTMLElement): void {
  node.classList.remove(`${CLS.tr}--error`)
  node.classList.add(`${CLS.tr}--loading`)
  body.textContent = ''
}

/* ------------------------------------------------------------------ */
/* 恢复 / 模式切换                                                     */
/* ------------------------------------------------------------------ */

/** 移除页面上全部译文块，并清理原文块上的标记 class（FR-02） */
export function removeAllTranslations(): void {
  document.querySelectorAll(`[${DATA_ATTR}="tr"]`).forEach((node) => node.remove())

  document
    .querySelectorAll(`.${CLS.src}, .${CLS.srcInline}`)
    .forEach((node) => {
      node.classList.remove(CLS.src, CLS.srcInline)
      ;(node as HTMLElement).style.removeProperty('font-size')
    })

  document.querySelectorAll(`.${CLS.highlight}`).forEach((node) => {
    node.classList.remove(CLS.highlight)
  })
}

/** 应用对照三态（FR-16：切换即时生效，不重新请求） */
export function applyDisplayMode(mode: DisplayMode): void {
  const root = document.documentElement
  Object.values(MODE_CLASS).forEach((cls) => root.classList.remove(cls))
  root.classList.add(MODE_CLASS[mode])
}

/** 从侧边栏点击某条对照时，滚动并高亮对应原文块 */
export function focusSourceBlock(source: HTMLElement): void {
  source.scrollIntoView({ behavior: 'smooth', block: 'center' })
  source.classList.add(CLS.highlight)
  window.setTimeout(() => source.classList.remove(CLS.highlight), 1600)
}

/** 页面上是否已有译文块 */
export function hasTranslations(): boolean {
  return document.querySelector(`[${DATA_ATTR}="tr"]`) !== null
}
