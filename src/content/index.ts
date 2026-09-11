/**
 * 内容脚本入口。
 *
 * 关键约束（docs/00 §G-1 阶段 0 结论）：
 *  - `run_at: document_idle`，且初始化必须**幂等**（扩展被重复注入时不重复挂载 UI）；
 *  - 不依赖 `document_start`、不依赖 `chrome.scripting` 动态注入；
 *  - 样式通过 manifest 声明的 CSS 注入（构建插件把下面的 import 写进 content_scripts.css），
 *    走扩展 CSS 通道，不受宿主页面 CSP 的 `style-src` 限制（docs/00 §G-3 风险 3）。
 */

import './styles.css'

import { MSG, isTransoraMessage, type ContentCommand } from '@/shared/messages'
import { applyDisplayMode } from './injector'
import { dispatchCommand } from './actions'
import { mountSelection } from './selection'
import { emit, hydrateState, state, subscribe, watchStorage, type PageStatus } from './state'
import { mountFab } from './ui/fab'
import { mountSidebar } from './ui/sidebar'

const INIT_FLAG = '__transoraInitialized'

async function boot(): Promise<void> {
  const globalScope = window as unknown as Record<string, unknown>
  if (globalScope[INIT_FLAG]) return
  globalScope[INIT_FLAG] = true

  // 所有注入 UI 的统一挂载点：固定定位、零尺寸、不参与宿主页面布局
  const root = document.createElement('div')
  root.className = 'transora-root'
  root.setAttribute('data-transora', 'root')
  document.documentElement.appendChild(root)

  const fab = mountFab(root)
  const sidebar = mountSidebar(root)
  const selection = mountSelection(root)

  await hydrateState()
  watchStorage()
  applyDisplayMode(state.settings.displayMode)

  // 状态变更 → 重绘注入 UI
  let previousStatus: PageStatus = state.status
  subscribe(() => {
    // 根节点状态 class：侧边栏让位（悬浮按钮左移）等由 CSS 消费
    document.documentElement.classList.toggle('transora-sidebar-open', state.sidebarOpen)

    fab.render()
    sidebar.render()
    selection.render()

    // 翻译完成 → 悬浮按钮短暂显示完成角标
    if (previousStatus === 'translating' && state.status === 'translated') {
      fab.markCompleted()
    }
    previousStatus = state.status
  })

  // Background / Popup 指令入口（Popup / 右键菜单 / 快捷键）
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isTransoraMessage(message)) return undefined

    if (message.type === MSG.CMD) {
      dispatchCommand((message as unknown as { command: ContentCommand }).command)
      sendResponse({ ok: true })
      return undefined
    }

    if (message.type === MSG.PAGE_STATUS) {
      sendResponse({
        available: true,
        status: state.status,
        progress: state.progress,
        entryCount: state.entries.size,
      })
      return undefined
    }

    return undefined
  })

  emit()
}

void boot()
