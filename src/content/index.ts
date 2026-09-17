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

import { BATCH } from '@/shared/constants'
import {
  MSG,
  isTransoraMessage,
  type ContentCommand,
  type ContentCommandPayload,
  type PagePlan,
} from '@/shared/messages'
import { applyDisplayMode } from './injector'
import { dispatchCommand } from './actions'
import { collectBlocks } from './extractor'
import { mountSelection } from './selection'
import { emit, hydrateState, state, subscribe, watchStorage, type PageStatus } from './state'
import { mountFab } from './ui/fab'
import { mountSidebar } from './ui/sidebar'
import { mountStatusBar } from './ui/statusbar'

const INIT_FLAG = '__transoraInitialized'

/** 已注入但失败的块数（D6「部分失败」判据） */
function failedCount(): number {
  let count = 0
  state.entries.forEach((entry) => {
    if (entry.error) count += 1
  })
  return count
}

/**
 * D3「翻译前确认」的输入：待翻译块数 / 总字数 / 批次数。
 * 只统计**还没翻过的块**（已注入的不重复计费），切分口径与 docs/00 §D-2 一致。
 */
function buildPlan(): PagePlan {
  const skip = new WeakSet<HTMLElement>()
  state.entries.forEach((_entry, el) => skip.add(el))

  const blocks = collectBlocks(document, { skip })
  const chars = blocks.reduce((sum, block) => sum + block.text.length, 0)
  const batches = Math.max(
    1,
    Math.ceil(blocks.length / BATCH.MAX_BLOCKS),
    Math.ceil(chars / BATCH.MAX_CHARS),
  )

  return { blocks: blocks.length, chars, batches }
}

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
  const statusBar = mountStatusBar(root)
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
    statusBar.render()
    selection.render()

    // 翻译完成 → 悬浮按钮短暂显示完成角标
    if (previousStatus === 'translating' && state.status !== 'translating') {
      fab.markCompleted(state.lastRunFailed)
    }
    previousStatus = state.status
  })

  // Background / Popup 指令入口（Popup / 右键菜单 / 快捷键）
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isTransoraMessage(message)) return undefined

    if (message.type === MSG.CMD) {
      const cmd = message as unknown as { command: ContentCommand; payload?: ContentCommandPayload }
      dispatchCommand(cmd.command, cmd.payload)
      sendResponse({ ok: true })
      return undefined
    }

    if (message.type === MSG.PAGE_STATUS) {
      sendResponse({
        available: true,
        status: state.status,
        progress: state.progress,
        entryCount: state.entries.size,
        failedCount: failedCount(),
        cancellable: state.status === 'translating',
        plan: state.status === 'translating' ? undefined : buildPlan(),
      })
      return undefined
    }

    return undefined
  })

  emit()
}

void boot()
