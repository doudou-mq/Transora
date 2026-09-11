/**
 * G5 划词内容块
 *
 * 形态（docs/00 §A1 / X6）：**只做单模型译文**，顶部可临时切换源语言（仅本次生效），
 * 底部提供「供应商 / 模型」Tab 切换 —— 切换即用该模型重新翻译这一段。
 * **不含并排对比**（对比只在侧边栏 Slide）。
 *
 * 旧叫法「划词浮层」已废弃（docs/07）。
 */

import { SIDEBAR_WIDTH, Z } from '@/shared/constants'
import { SOURCE_LANGS, langDisplayName } from '@/shared/langs'
import type { ErrorInfo } from '@/shared/types'
import { openApp, openSidebar, translateSelectionText } from '../actions'
import { activeModel, isUnconfigured, state } from '../state'
import { createGuideCard } from './guide-card'
import { ICONS } from './icons'

const CARD_MAX_WIDTH = 360
const VIEWPORT_GAP = 12

interface CardSession {
  text: string
  rect: DOMRect | null
  status: 'loading' | 'done' | 'error'
  translated: string
  error: ErrorInfo | null
  modelId: string | null
  /** 仅本次生效的源语言（A5） */
  sourceLang: string
  targetLang: string
}

export interface SelectionCardController {
  show: (text: string, rect: DOMRect | null) => void
  hide: () => void
  render: () => void
  isVisible: () => boolean
  /** 供「点击外部关闭」判定 */
  contains: (node: Node | null) => boolean
}

export function mountSelectionCard(root: HTMLElement): SelectionCardController {
  const container = document.createElement('div')
  container.className = 'transora-sel-card'
  container.setAttribute('data-transora', 'selection-card')
  container.style.zIndex = String(Z.selectionCard)
  root.appendChild(container)

  let session: CardSession | null = null
  let requestSeq = 0

  const position = (): void => {
    if (!session) return
    const rect = session.rect

    // 侧边栏占据右侧，内容块只在剩余区域内定位
    const reserved = state.sidebarOpen ? SIDEBAR_WIDTH : 0
    const available = Math.max(260, window.innerWidth - reserved)
    const width = Math.min(CARD_MAX_WIDTH, available - VIEWPORT_GAP * 2)
    const height = container.offsetHeight || 200

    container.style.width = `${width}px`

    let left = rect ? rect.left : Math.max(VIEWPORT_GAP, available / 2 - width / 2)
    let top = rect ? rect.bottom + 10 : 120

    if (left + width > available - VIEWPORT_GAP) {
      left = Math.max(VIEWPORT_GAP, available - width - VIEWPORT_GAP)
    }
    if (top + height > window.innerHeight - VIEWPORT_GAP) {
      top = rect ? Math.max(VIEWPORT_GAP, rect.top - height - 10) : VIEWPORT_GAP
    }

    container.style.left = `${Math.round(left)}px`
    container.style.top = `${Math.round(top)}px`
  }

  const run = async (
    text: string,
    sourceLang: string,
    modelId: string | null,
  ): Promise<void> => {
    const seq = ++requestSeq
    if (!session) return
    session.status = 'loading'
    session.translated = ''
    session.error = null
    render()

    const result = await translateSelectionText(text, sourceLang, modelId ?? undefined)
    // 期间用户又发起了一次请求，丢弃这次结果
    if (seq !== requestSeq || !session) return

    if (result.ok) {
      session.status = 'done'
      session.translated = result.translatedText
    } else {
      session.status = 'error'
      session.error = result.error
    }
    render()
  }

  const buildHeader = (): HTMLElement => {
    const header = document.createElement('header')
    header.className = 'transora-sel-header'

    const langs = document.createElement('div')
    langs.className = 'transora-sel-langs'

    const sourceSelect = document.createElement('select')
    sourceSelect.className = 'transora-sel-select'
    sourceSelect.title = '源语言（仅本次生效）'
    for (const option of SOURCE_LANGS) {
      const opt = document.createElement('option')
      opt.value = option.value
      opt.textContent = option.label
      if (session?.sourceLang === option.value) opt.selected = true
      sourceSelect.appendChild(opt)
    }
    sourceSelect.addEventListener('change', () => {
      if (!session) return
      session.sourceLang = sourceSelect.value
      void run(session.text, session.sourceLang, session.modelId)
    })
    langs.appendChild(sourceSelect)

    const arrow = document.createElement('span')
    arrow.className = 'transora-sel-arrow'
    arrow.textContent = '→'
    langs.appendChild(arrow)

    const target = document.createElement('span')
    target.className = 'transora-sel-target'
    target.textContent = session ? langDisplayName(session.targetLang) : ''
    langs.appendChild(target)

    header.appendChild(langs)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'transora-sel-icon-btn'
    close.title = '关闭'
    close.innerHTML = ICONS.close
    close.addEventListener('click', () => hide())
    header.appendChild(close)

    return header
  }

  const buildModelTabs = (): HTMLElement | null => {
    if (state.models.length === 0) return null

    const tabs = document.createElement('div')
    tabs.className = 'transora-sel-models'

    for (const model of state.models) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'transora-sel-model'
      button.textContent = model.name
      if (session?.modelId === model.id) button.classList.add('is-active')
      button.addEventListener('click', () => {
        if (!session || session.modelId === model.id) return
        session.modelId = model.id
        void run(session.text, session.sourceLang, session.modelId)
      })
      tabs.appendChild(button)
    }

    return tabs
  }

  const buildBody = (): HTMLElement => {
    const body = document.createElement('div')
    body.className = 'transora-sel-body'

    if (isUnconfigured()) {
      body.appendChild(
        createGuideCard({
          compact: true,
          onConfigure: () => {
            hide()
            openApp('models')
          },
        }),
      )
      return body
    }

    if (!session) return body

    const source = document.createElement('div')
    source.className = 'transora-sel-source'
    source.textContent = session.text
    body.appendChild(source)

    if (session.status === 'loading') {
      const loading = document.createElement('div')
      loading.className = 'transora-sel-loading'
      loading.innerHTML = '<i></i><i></i><i></i>'
      body.appendChild(loading)
      return body
    }

    if (session.status === 'error' && session.error) {
      const error = document.createElement('div')
      error.className = 'transora-sel-error'
      error.textContent = session.error.message
      body.appendChild(error)

      const actions = document.createElement('div')
      actions.className = 'transora-sel-error-actions'

      if (session.error.retryable) {
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.className = 'transora-sel-text-btn'
        retry.textContent = '重试'
        retry.addEventListener('click', () => {
          if (session) void run(session.text, session.sourceLang, session.modelId)
        })
        actions.appendChild(retry)
      }

      if (session.error.actions.includes('configure')) {
        const configure = document.createElement('button')
        configure.type = 'button'
        configure.className = 'transora-sel-text-btn'
        configure.textContent = '去配置'
        configure.addEventListener('click', () => {
          hide()
          openApp('models')
        })
        actions.appendChild(configure)
      }

      body.appendChild(actions)
      return body
    }

    const translated = document.createElement('div')
    translated.className = 'transora-sel-translated'
    translated.textContent = session.translated
    body.appendChild(translated)

    return body
  }

  const buildFoot = (): HTMLElement => {
    const foot = document.createElement('footer')
    foot.className = 'transora-sel-foot'

    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'transora-sel-foot-btn'
    copy.innerHTML = `${ICONS.copy}<span>复制</span>`
    copy.addEventListener('click', async () => {
      if (!session?.translated) return
      try {
        await navigator.clipboard.writeText(session.translated)
        copy.classList.add('is-done')
        copy.innerHTML = `${ICONS.check}<span>已复制</span>`
        window.setTimeout(() => {
          copy.classList.remove('is-done')
          copy.innerHTML = `${ICONS.copy}<span>复制</span>`
        }, 1500)
      } catch {
        /* 剪贴板权限被拒时静默 */
      }
    })
    foot.appendChild(copy)

    const sidebar = document.createElement('button')
    sidebar.type = 'button'
    sidebar.className = 'transora-sel-foot-btn'
    sidebar.innerHTML = `${ICONS.sidebar}<span>划词记录</span>`
    sidebar.addEventListener('click', () => {
      openSidebar('records')
      hide()
    })
    foot.appendChild(sidebar)

    const settings = document.createElement('button')
    settings.type = 'button'
    settings.className = 'transora-sel-foot-btn'
    settings.innerHTML = `${ICONS.settings}<span>设置</span>`
    settings.addEventListener('click', () => {
      hide()
      openApp('models')
    })
    foot.appendChild(settings)

    return foot
  }

  function render(): void {
    const visible = session !== null
    container.classList.toggle('transora-sel-card--open', visible)
    if (!visible) {
      container.replaceChildren()
      return
    }

    container.replaceChildren(buildHeader())
    const tabs = buildModelTabs()
    if (tabs) container.appendChild(tabs)
    container.appendChild(buildBody())
    container.appendChild(buildFoot())

    position()
  }

  function hide(): void {
    session = null
    requestSeq += 1
    container.classList.remove('transora-sel-card--open')
    container.replaceChildren()
  }

  function show(text: string, rect: DOMRect | null): void {
    const model = activeModel()
    session = {
      text,
      rect,
      status: 'loading',
      translated: '',
      error: null,
      modelId: model?.id ?? null,
      sourceLang: state.settings.sourceLang,
      targetLang: state.settings.targetLang,
    }
    render()
    void run(text, session.sourceLang, session.modelId)
  }

  render()

  return {
    show,
    hide,
    render,
    isVisible: () => session !== null,
    contains: (node) => Boolean(node && container.contains(node)),
  }
}
