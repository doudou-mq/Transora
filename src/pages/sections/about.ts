/**
 * 区块四：关于（F6）
 *
 * 版本口径（docs/00 §C3）：产品版本与设计稿版本是两套号，界面不得混用。
 * 权限清单（docs/00 §C2）：已去掉 sidePanel。
 * 反馈入口（docs/00 §D-7）：无后端，只做外链跳转，不使用表单提交。
 */

import { DESIGN_VERSION, PRODUCT_VERSION, el } from '../store'

const PERMISSIONS: Array<[string, string]> = [
  ['storage', '保存模型配置、设置与翻译缓存'],
  ['contextMenus', '选中文字后的右键「翻译选中文本」入口'],
  ['activeTab', '在用户主动操作时识别当前标签页（非必需路径）'],
  ['scripting', '可选增强：动态注入场景下的兜底手段'],
  ['host_permissions: <all_urls>', '向任意网页注入对照译文；向你自己配置的模型接口发起请求'],
]

const SHORTCUTS: Array<[string, string]> = [
  ['Alt + Shift + S', '翻译本页 / 恢复原文'],
  ['Alt + Shift + T', '翻译选中文本'],
  ['Alt + Shift + R', '打开 / 关闭侧边栏'],
]

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

export function renderAbout(): HTMLElement {
  const container = el('div', 'section')

  /* ---------- 版本 ---------- */
  const hero = el('div', 'tr-card about-hero')
  const brand = el('div', 'about-brand')
  brand.appendChild(el('span', 'about-dot'))
  brand.appendChild(el('span', 'about-name', 'Transora'))
  hero.appendChild(brand)
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

  /* ---------- 隐私 ---------- */
  container.appendChild(
    section('隐私说明', (body) => {
      body.appendChild(el('p', 'about-lead', '不收集、不上传、无账号。'))
      const list = el('ul', 'about-list')
      for (const line of [
        'API Key 只保存在本机浏览器存储，不打印到日志，不发送到除你配置的模型服务之外的任何地址',
        '翻译请求由扩展的后台直接发往你填写的接口地址，不经过任何中间服务器',
        '翻译历史与缓存只存在本机，可随时清除',
        '扩展不读取与翻译无关的页面内容，不做任何埋点统计',
      ]) {
        list.appendChild(el('li', undefined, line))
      }
      body.appendChild(list)
    }),
  )

  /* ---------- 快捷键 ---------- */
  container.appendChild(
    section('快捷键', (body) => {
      body.appendChild(definitionList(SHORTCUTS))
      const hint = el('p', 'about-footnote')
      hint.textContent = '可在浏览器扩展快捷键页面自行改键。与浏览器自带快捷键冲突时不特殊避让。'
      body.appendChild(hint)
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

  /* ---------- 反馈 ---------- */
  container.appendChild(
    section('反馈与支持', (body) => {
      body.appendChild(
        el('p', 'about-lead', '没有后端与账号体系，因此不设表单提交，反馈走外链。'),
      )
      const list = el('div', 'def-list')
      list.appendChild(
        el(
          'div',
          'def-item',
          '问题反馈：请在项目仓库提交 Issue（附上浏览器版本与复现步骤最快）',
        ),
      )
      list.appendChild(el('div', 'def-item', '功能建议：同样欢迎在仓库开 Issue 讨论'))
      body.appendChild(list)
    }),
  )

  return container
}
