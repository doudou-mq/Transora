/**
 * Transora e2e 冒烟测试（阶段 1 主链路）。
 *
 * 为什么不用 jsdom / 单元测试覆盖这条链路：本项目的核心风险都不在纯函数里，
 * 而在「MV3 能否真的加载」「静态注入是否生效」「注入的 DOM 会不会破坏页面布局」
 * 「跨域请求是否必须走 Background」这些只有真浏览器才能回答的问题上。
 * 所以这里用真实 Chromium 加载 dist/，配一个本地 mock 模型服务，把主链路跑一遍。
 *
 * 用法：
 *   npm run build
 *   npm run test:e2e
 *
 * 需要本机有 Playwright 下载过的 Chromium；也可用 TRANSORA_CHROME 指定可执行文件。
 * 截图与报告输出到 .verify/。
 */

import { chromium } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockServer } from './mock-server.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIST = path.join(ROOT, 'dist')
const OUT = path.join(ROOT, '.verify')

/* ------------------------------------------------------------------ */
/* 基础设施                                                            */
/* ------------------------------------------------------------------ */

function resolveChrome() {
  if (process.env.TRANSORA_CHROME) return process.env.TRANSORA_CHROME

  const cacheDir =
    process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')

  const macApp = ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']
  const layouts = [
    ['chrome-mac-arm64', macApp],
    ['chrome-mac', macApp],
    ['chrome-linux', ['chrome']],
    ['chrome-win', ['chrome.exe']],
  ]

  const candidates = []
  if (fs.existsSync(cacheDir)) {
    for (const entry of fs.readdirSync(cacheDir)) {
      if (!/^chromium-\d+$/.test(entry)) continue
      for (const [platform, relative] of layouts) {
        const full = path.join(cacheDir, entry, platform, ...relative)
        if (fs.existsSync(full)) candidates.push({ order: Number(entry.split('-')[1]), full })
      }
    }
  }

  candidates.sort((a, b) => b.order - a.order)
  return candidates[0]?.full
}

const results = []
function check(name, passed, detail = '') {
  results.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
}

/** 截图前等动效落定，否则会拍到过渡动画的中间帧 */
const settle = (page, ms = 420) => page.waitForTimeout(ms)

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
  console.error('未找到 dist/manifest.json，请先执行 npm run build')
  process.exit(2)
}

const chromePath = resolveChrome()
if (!chromePath) {
  console.error(
    '未找到可用的 Chromium。请安装 Playwright 浏览器，或用 TRANSORA_CHROME=/path/to/chrome 指定。',
  )
  process.exit(2)
}

fs.mkdirSync(OUT, { recursive: true })

const server = await startMockServer(8787)
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transora-e2e-'))

const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: chromePath,
  // 侧载扩展需要持久化上下文；这里用 Chrome 的 new headless 模式，
  // 不弹窗口也能加载扩展（Playwright 的老 headless shell 不支持扩展）
  headless: false,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  viewport: { width: 1280, height: 900 },
})

const pageErrors = []
context.on('page', (p) => {
  p.on('pageerror', (err) => pageErrors.push(String(err?.message ?? err)))
})

try {
  /* ---------- 扩展加载 ---------- */
  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 })
  const extensionId = new URL(worker.url()).host
  check('MV3 Service Worker 注册成功', Boolean(extensionId), extensionId)

  /* ---------- 未配置态的注入 UI ---------- */
  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto(server.baseUrl, { waitUntil: 'load' })

  await page.waitForSelector('[data-transora="root"]', { state: 'attached', timeout: 10000 })
  check('静态声明式内容脚本注入生效', true)

  await page.waitForSelector('[data-transora="fab"] .transora-fab-btn', { timeout: 8000 })
  check('悬浮按钮挂载', true)

  await page.hover('[data-transora="fab"]')
  await page.waitForSelector('[data-transora="fab"].transora-fab--open', { timeout: 5000 })
  check(
    '未配置时菜单内出现引导卡（D-4）',
    (await page.locator('[data-transora="fab"] .transora-guide').count()) > 0,
  )
  check(
    '未配置时「翻译当前页面」置灰（D-4）',
    await page
      .locator('[data-transora="fab"] .transora-fab-item', { hasText: '翻译当前页面' })
      .first()
      .isDisabled(),
  )
  await settle(page)
  await page.screenshot({ path: path.join(OUT, '01-fab-unconfigured.png') })

  /* ---------- 扩展独立页（新标签页） ---------- */
  const app = await context.newPage()
  await app.goto(`chrome-extension://${extensionId}/src/pages/index.html#models`, {
    waitUntil: 'load',
  })
  await app.waitForSelector('.nav-item', { timeout: 8000 })
  check('新标签页 SPA 渲染 4 个区块', (await app.locator('.nav-item').count()) === 4)
  check(
    '模型配置空态文案正确',
    ((await app.locator('.onboarding-title').first().textContent()) ?? '').includes('还没有配置模型'),
  )
  await app.screenshot({ path: path.join(OUT, '02-app-models-empty.png'), fullPage: true })

  /* ---------- 写入模型配置 ---------- */
  await app.evaluate(async (base) => {
    await chrome.storage.local.set({
      'transora:models': [
        {
          id: 'e2e-model',
          name: 'E2E Mock Model',
          provider: 'openai-compatible',
          endpoint: `${base}/v1`,
          apiKey: 'sk-e2e',
          model: 'e2e-chat',
          temperature: 0.3,
          maxTokens: 512,
          enabled: true,
        },
      ],
      'transora:settings': {
        targetLang: 'zh-CN',
        sourceLang: 'en',
        displayMode: 'bilingual',
        cacheEnabled: false,
        historyLimit: 1000,
        maxModelsForCompare: 3,
        lastModelId: 'e2e-model',
        fabHidden: false,
      },
    })
  }, server.baseUrl)

  await app.waitForSelector('.model-card', { timeout: 8000 })
  check(
    '设置页响应外部存储变更',
    ((await app.locator('.model-name').first().textContent()) ?? '').includes('E2E Mock Model'),
  )

  /* ---------- 全文块级双语对照 ---------- */
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('[data-transora="fab"] .transora-fab-btn', { timeout: 10000 })
  await page.hover('[data-transora="fab"]')
  await page.waitForSelector('[data-transora="fab"].transora-fab--open', { timeout: 5000 })
  await page
    .locator('[data-transora="fab"] .transora-fab-item', { hasText: '翻译当前页面' })
    .first()
    .click()

  await page.waitForSelector('.transora-tr .transora-tr-body', { timeout: 20000 })
  await page.waitForFunction(
    () => {
      const nodes = [...document.querySelectorAll('.transora-tr')]
      return nodes.length > 0 && nodes.every((n) => !n.classList.contains('transora-tr--loading'))
    },
    { timeout: 25000 },
  )

  const stats = await page.evaluate(() => {
    const translations = [...document.querySelectorAll('.transora-tr')]
    return {
      count: translations.length,
      sample: translations[0]?.querySelector('.transora-tr-body')?.textContent ?? '',
      allTranslated: translations.every((t) => (t.textContent || '').includes('【译】')),
      innerCount: document.querySelectorAll('.transora-src-inline').length,
      siblingCount: document.querySelectorAll('.transora-src').length,
      codeTranslated: document.querySelectorAll('pre .transora-tr, code .transora-tr').length,
    }
  })

  check('全文块级对照已注入', stats.count >= 8, `blocks=${stats.count}`)
  check('译文来自模型返回', stats.allTranslated, stats.sample.slice(0, 36))
  check(
    'flex 容器内改用内嵌插入（G-3 风险 1）',
    stats.innerCount >= 1 && stats.siblingCount >= 1,
    `inner=${stats.innerCount} sibling=${stats.siblingCount}`,
  )
  check('代码块未被翻译（FR-01 边界）', stats.codeTranslated === 0)
  await settle(page)
  await page.screenshot({ path: path.join(OUT, '03-bilingual.png') })

  /* ---------- 对照三态 ---------- */
  const setMode = (mode) =>
    page.evaluate((m) => {
      document.documentElement.classList.remove(
        'transora-mode-bilingual',
        'transora-mode-original',
        'transora-mode-translation',
      )
      document.documentElement.classList.add(m)
    }, mode)

  await setMode('transora-mode-original')
  check('仅原文模式隐藏译文块（FR-16）', (await page.locator('.transora-tr').first().isVisible()) === false)

  await setMode('transora-mode-translation')
  check(
    '仅译文模式隐藏原文块（FR-16）',
    (await page.evaluate(() => {
      const node = document.querySelector('.transora-src')
      return node ? getComputedStyle(node).display === 'none' : null
    })) === true,
  )
  await settle(page)
  await page.screenshot({ path: path.join(OUT, '04-translation-only.png') })

  await setMode('transora-mode-bilingual')

  /* ---------- 侧边栏 ---------- */
  await page.hover('[data-transora="fab"]')
  await page.waitForSelector('[data-transora="fab"].transora-fab--open', { timeout: 5000 })
  await page
    .locator('[data-transora="fab"] .transora-fab-item', { hasText: '打开侧边栏' })
    .first()
    .click()
  await page.waitForSelector('.transora-sidebar.transora-sidebar--open', { timeout: 5000 })
  const entries = await page.locator('.transora-sb-entry').count()
  check('侧边栏 Slide 打开并列出本页对照', entries > 0, `entries=${entries}`)
  check(
    '侧边栏打开时悬浮按钮隐藏（Q3-B：严格贴右，不让位）',
    await page.evaluate(
      () => getComputedStyle(document.querySelector('[data-transora="fab"]')).display === 'none',
    ),
  )
  await settle(page)
  await page.screenshot({ path: path.join(OUT, '05-sidebar.png') })

  /* ---------- 划词 ---------- */
  await page.evaluate(() => {
    const target =
      document.querySelectorAll('article p, body > p')[1] ?? document.querySelector('p')
    const range = document.createRange()
    range.selectNodeContents(target)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.waitForSelector('.transora-sel-icon.transora-sel-icon--open', { timeout: 5000 })
  check('划词跟随图标出现（FR-03）', true)
  check(
    '侧边栏打开时跟随图标仍在可点区域内',
    await page.evaluate(() => {
      const icon = document.querySelector('.transora-sel-icon')
      const rect = icon.getBoundingClientRect()
      return rect.right <= window.innerWidth - 400 && getComputedStyle(icon).pointerEvents === 'auto'
    }),
  )
  await settle(page)
  await page.screenshot({ path: path.join(OUT, '06-selection-icon.png') })

  await page.click('.transora-sel-icon')
  await page.waitForSelector('.transora-sel-card.transora-sel-card--open .transora-sel-translated', {
    timeout: 15000,
  })
  check(
    '划词内容块返回译文（FR-04）',
    ((await page.locator('.transora-sel-translated').textContent()) ?? '').includes('【译】'),
  )
  check(
    '划词内容块不含多模型对比（A1 / X6）',
    (await page.locator('.transora-sel-card .transora-sb-compare').count()) === 0,
  )

  /* ---------- G4 / G5 结构与几何 ---------- */
  // 几何必须在「静止态」量：上一步 click 之后指针仍停在图标上，:hover 的 scale(1.08)
  // 会把盒子量成 26×26、外扩量成 7px。先把指针移开并等过渡结束。
  await page.mouse.move(20, 20)
  await page.waitForTimeout(260)

  const iconGeo = await page.evaluate(() => {
    const icon = document.querySelector('.transora-sel-icon')
    const box = icon.getBoundingClientRect()
    const cs = getComputedStyle(icon)
    const sel = window.getSelection()
    const rect = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null
    // 侧边栏占掉的宽度要排除，图标只能落在剩余可用区内（S5：右侧越界时贴左）
    const available = window.innerWidth - 400
    return {
      // 用 computed width/height：它反映 CSS 盒尺寸，不受 hover 的 transform 缩放干扰
      w: Math.round(parseFloat(cs.width)),
      h: Math.round(parseFloat(cs.height)),
      radius: cs.borderRadius,
      glyph: icon.textContent.trim(),
      dy: rect ? Math.round(box.top - rect.bottom) : null,
      dx: rect ? Math.round(box.left - rect.right) : null,
      insideAvailable: box.right <= available - 8 + 0.5,
    }
  })
  check(
    '跟随图标 24×24 · 圆角 8 · 字符「译」· 下外扩 8px（G4 / S5）',
    iconGeo.w === 24 &&
      iconGeo.h === 24 &&
      iconGeo.radius === '8px' &&
      iconGeo.glyph === '译' &&
      iconGeo.dy === 8 &&
      // 本用例里侧边栏是打开的 → 通常走「贴左」分支；两种都符合 S5
      (iconGeo.dx === 8 || iconGeo.insideAvailable),
    JSON.stringify(iconGeo),
  )
  check(
    '内容块宽度 360 · 圆角 12 · 投影 0 8px 24px（G5 / Q5-C）',
    await page.evaluate(() => {
      const card = document.querySelector('.transora-sel-card')
      const cs = getComputedStyle(card)
      return (
        Math.round(card.getBoundingClientRect().width) === 360 &&
        cs.borderRadius === '12px' &&
        cs.boxShadow.includes('0px 8px 24px')
      )
    }),
  )
  check(
    '内容块含「供应商 / 模型」两级切换（G5 ④）',
    await page.evaluate(
      () =>
        document.querySelectorAll('.transora-sel-pill').length >= 1 &&
        document.querySelectorAll('.transora-sel-chip').length >= 1 &&
        [...document.querySelectorAll('.transora-sel-switch-label')]
          .map((e) => e.textContent)
          .join('/') === '供应商/模型',
    ),
  )
  check(
    '内容块元信息行 = 模型 chip + 耗时/token + 语言对（G5 ③）',
    await page.evaluate(() => {
      const model = document.querySelector('.transora-sel-meta-model')?.textContent?.trim() ?? ''
      const stat = document.querySelector('.transora-sel-meta-stat')?.textContent?.trim() ?? ''
      const lang = document.querySelector('.transora-sel-meta-lang')?.textContent?.trim() ?? ''
      return model.length > 0 && /\d+(\.\d+)?(ms|s)/.test(stat) && lang.includes('→')
    }),
  )
  check(
    '内容块动作行 = 设置 · 打开侧边栏 · 复制译文 + Esc 关闭（G5 ⑤）',
    await page.evaluate(
      () =>
        [...document.querySelectorAll('.transora-sel-act')].map((e) => e.textContent).join('/') ===
          '设置/打开侧边栏/复制译文' &&
        document.querySelector('.transora-sel-esc')?.textContent?.trim() === 'Esc 关闭',
    ),
  )
  check(
    '内容块已无源语言下拉（Q6-A）',
    (await page.locator('.transora-sel-card select').count()) === 0,
  )

  /* ---------- S5：悬停图标即展开（无需点击） ---------- */
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  await page.evaluate(() => {
    const target =
      document.querySelectorAll('article p, body > p')[1] ?? document.querySelector('p')
    const range = document.createRange()
    range.selectNodeContents(target)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.waitForSelector('.transora-sel-icon.transora-sel-icon--open', { timeout: 5000 })
  const hoverPoint = await page.evaluate(() => {
    const box = document.querySelector('.transora-sel-icon').getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  })
  await page.mouse.move(hoverPoint.x, hoverPoint.y)
  let hoverOpened = true
  try {
    await page.waitForSelector('.transora-sel-card.transora-sel-card--open', { timeout: 4000 })
  } catch {
    hoverOpened = false
  }
  check('悬停图标即展开内容块（S5 · 无需点击）', hoverOpened)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  await settle(page)
  await page.screenshot({ path: path.join(OUT, '07-selection-card.png') })

  /* ---------- 恢复原文 ---------- */
  // 悬浮按钮严格贴右（不让位），侧边栏打开时整体隐藏；先关掉侧边栏才能继续操作 FAB
  await page.click('.transora-sb-close')
  await page.waitForTimeout(400)
  await page.hover('[data-transora="fab"]')
  await page.waitForSelector('[data-transora="fab"].transora-fab--open', { timeout: 5000 })
  await page.locator('[data-transora="fab"] .transora-fab-item', { hasText: '恢复原文' }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.transora-tr').length === 0, {
    timeout: 8000,
  })
  const residual = await page.evaluate(() => ({
    translations: document.querySelectorAll('.transora-tr').length,
    sources: document.querySelectorAll('.transora-src, .transora-src-inline').length,
  }))
  check(
    '恢复原文后无残留节点（FR-02）',
    residual.translations === 0 && residual.sources === 0,
    JSON.stringify(residual),
  )
  await settle(page)
  await page.screenshot({ path: path.join(OUT, '08-restored.png') })

  /* ---------- Popup ---------- */
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`, { waitUntil: 'load' })
  await popup.waitForSelector('.popup-card', { timeout: 8000 })
  // 这里是当普通标签页打开的，所以只量由 CSS 钉死的 #app（它决定真实 popup 窗口尺寸）
  const popupSize = await popup.evaluate(() => {
    const rect = document.getElementById('app').getBoundingClientRect()
    return { w: Math.round(rect.width), h: Math.round(rect.height) }
  })
  check('Popup 尺寸 400×600', popupSize.w === 400 && popupSize.h === 600, JSON.stringify(popupSize))
  check('Popup 渲染模型快选与目标语言', (await popup.locator('.popup-row').count()) === 2)
  await popup.screenshot({ path: path.join(OUT, '09-popup.png') })

  /* ---------- 其余区块 ---------- */
  await app.goto(`chrome-extension://${extensionId}/src/pages/index.html#general`, { waitUntil: 'load' })
  await app.waitForSelector('.setting-row', { timeout: 8000 })
  check('通用设置页渲染', (await app.locator('.setting-row').count()) >= 6)
  await app.screenshot({ path: path.join(OUT, '10-app-general.png'), fullPage: true })

  await app.goto(`chrome-extension://${extensionId}/src/pages/index.html#about`, { waitUntil: 'load' })
  await app.waitForSelector('.about-hero', { timeout: 8000 })
  const aboutText = await app.locator('.main-body').innerText()
  check(
    '关于页含权限说明且不含 sidePanel（C2）',
    aboutText.includes('storage') && !aboutText.includes('sidePanel'),
  )
  await app.screenshot({ path: path.join(OUT, '11-app-about.png'), fullPage: true })

  await app.goto(`chrome-extension://${extensionId}/src/pages/index.html#history`, { waitUntil: 'load' })
  await app.waitForSelector('.history-fields', { timeout: 8000 })
  check('翻译历史页给出阶段 2 口径说明', true)

  /* ---------- 无未捕获错误 ---------- */
  check('测试期间无未捕获页面错误', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 240))
} catch (err) {
  check('e2e 流程执行完成', false, String(err).slice(0, 400))
  try {
    const fallback = context.pages().find((p) => p.url().startsWith('http'))
    if (fallback) await fallback.screenshot({ path: path.join(OUT, 'zz-failure.png') })
  } catch {
    /* 截图失败不掩盖原始错误 */
  }
} finally {
  const failed = results.filter((r) => !r.passed)
  console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`)
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
  await context.close()
  await server.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
  process.exit(failed.length === 0 ? 0 : 1)
}
