/**
 * 新标签页 SPA 外壳 —— 四个区块：模型配置 / 通用设置 / 翻译历史 / 关于。
 *
 * 这个页面就是安装后的落地页（X5 / docs/00 §C1）：首次安装自动打开并定位到「模型配置」，
 * 但引导流程（C1–C4）只作为**页内轻量步骤提示**，不强制走完。
 */

import '@/shared/tokens.css'
import './pages.css'

import { STORAGE_KEYS } from '@/shared/constants'
import { bindReload, el, loadState } from './store'
import { renderAbout } from './sections/about'
import { renderGeneral } from './sections/general'
import { renderHistory } from './sections/history'
import { renderModels } from './sections/models'

const app = document.getElementById('app') as HTMLElement

interface SectionMeta {
  key: string
  label: string
  desc: string
  render: () => HTMLElement
}

const SECTIONS: SectionMeta[] = [
  { key: 'models', label: '模型配置', desc: '接入你自己的 OpenAI 兼容服务', render: renderModels },
  { key: 'general', label: '通用设置', desc: '语言、显示模式与缓存', render: renderGeneral },
  { key: 'history', label: '翻译历史', desc: '本机保存的全部翻译记录', render: renderHistory },
  { key: 'about', label: '关于', desc: '版本、权限与隐私', render: renderAbout },
]

function currentKey(): string {
  const key = window.location.hash.replace(/^#/, '')
  return SECTIONS.some((s) => s.key === key) ? key : 'models'
}

function buildNav(activeKey: string): HTMLElement {
  const nav = el('nav', 'nav')

  const brand = el('div', 'nav-brand')
  brand.appendChild(el('span', 'nav-brand-dot'))
  brand.appendChild(el('span', 'nav-brand-name', 'Transora'))
  nav.appendChild(brand)

  const list = el('div', 'nav-list')
  for (const section of SECTIONS) {
    const button = el('button', 'nav-item')
    button.type = 'button'
    button.appendChild(el('span', 'nav-item-label', section.label))
    button.appendChild(el('span', 'nav-item-desc', section.desc))
    if (section.key === activeKey) button.classList.add('is-active')
    button.addEventListener('click', () => {
      window.location.hash = section.key
    })
    list.appendChild(button)
  }
  nav.appendChild(list)

  const foot = el('div', 'nav-foot')
  foot.textContent = '数据全部保存在本机 · 无账号 · 不上传'
  nav.appendChild(foot)

  return nav
}

function render(): void {
  const key = currentKey()
  const section = SECTIONS.find((s) => s.key === key) as SectionMeta

  const main = el('main', 'main')
  const header = el('header', 'main-header')
  header.appendChild(el('h1', 'main-title', section.label))
  header.appendChild(el('p', 'main-desc', section.desc))
  main.appendChild(header)

  const body = el('div', 'main-body')
  body.appendChild(section.render())
  main.appendChild(body)

  app.replaceChildren(buildNav(key), main)
}

async function reload(): Promise<void> {
  await loadState()
  render()
}

async function boot(): Promise<void> {
  bindReload(reload)
  await loadState()
  render()
  window.addEventListener('hashchange', render)

  // 设置可能被 Popup 或其它标签页改动，这里保持同步（模型配置的未保存草稿不受影响）
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    const keys = Object.keys(changes)
    if (keys.includes(STORAGE_KEYS.models) || keys.includes(STORAGE_KEYS.settings)) {
      void reload()
    }
  })
}

void boot()
