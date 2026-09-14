/**
 * G5 划词内容块
 *
 * 形态（S5 / docs/00 §A1 / X6）：**只做单模型译文**，不含并排对比（对比只在侧边栏 Slide）。
 * 自上而下五段（与 S5 的元素表一一对应）：
 *   ① 头部     选中原文片段（超长截断，点击可展开）+ 右上角关闭 ×
 *   ② 译文区   默认英译中译文（15px ink）；加载中 = Skeleton；失败 = 砖红左条 + 重试
 *   ③ 元信息行 模型名 chip + 耗时 + token 用量 + 语言对
 *   ④ Tab 栏   供应商 Tab + 大模型 Tab —— 切换即用该模型重新翻译这一段
 *   ⑤ 动作行   设置 · 打开侧边栏 · 复制译文（右侧 Esc 关闭提示）
 *
 * 未配置模型时（S6 / docs/00 §D-4）：**只把译文区换成引导卡**，头部与动作行保留。
 *
 * 旧叫法「划词浮层」已废弃（docs/07）。
 */

import { SELECTION, SIDEBAR_WIDTH, Z } from '@/shared/constants'
import { langDisplayName, langShortName } from '@/shared/langs'
import { groupByProvider, type ProviderGroup } from '@/shared/providers'
import type { ErrorInfo, ModelConfig } from '@/shared/types'
import { openApp, openSidebar, translateSelectionText } from '../actions'
import { activeModel, isUnconfigured, state } from '../state'
import { createGuideCard } from './guide-card'
import { ICONS } from './icons'
import { toast } from './toast'

const VIEWPORT_GAP = 12
/** 译文区最大高度：超出滚动，避免长段落把内容块拉到屏幕外 */
const TX_MAX_HEIGHT = 260

type CardStatus = 'guide' | 'loading' | 'done' | 'error'

interface CardSession {
  text: string
  /** 内容块锚定的矩形（跟随图标的位置） */
  rect: DOMRect | null
  status: CardStatus
  translated: string
  error: ErrorInfo | null
  modelId: string | null
  /** 当前供应商分组键（由 modelId 反推，切换供应商时用） */
  providerKey: string | null
  sourceLang: string
  targetLang: string
  /** G5 元信息行 */
  latencyMs: number
  totalTokens: number
  /** 头部原文是否已展开 */
  expanded: boolean
}

export interface SelectionCardHooks {
  /** 鼠标进入 / 离开内容块（留给调用方做 hover 接力，当前无需自动收起） */
  onHoverChange?: (inside: boolean) => void
}

export interface SelectionCardController {
  show: (text: string, rect: DOMRect | null) => void
  hide: () => void
  render: () => void
  isVisible: () => boolean
  /** 供「点击外部关闭」判定 */
  contains: (node: Node | null) => boolean
}

/** 语言对展示：`英 → 中`（S5 / G5 元信息行） */
function langPair(source: string, target: string): string {
  return `${langShortName(source)} → ${langShortName(target)}`
}

/** 耗时展示：不足 1s 给毫秒，超过给一位小数秒（0.8s / 1.4s） */
function formatLatency(ms: number): string {
  if (ms <= 0) return ''
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function mountSelectionCard(
  root: HTMLElement,
  hooks: SelectionCardHooks = {},
): SelectionCardController {
  const container = document.createElement('div')
  container.className = 'transora-sel-card'
  container.setAttribute('data-transora', 'selection-card')
  container.style.zIndex = String(Z.selectionCard)
  root.appendChild(container)

  container.addEventListener('mouseenter', () => hooks.onHoverChange?.(true))
  container.addEventListener('mouseleave', () => hooks.onHoverChange?.(false))

  let session: CardSession | null = null
  let requestSeq = 0

  /* ---------------------------------------------------------------- */
  /* 定位：锚定跟随图标，空间不足时翻转                                  */
  /* ---------------------------------------------------------------- */

  const position = (): void => {
    if (!session) return
    const rect = session.rect

    // 侧边栏占据右侧，内容块只在剩余区域内定位
    const reserved = state.sidebarOpen ? SIDEBAR_WIDTH : 0
    const available = Math.max(260, window.innerWidth - reserved)
    const width = Math.min(SELECTION.cardWidth, available - VIEWPORT_GAP * 2)
    const height = container.offsetHeight || 200

    container.style.width = `${width}px`

    let left: number
    let top: number

    if (rect) {
      // 锚定图标：默认落在图标正下方，右侧贴紧可视区
      left = Math.min(rect.left, available - width - VIEWPORT_GAP)
      top = rect.bottom + 8
      if (top + height > window.innerHeight - VIEWPORT_GAP) {
        // 下方放不下 → 翻到图标上方
        top = Math.max(VIEWPORT_GAP, rect.top - height - 8)
      }
    } else {
      left = Math.max(VIEWPORT_GAP, available / 2 - width / 2)
      top = 120
    }

    left = Math.max(VIEWPORT_GAP, left)

    container.style.left = `${Math.round(left)}px`
    container.style.top = `${Math.round(top)}px`
  }

  /* ---------------------------------------------------------------- */
  /* 请求                                                            */
  /* ---------------------------------------------------------------- */

  const run = async (text: string, modelId: string | null): Promise<void> => {
    const seq = ++requestSeq
    if (!session) return
    session.status = 'loading'
    session.translated = ''
    session.error = null
    session.latencyMs = 0
    session.totalTokens = 0
    render()

    const startedAt = Date.now()
    const result = await translateSelectionText(
      text,
      session.sourceLang,
      modelId ?? undefined,
    )
    // 期间用户又发起了一次请求，丢弃这次结果
    if (seq !== requestSeq || !session) return

    if (result.ok) {
      session.status = 'done'
      session.translated = result.translatedText
      // Background 未回传时用本地计时兜底，保证元信息行不会是空的
      session.latencyMs = result.latencyMs || Date.now() - startedAt
      session.totalTokens = result.totalTokens
    } else {
      session.status = 'error'
      session.error = result.error
    }
    render()
  }

  /* ---------------------------------------------------------------- */
  /* ① 头部 + ② 译文区 + ③ 元信息行                                    */
  /* ---------------------------------------------------------------- */

  const buildHead = (): HTMLElement => {
    const head = document.createElement('div')
    head.className = 'transora-sel-head'

    const title = document.createElement('button')
    title.type = 'button'
    title.className = 'transora-sel-title'
    title.textContent = session?.text ?? ''
    title.title = session?.text ?? ''
    if (session?.expanded) title.classList.add('transora-sel-title--expanded')
    title.addEventListener('click', () => {
      if (!session) return
      session.expanded = !session.expanded
      render()
    })
    head.appendChild(title)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'transora-sel-close'
    close.title = '关闭'
    close.setAttribute('aria-label', '关闭')
    close.innerHTML = ICONS.close
    close.addEventListener('click', () => hide())
    head.appendChild(close)

    return head
  }

  const buildLoading = (): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.className = 'transora-sel-load'

    const head = document.createElement('div')
    head.className = 'transora-sel-load-head'
    const label = document.createElement('span')
    label.className = 'transora-sel-load-label'
    label.textContent = langDisplayName(session?.targetLang ?? state.settings.targetLang) + '译文'
    const state_ = document.createElement('span')
    state_.className = 'transora-sel-load-state'
    state_.textContent = '翻译中…'
    head.append(label, state_)
    wrap.appendChild(head)

    for (const width of ['100%', '86%', '55%']) {
      const bar = document.createElement('i')
      bar.className = 'transora-sel-bar'
      bar.style.width = width
      wrap.appendChild(bar)
    }

    return wrap
  }

  const buildError = (error: ErrorInfo): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.className = 'transora-sel-fail'

    const head = document.createElement('div')
    head.className = 'transora-sel-fail-head'

    const label = document.createElement('span')
    label.className = 'transora-sel-fail-label'
    label.textContent = '翻译失败'
    head.appendChild(label)

    if (error.retryable) {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'transora-sel-fail-act'
      retry.textContent = '重试'
      retry.addEventListener('click', () => {
        if (session) void run(session.text, session.modelId)
      })
      head.appendChild(retry)
    } else if (error.actions.includes('configure')) {
      const configure = document.createElement('button')
      configure.type = 'button'
      configure.className = 'transora-sel-fail-act'
      configure.textContent = '去配置'
      configure.addEventListener('click', () => {
        hide()
        openApp('models')
      })
      head.appendChild(configure)
    }

    wrap.appendChild(head)

    const message = document.createElement('div')
    message.className = 'transora-sel-fail-msg'
    message.textContent = error.message
    wrap.appendChild(message)

    return wrap
  }

  const buildMeta = (): HTMLElement | null => {
    if (!session || session.status !== 'done') return null

    const meta = document.createElement('div')
    meta.className = 'transora-sel-meta'

    // 模型名 chip（展示名，取自配置里的 name）
    const model = state.models.find((m) => m.id === session?.modelId) ?? activeModel()
    if (model) {
      const chip = document.createElement('span')
      chip.className = 'transora-sel-meta-model'
      chip.textContent = model.name
      chip.title = model.model
      meta.appendChild(chip)
    }

    const latency = formatLatency(session.latencyMs)
    if (latency) {
      const stat = document.createElement('span')
      stat.className = 'transora-sel-meta-stat'
      stat.textContent = session.totalTokens > 0 ? `${latency} · ${session.totalTokens} tok` : latency
      meta.appendChild(stat)
    }

    // 语言对：点击跳「新标签页 · 通用设置」的目标语言项（S5 元素表）
    const pair = document.createElement('button')
    pair.type = 'button'
    pair.className = 'transora-sel-meta-lang'
    pair.textContent = langPair(session.sourceLang, session.targetLang)
    pair.title = '修改目标语言'
    pair.addEventListener('click', () => {
      hide()
      openApp('general')
    })
    meta.appendChild(pair)

    return meta
  }

  const buildTx = (): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.className = 'transora-sel-tx'
    wrap.style.maxHeight = `${TX_MAX_HEIGHT}px`

    if (!session) return wrap

    if (session.status === 'guide') {
      wrap.appendChild(
        createGuideCard({
          compact: true,
          onConfigure: () => {
            hide()
            openApp('models')
          },
        }),
      )
      return wrap
    }

    if (session.status === 'loading') {
      wrap.appendChild(buildLoading())
      return wrap
    }

    if (session.status === 'error' && session.error) {
      wrap.appendChild(buildError(session.error))
      return wrap
    }

    // 主视觉译文：15px ink，不带橙色左条（S5 ②）
    const translated = document.createElement('div')
    translated.className = 'transora-sel-translated'
    translated.textContent = session.translated
    wrap.appendChild(translated)

    return wrap
  }

  /* ---------------------------------------------------------------- */
  /* ④ 供应商 / 模型 两级切换                                           */
  /* ---------------------------------------------------------------- */

  function groups(): ProviderGroup[] {
    return groupByProvider(state.models)
  }

  const buildSwitch = (): HTMLElement | null => {
    if (!session || session.status === 'guide') return null
    const all = groups()
    if (all.length === 0) return null

    const current: ModelConfig | null =
      state.models.find((m) => m.id === session?.modelId) ?? activeModel()
    const currentProvider = current
      ? (all.find((g) => g.models.some((m) => m.id === current.id)) ?? all[0])
      : all[0]

    const box = document.createElement('div')
    box.className = 'transora-sel-switch'

    /* 供应商 */
    const providerRow = document.createElement('div')
    providerRow.className = 'transora-sel-switch-row'

    const providerLabel = document.createElement('span')
    providerLabel.className = 'transora-sel-switch-label'
    providerLabel.textContent = '供应商'
    providerRow.appendChild(providerLabel)

    const pills = document.createElement('div')
    pills.className = 'transora-sel-pills'
    for (const group of all) {
      const pill = document.createElement('button')
      pill.type = 'button'
      pill.className = 'transora-sel-pill'
      pill.textContent = group.label
      if (group.key === currentProvider.key) pill.classList.add('is-active')
      pill.addEventListener('click', () => {
        if (!session || group.key === currentProvider.key) return
        // 换供应商 → 用它下面的第一个模型重新翻译
        const next = group.models[0]
        if (!next) return
        session.modelId = next.id
        session.providerKey = group.key
        void run(session.text, next.id)
      })
      pills.appendChild(pill)
    }
    providerRow.appendChild(pills)
    box.appendChild(providerRow)

    /* 模型 */
    const modelRow = document.createElement('div')
    modelRow.className = 'transora-sel-switch-row'

    const modelLabel = document.createElement('span')
    modelLabel.className = 'transora-sel-switch-label'
    modelLabel.textContent = '模型'
    modelRow.appendChild(modelLabel)

    const chips = document.createElement('div')
    chips.className = 'transora-sel-chips'
    for (const model of currentProvider.models) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'transora-sel-chip'
      chip.textContent = model.model
      chip.title = model.name
      if (model.id === current?.id) chip.classList.add('is-active')
      chip.addEventListener('click', () => {
        if (!session || model.id === session.modelId) return
        session.modelId = model.id
        session.providerKey = currentProvider.key
        void run(session.text, model.id)
      })
      chips.appendChild(chip)
    }
    modelRow.appendChild(chips)
    box.appendChild(modelRow)

    return box
  }

  /* ---------------------------------------------------------------- */
  /* ⑤ 动作行                                                         */
  /* ---------------------------------------------------------------- */

  const buildFoot = (): HTMLElement => {
    const foot = document.createElement('footer')
    foot.className = 'transora-sel-foot'

    const settings = document.createElement('button')
    settings.type = 'button'
    settings.className = 'transora-sel-act'
    settings.textContent = '设置'
    settings.addEventListener('click', () => {
      hide()
      openApp('models')
    })
    foot.appendChild(settings)

    const sidebar = document.createElement('button')
    sidebar.type = 'button'
    sidebar.className = 'transora-sel-act'
    sidebar.textContent = '打开侧边栏'
    sidebar.addEventListener('click', () => {
      openSidebar('records')
      hide()
    })
    foot.appendChild(sidebar)

    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'transora-sel-act'
    copy.textContent = '复制译文'
    copy.addEventListener('click', async () => {
      if (!session?.translated) return
      try {
        await navigator.clipboard.writeText(session.translated)
        // S5：复制成功给 Toast 反馈
        toast('已复制译文', 'success')
      } catch {
        toast('复制失败，请检查剪贴板权限', 'error')
      }
    })
    foot.appendChild(copy)

    const grow = document.createElement('span')
    grow.className = 'transora-sel-foot-grow'
    foot.appendChild(grow)

    const esc = document.createElement('span')
    esc.className = 'transora-sel-esc'
    esc.textContent = 'Esc 关闭'
    foot.appendChild(esc)

    return foot
  }

  /* ---------------------------------------------------------------- */
  /* 渲染                                                            */
  /* ---------------------------------------------------------------- */

  function render(): void {
    const visible = session !== null
    container.classList.toggle('transora-sel-card--open', visible)
    if (!visible) {
      container.replaceChildren()
      return
    }

    const main = document.createElement('div')
    main.className = 'transora-sel-main'
    main.appendChild(buildHead())

    const rule = document.createElement('div')
    rule.className = 'transora-sel-rule'
    main.appendChild(rule)

    main.appendChild(buildTx())

    const meta = buildMeta()
    if (meta) main.appendChild(meta)

    const parts: HTMLElement[] = [main]
    const switcher = buildSwitch()
    if (switcher) parts.push(switcher)
    parts.push(buildFoot())

    container.replaceChildren(...parts)

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
      status: model ? 'loading' : 'guide',
      translated: '',
      error: null,
      modelId: model?.id ?? null,
      providerKey: null,
      sourceLang: state.settings.sourceLang,
      targetLang: state.settings.targetLang,
      latencyMs: 0,
      totalTokens: 0,
      expanded: false,
    }
    render()
    // 未配置模型时不发请求，直接由引导卡接管（docs/00 §D-4）
    if (model && !isUnconfigured()) void run(text, session.modelId)
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
