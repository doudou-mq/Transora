/**
 * Popup —— 400×600 的「3 步快捷操作」表面（设计稿 D1–D6）。
 *
 * 定位（S7）：Pickup **不与悬浮菜单重叠** —— 悬浮菜单是导航中枢（7 项），
 * Popup 只做「选模型 → 选语言 → 全文翻译」。
 *
 * 视图（对应设计稿六张图）：
 *   D1 未配置空态   → `unconfigured`
 *   D2 就绪态       → `ready`（模型单选列表 + 目标语言 + 全文翻译 / 恢复原文）
 *   D3 成本提示     → `confirm`（即将翻译 N 个段落… + 请求次数 + 预估 token / 费用）
 *   D4 翻译中       → `translating`（进度条 + 取消翻译）
 *   D6 部分失败     → `failed`（失败说明 + 重试失败批次 / 应用已完成译文）
 *
 * 文案口径（Q8-A）：未配置卡取 `shared/copy.ts`（= 设计稿 S6），
 * 三态切换的名词取设计稿 G3/G7/G11 的 **原文 / 译文 / 对照**。
 */

import '@/shared/tokens.css'
import './popup.css'

import { GUIDE_COPY } from '@/shared/copy'
import { estimateCost, formatCost, formatCount, formatTokens } from '@/shared/estimate'
import { TARGET_LANGS } from '@/shared/langs'
import {
  MSG,
  getActiveTab,
  sendToBackground,
  sendToTab,
  type ContentCommand,
  type GetStateResponse,
  type PagePlan,
  type PageStatusResponse,
} from '@/shared/messages'
import { openAppPage } from '@/shared/storage'
import type { DisplayMode, ModelConfig, Settings } from '@/shared/types'

const app = document.getElementById('app') as HTMLElement

let models: ModelConfig[] = []
let settings: Settings
let tabId: number | undefined
let pageStatus: PageStatusResponse = { available: false }
let polling: number | null = null

/** D3 的「翻译前确认」步骤：true 时展示成本卡而不是就绪态 */
let confirming = false
/** D6 的「应用已完成译文」= 本次会话内不再提示部分失败 */
let failedDismissed = false

/* ------------------------------------------------------------------ */
/* 图标（Popup 是独立页面，不复用内容脚本的图标模块，避免分层倒挂）        */
/* ------------------------------------------------------------------ */

const SVG = {
  clock:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 1.8"/></svg>',
  sliders:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 6h9M17 6h3"/><circle cx="15" cy="6" r="2"/>' +
    '<path d="M4 12h4M12 12h8"/><circle cx="10" cy="12" r="2"/>' +
    '<path d="M4 18h9M17 18h3"/><circle cx="15" cy="18" r="2"/></svg>',
  puzzle:
    '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M10 4a2 2 0 1 1 4 0v1h3a1 1 0 0 1 1 1v3h-1a2 2 0 1 0 0 4h1v3a1 1 0 0 1-1 1h-3v-1a2 2 0 1 0-4 0v1H7a1 1 0 0 1-1-1v-3h1a2 2 0 1 0 0-4H6V6a1 1 0 0 1 1-1h3V4z"/></svg>',
} as const

/* ------------------------------------------------------------------ */
/* 元素工厂                                                            */
/* ------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className, text)
  node.type = 'button'
  node.addEventListener('click', onClick)
  return node
}

function label(text: string): HTMLElement {
  return el('div', 'popup-field-label', text)
}

function hairline(): HTMLElement {
  return el('div', 'popup-hairline')
}

/* ------------------------------------------------------------------ */
/* 视图：头部 / 底部                                                    */
/* ------------------------------------------------------------------ */

function buildHeader(): HTMLElement {
  const header = el('header', 'popup-header')

  const brand = el('div', 'popup-brand')
  const logo = el('span', 'popup-logo', 'T')
  logo.setAttribute('aria-hidden', 'true')
  brand.append(logo, el('span', 'popup-wm', 'Transora'))
  header.appendChild(brand)

  const actions = el('div', 'popup-header-actions')

  const history = button('popup-icon', '', () => openAppPage('history'))
  history.innerHTML = SVG.clock
  history.title = '翻译历史'
  history.setAttribute('aria-label', '翻译历史')
  actions.appendChild(history)

  const settingsBtn = button('popup-icon', '', () => openAppPage('general'))
  settingsBtn.innerHTML = SVG.sliders
  settingsBtn.title = '通用设置'
  settingsBtn.setAttribute('aria-label', '通用设置')
  actions.appendChild(settingsBtn)

  header.appendChild(actions)
  return header
}

/* ------------------------------------------------------------------ */
/* 视图：D1 未配置空态                                                  */
/* ------------------------------------------------------------------ */

function buildUnconfigured(): { body: HTMLElement; footer: HTMLElement } {
  const body = el('div', 'popup-body popup-body--center')

  const icon = el('div', 'popup-empty-icon')
  icon.innerHTML = SVG.puzzle
  body.appendChild(icon)

  body.appendChild(el('div', 'popup-empty-title', GUIDE_COPY.title))
  body.appendChild(el('div', 'popup-empty-desc', GUIDE_COPY.desc))

  const steps = el('ol', 'popup-guide-steps')
  GUIDE_COPY.steps.forEach((text, index) => {
    const li = el('li', 'popup-guide-step')
    li.appendChild(el('span', 'popup-guide-num', String(index + 1)))
    li.appendChild(el('span', 'popup-guide-step-text', text))
    steps.appendChild(li)
  })
  body.appendChild(steps)

  const footer = el('footer', 'popup-footer popup-footer--stack')
  const primary = button('popup-btn popup-btn--primary popup-btn--block', GUIDE_COPY.primary, () =>
    openAppPage('models'),
  )
  footer.appendChild(primary)
  footer.appendChild(el('div', 'popup-footnote', GUIDE_COPY.note))

  return { body, footer }
}

/* ------------------------------------------------------------------ */
/* 视图：D2 就绪态                                                      */
/* ------------------------------------------------------------------ */

function buildModelList(): HTMLElement {
  const list = el('div', 'popup-model-list')
  const active = settings.lastModelId ?? models[0]?.id

  for (const model of models) {
    const selected = model.id === active
    const row = button('popup-model-row', '', () => {
      if (model.id === settings.lastModelId) return
      void patch({ lastModelId: model.id })
    })
    if (selected) row.classList.add('is-selected')
    row.setAttribute('role', 'radio')
    row.setAttribute('aria-checked', String(selected))

    const box = el('span', 'popup-cbx', selected ? '✓' : '')
    row.appendChild(box)

    row.appendChild(el('span', 'popup-model-name', model.name))
    row.appendChild(el('span', 'popup-model-id', model.model))
    list.appendChild(row)
  }

  return list
}

function buildLangSelect(onChange?: (value: string) => void): HTMLElement {
  const wrap = el('div', 'popup-input')
  const select = el('select', 'popup-input-select')
  for (const lang of TARGET_LANGS) {
    const option = document.createElement('option')
    option.value = lang.value
    option.textContent = lang.label
    if (lang.value === settings.targetLang) option.selected = true
    select.appendChild(option)
  }
  select.addEventListener('change', () => {
    if (onChange) onChange(select.value)
    else void patch({ targetLang: select.value })
  })
  wrap.appendChild(select)

  const caret = el('span', 'popup-input-caret', '▾')
  wrap.appendChild(caret)
  return wrap
}

function buildModeSwitch(): HTMLElement {
  const wrap = el('div', 'popup-segmented')
  // 名词取设计稿 G3 / G7 / G11：原文 / 译文 / 对照
  const options: Array<{ key: DisplayMode; text: string }> = [
    { key: 'original-only', text: '原文' },
    { key: 'translation-only', text: '译文' },
    { key: 'bilingual', text: '对照' },
  ]
  for (const option of options) {
    const active = settings.displayMode === option.key
    const node = button('popup-segment', option.text, () => {
      void patch({ displayMode: option.key })
    })
    if (active) node.classList.add('is-active')
    wrap.appendChild(node)
  }
  return wrap
}

function buildReady(): { body: HTMLElement; footer: HTMLElement } {
  const body = el('div', 'popup-body')

  body.appendChild(label('选择翻译模型'))
  body.appendChild(buildModelList())

  body.appendChild(label('目标语言'))
  body.appendChild(buildLangSelect())

  if (pageStatus.status === 'translated') {
    body.appendChild(label('显示模式'))
    body.appendChild(buildModeSwitch())
  }

  const footer = el('footer', 'popup-footer')
  const primary = button(
    'popup-btn popup-btn--primary popup-btn--grow',
    '全文翻译',
    () => {
      // D3：先做成本确认，再真正发起
      confirming = true
      failedDismissed = false
      render()
    },
  )
  if (!pageStatus.available) {
    primary.disabled = true
    primary.textContent = '当前页面不支持翻译'
  }
  footer.appendChild(primary)

  if (pageStatus.status === 'translated') {
    footer.appendChild(
      button('popup-btn popup-btn--secondary popup-btn--fixed', '恢复原文', () => {
        void command('restore')
      }),
    )
  }

  return { body, footer }
}

/* ------------------------------------------------------------------ */
/* 视图：D3 成本提示                                                    */
/* ------------------------------------------------------------------ */

function buildConfirm(): { body: HTMLElement; footer: HTMLElement } {
  const body = el('div', 'popup-body')
  const plan: PagePlan = pageStatus.plan ?? { blocks: 0, chars: 0, batches: 0 }
  const estimate = estimateCost(plan, 1)
  const model = models.find((m) => m.id === settings.lastModelId) ?? models[0]

  const card = el('div', 'popup-cost-card')
  card.appendChild(
    el(
      'div',
      'popup-cost-title',
      `即将翻译 ${plan.blocks} 个段落（约 ${formatCount(plan.chars)} 字）`,
    ),
  )
  card.appendChild(hairline())

  const rows = el('div', 'popup-cost-rows')
  const modelText = model ? `${model.name} · ${model.model}` : '—'
  for (const line of [
    `模型　${modelText}`,
    `请求　${estimate.requests} 次（1 模型 × ${plan.batches} 批次）`,
    `预估　≈ ${formatTokens(estimate.tokens)} token ｜ ≈ ${formatCost(estimate.cost)}`,
  ]) {
    rows.appendChild(el('div', 'popup-cost-row', line))
  }
  card.appendChild(rows)
  body.appendChild(card)

  body.appendChild(label('翻译前确认'))
  body.appendChild(buildLangSelect())

  body.appendChild(
    el(
      'div',
      'popup-footnote popup-footnote--left',
      '费用按 ¥2 / 百万 token 估算，命中缓存的批次不发请求，实际以服务商账单为准。',
    ),
  )

  const footer = el('footer', 'popup-footer')
  footer.appendChild(
    button('popup-btn popup-btn--primary popup-btn--grow', '确认翻译', () => {
      confirming = false
      void command('toggle-translate')
    }),
  )
  footer.appendChild(
    button('popup-btn popup-btn--secondary popup-btn--fixed', '取消', () => {
      confirming = false
      render()
    }),
  )

  return { body, footer }
}

/* ------------------------------------------------------------------ */
/* 视图：D4 翻译中                                                      */
/* ------------------------------------------------------------------ */

function buildTranslating(): { body: HTMLElement; footer: HTMLElement } {
  const body = el('div', 'popup-body')
  const done = pageStatus.progress?.done ?? 0
  const total = pageStatus.progress?.total ?? 0
  const model = models.find((m) => m.id === settings.lastModelId) ?? models[0]

  const block = el('div', 'popup-progress')
  block.appendChild(el('div', 'popup-progress-title', `正在翻译 ${done} / ${total} 段`))

  const bar = el('div', 'popup-progress-bar')
  const fill = el('div', 'popup-progress-fill')
  fill.style.width = total > 0 ? `${Math.min(100, Math.round((done / total) * 100))}%` : '0%'
  bar.appendChild(fill)
  block.appendChild(bar)

  block.appendChild(
    el('div', 'popup-progress-meta', `${model ? model.name : '—'} ｜ 已完成 ${done} ｜ 队列中 ${Math.max(0, total - done)} 段`),
  )
  body.appendChild(block)

  body.appendChild(label('正在翻译'))

  const footer = el('footer', 'popup-footer')
  footer.appendChild(
    button('popup-btn popup-btn--dark popup-btn--grow', '取消翻译', () => {
      void command('toggle-translate')
    }),
  )
  return { body, footer }
}

/* ------------------------------------------------------------------ */
/* 视图：D6 部分失败                                                    */
/* ------------------------------------------------------------------ */

function buildFailed(): { body: HTMLElement; footer: HTMLElement } {
  const body = el('div', 'popup-body')
  const failed = pageStatus.failedCount ?? 0
  const total = pageStatus.entryCount ?? 0

  const note = el('div', 'popup-note popup-note--error')
  note.appendChild(el('div', 'popup-note-title', '部分批次翻译失败'))
  note.appendChild(
    el(
      'div',
      'popup-note-desc',
      `成功 ${Math.max(0, total - failed)} / ${total} 段。有 ${failed} 段在自动重试后仍未成功，其余结果已保留。`,
    ),
  )
  body.appendChild(note)

  body.appendChild(label('翻译结果'))

  const footer = el('footer', 'popup-footer')
  footer.appendChild(
    button('popup-btn popup-btn--primary popup-btn--grow', '重试失败批次', () => {
      void command('retry-failed')
    }),
  )
  footer.appendChild(
    button('popup-btn popup-btn--secondary popup-btn--wide', '应用已完成译文', () => {
      failedDismissed = true
      render()
    }),
  )

  return { body, footer }
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function currentView(): 'unconfigured' | 'ready' | 'confirm' | 'translating' | 'failed' {
  if (models.length === 0) return 'unconfigured'
  if (pageStatus.status === 'translating') return 'translating'
  if (confirming) return 'confirm'
  if (!failedDismissed && pageStatus.status === 'translated' && (pageStatus.failedCount ?? 0) > 0) {
    return 'failed'
  }
  return 'ready'
}

function render(): void {
  app.replaceChildren()
  app.appendChild(buildHeader())

  const view = currentView()
  const { body, footer } =
    view === 'unconfigured'
      ? buildUnconfigured()
      : view === 'translating'
        ? buildTranslating()
        : view === 'confirm'
          ? buildConfirm()
          : view === 'failed'
            ? buildFailed()
            : buildReady()

  app.appendChild(body)
  app.appendChild(footer)
}

/* ------------------------------------------------------------------ */
/* 数据与动作                                                          */
/* ------------------------------------------------------------------ */

async function patch(patchValue: Partial<Settings>): Promise<void> {
  const next = await sendToBackground<Settings>({ type: MSG.PATCH_SETTINGS, patch: patchValue })
  settings = next
  render()
}

async function command(cmd: ContentCommand): Promise<void> {
  if (tabId === undefined) return
  await sendToTab(tabId, cmd)
  window.setTimeout(() => void refreshStatus(), 200)
  startPolling()
}

async function refreshStatus(): Promise<void> {
  if (tabId === undefined) return
  try {
    pageStatus = (await chrome.tabs.sendMessage(tabId, { type: MSG.PAGE_STATUS })) as PageStatusResponse
  } catch {
    pageStatus = { available: false }
  }
  render()
}

function stopPolling(): void {
  if (polling !== null) {
    window.clearInterval(polling)
    polling = null
  }
}

function startPolling(): void {
  stopPolling()
  polling = window.setInterval(() => {
    void refreshStatus().then(() => {
      if (pageStatus.status !== 'translating') stopPolling()
    })
  }, 700)
}

async function init(): Promise<void> {
  const [state, tab] = await Promise.all([
    sendToBackground<GetStateResponse>({ type: MSG.GET_STATE }),
    getActiveTab(),
  ])
  models = state.models.filter((m) => m.enabled)
  settings = state.settings
  tabId = tab?.id

  await refreshStatus()
  render()
}

window.addEventListener('unload', stopPolling)

void init()
