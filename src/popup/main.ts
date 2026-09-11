/**
 * Popup —— 400×600 的「3 步快捷操作」表面。
 *
 * 定位（docs/07 判据 3）：Popup **不与悬浮菜单重叠** —— 悬浮菜单是导航中枢（7 项），
 * Popup 只做「翻译本页 / 选模型 / 选目标语言」这三件最常做的事。
 */

import '@/shared/tokens.css'
import './popup.css'

import { PRODUCT_VERSION } from '@/shared/constants'
import { TARGET_LANGS } from '@/shared/langs'
import {
  MSG,
  getActiveTab,
  sendToBackground,
  sendToTab,
  type ContentCommand,
  type GetStateResponse,
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

function row(label: string, control: HTMLElement): HTMLElement {
  const wrap = el('div', 'popup-row')
  wrap.appendChild(el('div', 'popup-row-label', label))
  wrap.appendChild(control)
  return wrap
}

function segmented(options: Array<{ value: string; label: string; active: boolean }>, onPick: (value: string) => void): HTMLElement {
  const wrap = el('div', 'popup-segmented')
  for (const option of options) {
    const button = el('button', 'popup-segment', option.label)
    button.type = 'button'
    if (option.active) button.classList.add('is-active')
    button.addEventListener('click', () => onPick(option.value))
    wrap.appendChild(button)
  }
  return wrap
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

function buildHeader(): HTMLElement {
  const header = el('header', 'popup-header')

  const brand = el('div', 'popup-brand')
  brand.appendChild(el('span', 'popup-brand-dot'))
  brand.appendChild(el('span', 'popup-brand-name', 'Transora'))
  brand.appendChild(el('span', 'tr-pill', `v${PRODUCT_VERSION}`))
  header.appendChild(brand)

  const settingsBtn = el('button', 'popup-icon-btn', '设置')
  settingsBtn.type = 'button'
  settingsBtn.addEventListener('click', () => openAppPage('models'))
  header.appendChild(settingsBtn)

  return header
}

function buildUnconfigured(): HTMLElement {
  const wrap = el('div', 'popup-body')

  const card = el('div', 'popup-guide')
  card.appendChild(el('div', 'popup-guide-title', '尚未配置模型'))
  card.appendChild(
    el(
      'div',
      'popup-guide-desc',
      'Transora 不内置模型。填入你自己的 OpenAI 兼容接口地址与密钥即可开始翻译，请求直达服务商，不经过任何中转。',
    ),
  )

  const button = el('button', 'tr-btn tr-btn--primary', '去配置模型')
  button.type = 'button'
  button.addEventListener('click', () => openAppPage('models'))
  card.appendChild(button)

  wrap.appendChild(card)

  const note = el('div', 'popup-footnote')
  note.textContent = 'API Key 只保存在本机，不上传、不同步。'
  wrap.appendChild(note)

  return wrap
}

function buildPageCard(): HTMLElement {
  const card = el('div', 'popup-card')

  const head = el('div', 'popup-card-head')
  head.appendChild(el('div', 'popup-card-title', '当前页面'))
  const status = el('span', 'popup-status')
  if (!pageStatus.available) {
    status.textContent = '不支持'
    status.classList.add('popup-status--muted')
  } else if (pageStatus.status === 'translating') {
    status.textContent = `翻译中 ${pageStatus.progress?.done ?? 0}/${pageStatus.progress?.total ?? 0}`
    status.classList.add('popup-status--busy')
  } else if (pageStatus.status === 'translated') {
    status.textContent = `已翻译 ${pageStatus.entryCount ?? 0} 段`
    status.classList.add('popup-status--done')
  } else {
    status.textContent = '原文'
    status.classList.add('popup-status--muted')
  }
  head.appendChild(status)
  card.appendChild(head)

  const primary = el('button', 'tr-btn tr-btn--primary popup-primary')
  primary.type = 'button'

  if (!pageStatus.available) {
    primary.textContent = '当前页面不支持翻译'
    primary.disabled = true
  } else if (pageStatus.status === 'translating') {
    primary.textContent = '取消翻译'
    primary.classList.add('popup-primary--ghost')
  } else if (pageStatus.status === 'translated') {
    primary.textContent = '恢复原文'
  } else {
    primary.textContent = '翻译本页'
  }

  primary.addEventListener('click', () => {
    void command('toggle-translate')
  })
  card.appendChild(primary)

  const secondary = el('div', 'popup-secondary')
  const sidebarBtn = el('button', 'tr-btn tr-btn--sm', '打开侧边栏')
  sidebarBtn.type = 'button'
  sidebarBtn.addEventListener('click', () => void command('toggle-sidebar'))
  secondary.appendChild(sidebarBtn)

  const selectionBtn = el('button', 'tr-btn tr-btn--sm', '翻译选中文本')
  selectionBtn.type = 'button'
  selectionBtn.addEventListener('click', () => void command('translate-selection'))
  secondary.appendChild(selectionBtn)

  card.appendChild(secondary)

  if (pageStatus.status === 'translated') {
    const display = el('div', 'popup-subsection')
    display.appendChild(el('div', 'popup-subsection-label', '显示模式'))
    display.appendChild(
      segmented(
        [
          { value: 'original-only', label: '仅原文', active: settings.displayMode === 'original-only' },
          { value: 'bilingual', label: '对照', active: settings.displayMode === 'bilingual' },
          { value: 'translation-only', label: '仅译文', active: settings.displayMode === 'translation-only' },
        ],
        // 写入设置即可：内容脚本监听存储变化后会自动把模式落到页面上
        (value) => {
          void patch({ displayMode: value as DisplayMode })
        },
      ),
    )
    card.appendChild(display)
  }

  return card
}

function buildConfigCard(): HTMLElement {
  const card = el('div', 'popup-card popup-card--config')

  // 模型快选
  const modelSelect = el('select', 'tr-select')
  for (const model of models) {
    const option = document.createElement('option')
    option.value = model.id
    option.textContent = model.name
    if (model.id === settings.lastModelId || (!settings.lastModelId && model === models[0])) {
      option.selected = true
    }
    modelSelect.appendChild(option)
  }
  modelSelect.addEventListener('change', () => {
    void patch({ lastModelId: modelSelect.value })
  })
  card.appendChild(row('模型', modelSelect))

  // 目标语言
  const langSelect = el('select', 'tr-select')
  for (const lang of TARGET_LANGS) {
    const option = document.createElement('option')
    option.value = lang.value
    option.textContent = lang.label
    if (lang.value === settings.targetLang) option.selected = true
    langSelect.appendChild(option)
  }
  langSelect.addEventListener('change', () => {
    void patch({ targetLang: langSelect.value })
  })
  card.appendChild(row('目标语言', langSelect))

  return card
}

function buildFooter(): HTMLElement {
  const footer = el('footer', 'popup-footer')

  const history = el('button', 'popup-link', '翻译历史')
  history.type = 'button'
  history.addEventListener('click', () => openAppPage('history'))
  footer.appendChild(history)

  const about = el('button', 'popup-link', '关于')
  about.type = 'button'
  about.addEventListener('click', () => openAppPage('about'))
  footer.appendChild(about)

  return footer
}

function render(): void {
  app.replaceChildren()

  if (models.length === 0) {
    app.appendChild(buildHeader())
    app.appendChild(buildUnconfigured())
    app.appendChild(buildFooter())
    return
  }

  app.appendChild(buildHeader())

  const body = el('div', 'popup-body')
  body.appendChild(buildPageCard())
  body.appendChild(buildConfigCard())
  app.appendChild(body)

  app.appendChild(buildFooter())
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
