import { defineManifest } from '@crxjs/vite-plugin'

/**
 * manifest 定义 —— 与 docs/00-确认方案.md §F-3 严格一致。
 *
 * 三条硬约束来自阶段 0 技术验证结论（docs/00 §六）：
 *  1. 不依赖 `document_start`，content script 使用 `document_idle`；
 *  2. 不申请 `sidePanel`（侧边栏为内容脚本自绘 DOM，见 §A3②）；
 *  3. `activeTab` / `scripting` 保留声明但**不作为功能前提**，
 *     核心链路（翻译 / 划词 / 侧边栏）全部走常驻 content script + 消息驱动，
 *     即便 360 侧发生权限熔断也不影响主功能。
 */
export default defineManifest({
  manifest_version: 3,
  name: 'Transora',
  short_name: 'Transora',
  description: '基于大模型的网页翻译：整页双语对照、划词翻译、多模型对比。不内置模型，由你接入自己的 OpenAI 兼容服务。',
  version: '0.1.0',

  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },

  action: {
    default_title: 'Transora',
    default_popup: 'src/popup/index.html',
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
    },
  },

  /** 「新标签页」= 扩展独立页（不是 chrome://newtab，见 docs/07 判据 2） */
  options_page: 'src/pages/index.html',

  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },

  /**
   * 静态声明式注入优先（docs/00 §G-1）：
   * 不依赖 chrome.scripting 动态注入，规避 360 权限熔断。
   */
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],

  permissions: ['storage', 'contextMenus', 'activeTab', 'scripting'],

  /**
   * 必须为 <all_urls>：① 全文翻译需注入任意网页；
   * ② Background 需向用户**任意**配置的模型接口发起请求，无法事前枚举域名。
   */
  host_permissions: ['<all_urls>'],

  /** docs/00 §D-5 冻结键位 */
  commands: {
    'toggle-translate': {
      suggested_key: { default: 'Alt+Shift+S' },
      description: '翻译本页 / 恢复原文',
    },
    'translate-selection': {
      suggested_key: { default: 'Alt+Shift+T' },
      description: '翻译选中文本',
    },
    'toggle-sidebar': {
      suggested_key: { default: 'Alt+Shift+R' },
      description: '打开 / 关闭侧边栏',
    },
    /** H1 / F6：切换 对照 / 译文 / 原文 */
    'toggle-display-mode': {
      suggested_key: { default: 'Alt+Shift+M' },
      description: '切换 对照 / 译文 / 原文',
    },
  },

  minimum_chrome_version: '111',
})
