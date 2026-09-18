/**
 * 区块四：关于（F6）
 *
 * 结构对齐设计稿 F6 的五张卡片：版本信息 / 快捷键一览 / 更新说明 / 隐私声明 / 开源许可与反馈，
 * 页首一枚「已是最新版本」状态胶囊。
 *
 * 版本口径（docs/00 §C3，**三轨不得混用**）：
 *   设计稿 v1.0 ｜ 产品版本 = manifest.version = 0.2.0 ｜ manifest_version = 3。
 *   阶段 1 交付物 = 0.1.0，阶段 2 交付物 = 0.2.0（docs/00 §四 · C3①）。
 * 设计稿图上写的是 `v0.2.0` / `v0.2`，那属于设计稿那一条轨 —— 界面上一律显示产品版本。
 * 权限清单（docs/00 §C2）：已去掉 sidePanel。
 * 反馈入口（docs/00 §D-7）：无后端，只做外链跳转，不使用表单提交。
 */

import { DESIGN_VERSION, PRODUCT_VERSION, el } from '../store'

const PERMISSIONS: Array<[string, string]> = [
  ['storage', '保存模型配置、设置与翻译缓存'],
  ['contextMenus', '选中文字后的右键菜单：翻译选中内容 / 整页双语对照 / 复制原文 / 复制译文'],
  ['activeTab', '在用户主动操作时识别当前标签页（非必需路径）'],
  ['scripting', '可选增强：动态注入场景下的兜底手段'],
  ['host_permissions: <all_urls>', '向任意网页注入对照译文；向你自己配置的模型接口发起请求'],
]

/** 键位与 docs/00 §D-5 冻结口径一致（S = 翻译本页，T = 划词），并与 H1 右键菜单对齐 */
const SHORTCUTS: Array<[string, string]> = [
  ['Alt + Shift + S', '翻译本页 / 恢复原文'],
  ['Alt + Shift + T', '翻译选中文本'],
  ['Alt + Shift + R', '打开 / 关闭侧边栏'],
  ['Alt + Shift + M', '切换 对照 / 译文 / 原文'],
]

/** 更新说明：只列真实发布过的版本 + 一组「规划中」，不写未发布版本的假条目 */
const CHANGELOG: Array<[string, string, string]> = [
  [
    `v${PRODUCT_VERSION} · 2026-09-18`,
    '当前版本',
    '阶段 2：多模型对比（侧边栏多列并排 + 逐块卡片 + 单选应用该模型译文）、'
      + '翻译历史（IndexedDB · 搜索筛选 · 导出 JSON / Markdown）、侧边栏「划词记录」Tab。',
  ],
  [
    'v0.1.0 · 2026-09-10',
    '阶段 1',
    '首个版本：整页双语对照（含 Sticky 状态栏与工具栏角标）、恢复原文、划词翻译、多模型配置、'
      + '新标签页（模型配置 / 通用设置 / 翻译历史 / 关于 Transora）。',
  ],
  [
    '规划中',
    '阶段 3',
    // 已上线项不得再挂在这里：G6 于 2026-09-17 落地、F1–F5 于 2026-09-18 落地；SPA 动态补翻（FR-11）
    // 按 docs/05 属**阶段 3**（此前误标阶段 2，与 README / docs/05 口径相左）。
    'SPA 动态补翻（FR-11）、混合式对比、快捷键自定义。',
  ],
]

const PRIVACY: string[] = [
  '不注册账号、不采集身份信息',
  'API Key 与翻译记录仅存本机（扩展 storage）',
  '无远程日志、无行为上报、无第三方统计',
  '译文请求直连你配置的 OpenAI 兼容接口，不经过任何中转服务器',
]

const LICENSES = '界面字体 Inter（OFL）· Noto Sans SC（OFL）· JetBrains Mono（OFL）；图标为项目自有 SVG。'

const LIMITS: string[] = [
  '关闭的 Shadow DOM 内部内容无法翻译',
  '跨域 iframe 内的内容无法注入',
  'canvas / 图片中的文字不处理（本项目不做 OCR）',
  '需要 Chromium 111 及以上内核；旧内核不支持 MV3，扩展无法加载',
]

function section(title: string, build: (body: HTMLElement) => void): HTMLElement {
  const card = el('div', 'tr-card settings-card')
  card.appendChild(el('div', 'settings-group-title', title))
  const body = el('div', 'about-body')
  build(body)
  card.appendChild(body)
  return card
}

function definitionList(items: Array<[string, string]>): HTMLElement {
  const list = el('div', 'def-list')
  for (const [name, desc] of items) {
    const item = el('div', 'def-item')
    item.appendChild(el('div', 'def-name tr-mono', name))
    item.appendChild(el('div', 'def-desc', desc))
    list.appendChild(item)
  }
  return list
}

/** 卡内的一行「名称 · 值」（F6 版本信息 / 快捷键一览用的是这种紧凑行） */
function infoRow(name: string, value: string): HTMLElement {
  const line = el('div', 'about-row')
  line.appendChild(el('span', 'about-row-name', name))
  line.appendChild(el('span', 'about-row-value tr-mono', value))
  return line
}

export function renderAbout(): HTMLElement {
  const container = el('div', 'section')

  /* ---------- 页首：品牌 + 版本胶囊 ---------- */
  const hero = el('div', 'tr-card about-hero')
  const heroHead = el('div', 'about-hero-head')

  const brand = el('div', 'about-brand')
  brand.appendChild(el('span', 'about-dot'))
  brand.appendChild(el('span', 'about-name', 'Transora'))
  heroHead.appendChild(brand)
  heroHead.appendChild(el('span', 'tr-pill tr-pill--done', '已是最新版本'))
  hero.appendChild(heroHead)

  hero.appendChild(
    el(
      'p',
      'about-tagline',
      '基于大模型的网页翻译扩展。不内置模型、不中转请求、不做账号体系 —— 翻译由你自己配置的模型直接完成，数据留在本地。',
    ),
  )

  const versions = el('div', 'about-versions')
  versions.appendChild(el('span', 'tr-pill tr-pill--accent', `产品版本 v${PRODUCT_VERSION}`))
  versions.appendChild(el('span', 'tr-pill', `设计稿版本 ${DESIGN_VERSION}`))
  versions.appendChild(el('span', 'tr-pill', 'Manifest V3'))
  hero.appendChild(versions)

  container.appendChild(hero)

  /* ---------- 版本信息 + 快捷键一览（并排两卡） ---------- */
  const pair = el('div', 'about-pair')

  pair.appendChild(
    section('版本信息', (body) => {
      body.appendChild(infoRow('版本', `v${PRODUCT_VERSION}`))
      body.appendChild(infoRow('清单版本', 'Manifest V3'))
      body.appendChild(infoRow('构建日期', __TRANSORA_BUILD_DATE__))
      body.appendChild(
        infoRow(
          '权限范围',
          'storage · activeTab · contextMenus · scripting（另需网页注入与接口访问授权）',
        ),
      )
      body.appendChild(
        el('p', 'about-footnote', '无远程上报；翻译请求由浏览器直连你配置的接口。'),
      )
    }),
  )

  pair.appendChild(
    section('快捷键一览', (body) => {
      for (const [keys, desc] of SHORTCUTS) body.appendChild(infoRow(desc, keys))
      body.appendChild(
        el(
          'p',
          'about-footnote',
          '与 H1 右键菜单的快捷键保持一致，可在浏览器扩展快捷键页面改键。与浏览器自带快捷键冲突时不特殊避让。',
        ),
      )
    }),
  )

  container.appendChild(pair)

  /* ---------- 更新说明 + 隐私声明（并排两卡） ---------- */
  const pair2 = el('div', 'about-pair')

  pair2.appendChild(
    section('更新说明', (body) => {
      for (const [label, tag, desc] of CHANGELOG) {
        const head = el('div', 'about-row')
        head.appendChild(el('span', 'about-row-name', label))
        head.appendChild(el('span', 'about-row-tag', tag))
        body.appendChild(head)
        body.appendChild(el('p', 'about-footnote', desc))
      }
    }),
  )

  pair2.appendChild(
    section('隐私声明', (body) => {
      const list = el('ul', 'about-list')
      for (const line of PRIVACY) list.appendChild(el('li', undefined, line))
      body.appendChild(list)
    }),
  )

  container.appendChild(pair2)

  /* ---------- 开源许可与反馈 ---------- */
  container.appendChild(
    section('开源许可与反馈', (body) => {
      const line = el('div', 'about-license')
      line.appendChild(el('p', 'about-footnote', LICENSES))

      const actions = el('div', 'about-license-actions')

      const licenses = el('button', 'tr-btn tr-btn--sm', '查看许可证')
      licenses.type = 'button'
      licenses.addEventListener('click', () => {
        licenses.textContent = 'OFL 全文随包附于 third_party_licenses/'
        window.setTimeout(() => {
          if (licenses.isConnected) licenses.textContent = '查看许可证'
        }, 2600)
      })
      actions.appendChild(licenses)

      const docs = el('button', 'tr-btn tr-btn--sm', '使用文档')
      docs.type = 'button'
      docs.addEventListener('click', () => {
        docs.textContent = '仓库 README 与 docs/ 目录即为使用文档'
        window.setTimeout(() => {
          if (docs.isConnected) docs.textContent = '使用文档'
        }, 2600)
      })
      actions.appendChild(docs)

      // 无后端与账号体系，因此不做表单提交，反馈走外链入口
      const feedback = el('button', 'tr-btn tr-btn--sm tr-btn--primary', '反馈问题')
      feedback.type = 'button'
      feedback.addEventListener('click', () => {
        feedback.textContent = '请在项目仓库提交 Issue（附浏览器版本与复现步骤最快）'
        window.setTimeout(() => {
          if (feedback.isConnected) feedback.textContent = '反馈问题'
        }, 3200)
      })
      actions.appendChild(feedback)

      line.appendChild(actions)
      body.appendChild(line)
    }),
  )

  /* ---------- 权限 ---------- */
  container.appendChild(
    section('权限范围', (body) => {
      body.appendChild(
        el(
          'p',
          'about-lead',
          '扩展申请以下权限。没有一项用于收集你的数据，全部服务于「翻译当前网页」这一件事。',
        ),
      )
      body.appendChild(definitionList(PERMISSIONS))
    }),
  )

  /* ---------- 已知限制 ---------- */
  container.appendChild(
    section('已知限制', (body) => {
      const list = el('ul', 'about-list')
      for (const line of LIMITS) list.appendChild(el('li', undefined, line))
      body.appendChild(list)
    }),
  )

  return container
}
