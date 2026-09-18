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

// 上一轮失败留下的截图要清掉：它不写成功路径、也不会自己消失，
// 留着会让人误以为「这一轮又挂了」。每次开跑先归零，失败时再重新落一张。
const FAILURE_SHOT = path.join(OUT, 'zz-failure.png')
if (fs.existsSync(FAILURE_SHOT)) fs.unlinkSync(FAILURE_SHOT)

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

/**
 * 悬停「隐藏式」悬浮按钮。
 *
 * 为什么不能用 `page.hover()`：静止态按钮只露一半，**元素中心落在视口右缘之外**，
 * Playwright 的可操作性检查（要求命中点可见）会判失败。所以这里显式把指针移到
 * 「视口内那 20px 可见条带」上 —— 与真实用户的鼠标走的是同一条路径。
 */
async function hoverFab(page) {
  const box = await page.locator('[data-transora="fab"] .transora-fab-btn').boundingBox()
  const viewport = page.viewportSize()
  if (!box || !viewport) throw new Error('拿不到悬浮按钮的位置')
  await page.mouse.move(viewport.width - 8, Math.round(box.y + box.height / 2))
}

/**
 * mock 模型给每段译文打的标记。带上 model 名（`【译·e2e-chat】`），
 * 这样多模型对比才能断言「每一列来自各自的模型」——只判断「有没有译文」是测不出串味的。
 */
const translatedBy = (text, model) => (text ?? '').includes(`【译·${model}】`)
const isTranslated = (text) => (text ?? '').includes('【译')

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

  /* ---------- G10 隐藏式悬浮按钮：静止半隐藏 → 两段式悬停 → 回位 ---------- */
  // 指针先离开右侧再量几何：静止态几何只有在**没有 :hover** 时才是静止值
  await page.mouse.move(400, 300)
  await settle(page, 320)

  const fabRest = await page.evaluate(() => {
    const btn = document.querySelector('[data-transora="fab"] .transora-fab-btn')
    if (!btn) return null
    const box = btn.getBoundingClientRect()
    const cs = getComputedStyle(btn)
    return {
      // 尺寸取 computedStyle：它不受 transform 影响（悬停时会被放大到 1.04）
      w: parseFloat(cs.width),
      h: parseFloat(cs.height),
      radius: cs.borderRadius,
      opacity: Number(cs.opacity),
      inside: Math.round(document.documentElement.clientWidth - box.left),
      outside: Math.round(box.right - document.documentElement.clientWidth),
    }
  })
  check(
    'G10 隐藏式静止态：贴住视口右缘、只露一半（视口内 20px / 视口外 20px）+ opacity .5',
    Boolean(fabRest) &&
      fabRest.opacity === 0.5 &&
      fabRest.w === 40 &&
      fabRest.h === 40 &&
      fabRest.radius === '12px' &&
      fabRest.inside === 20 &&
      fabRest.outside === 20,
    JSON.stringify(fabRest),
  )
  await page.screenshot({ path: path.join(OUT, '01a-fab-hidden-rest.png') })

  await hoverFab(page)
  // 两段式时序：露出是 180ms，菜单必须等它播完才出来 —— 110ms 时菜单还不能开
  await page.waitForTimeout(110)
  const midReveal = await page.evaluate(() => {
    const el = document.querySelector('[data-transora="fab"]')
    const btn = el?.querySelector('.transora-fab-btn')
    return {
      open: el ? el.classList.contains('transora-fab--open') : null,
      opacity: btn ? Number(getComputedStyle(btn).opacity) : null,
    }
  })
  check(
    'G10 悬停第一段（露出）期间菜单尚未展开（两段式时序）',
    midReveal.open === false,
    JSON.stringify(midReveal),
  )

  const openStartedAt = Date.now()
  await page.waitForSelector('[data-transora="fab"].transora-fab--open', { timeout: 5000 })
  const openDelay = Date.now() - openStartedAt + 110
  check(
    'G10 菜单在露出动画（180ms）之后才展开',
    openDelay >= 170,
    `悬停后约 ${openDelay}ms 菜单才出现`,
  )

  await settle(page, 320)
  const fabHover = await page.evaluate(() => {
    const btn = document.querySelector('[data-transora="fab"] .transora-fab-btn')
    const box = btn.getBoundingClientRect()
    const cs = getComputedStyle(btn)
    return {
      opacity: Number(cs.opacity),
      gapToEdge: Math.round(document.documentElement.clientWidth - box.right),
      visualW: Math.round(box.width),
      visualRadius: cs.borderRadius,
    }
  })
  check(
    'G10 悬停露出后：完整贴边（右缘对齐视口）+ opacity 1 + scale 1.04',
    fabHover.opacity === 1 && fabHover.gapToEdge === 0 && Math.abs(fabHover.visualW - 41.6) <= 1.5,
    JSON.stringify(fabHover),
  )

  // 移出后回位：250ms 收菜单 + 滑回半隐藏
  await page.mouse.move(400, 300)
  await page.waitForTimeout(600)
  const fabBack = await page.evaluate(() => {
    const el = document.querySelector('[data-transora="fab"]')
    const btn = el.querySelector('.transora-fab-btn')
    const box = btn.getBoundingClientRect()
    return {
      open: el.classList.contains('transora-fab--open'),
      opacity: Number(getComputedStyle(btn).opacity),
      inside: Math.round(document.documentElement.clientWidth - box.left),
    }
  })
  check(
    'G10 移出后收起菜单并滑回半隐藏静止态',
    fabBack.open === false && fabBack.opacity === 0.5 && fabBack.inside === 20,
    JSON.stringify(fabBack),
  )

  await hoverFab(page)
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
  // 写两个模型：多模型对比（FR-09）至少需要 2 个，且两个模型的 mock 译文标记不同
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
        {
          id: 'e2e-alt',
          name: 'E2E Alt Model',
          provider: 'openai-compatible',
          endpoint: `${base}/v1`,
          apiKey: 'sk-e2e',
          model: 'e2e-alt-chat',
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
  await hoverFab(page)
  await page.waitForSelector('[data-transora="fab"].transora-fab--open', { timeout: 5000 })
  await page
    .locator('[data-transora="fab"] .transora-fab-item', { hasText: '翻译当前页面' })
    .first()
    .click()

  // 翻译进行中 / 刚完成时 FAB 带 H3 角标：此时必须保持完整露出
  // （角标画在按钮右上角，半隐藏时整枚角标都在视口外）
  await page.waitForFunction(
    () => document.querySelector('[data-transora="fab"]')?.classList.contains('transora-fab--badged'),
    { timeout: 10000 },
  )
  // 指针移开且越过 250ms 收起延迟后再量：此刻若仍完整贴边，就只可能是角标在兜住露出态
  await page.mouse.move(200, 700)
  await page.waitForTimeout(400)
  const fabBadged = await page.evaluate(() => {
    const el = document.querySelector('[data-transora="fab"]')
    const btn = el.querySelector('.transora-fab-btn')
    const box = btn.getBoundingClientRect()
    return {
      badged: el.classList.contains('transora-fab--badged'),
      open: el.classList.contains('transora-fab--open'),
      opacity: Number(getComputedStyle(btn).opacity),
      gapToEdge: Math.round(document.documentElement.clientWidth - box.right),
      badgeCount: el.querySelectorAll('.transora-fab-badge').length,
    }
  })
  check(
    'G10 带角标时强制完整露出（半隐藏会让 H3 角标落到视口外）',
    fabBadged.badged && fabBadged.badgeCount === 1 && !fabBadged.open &&
      fabBadged.opacity === 1 && fabBadged.gapToEdge === 0,
    JSON.stringify(fabBadged),
  )

  await page.waitForSelector('.transora-tr .transora-tr-body', { timeout: 20000 })
  await page.waitForFunction(
    () => {
      const nodes = [...document.querySelectorAll('.transora-tr')]
      return nodes.length > 0 && nodes.every((n) => !n.classList.contains('transora-tr--loading'))
    },
    { timeout: 25000 },
  )

  /* ---------- A2 / H3 工具栏角标三态 ---------- */
  // 完成角标只停留 3.5s，而且「译文块不再 loading」会早于本轮收尾代码，
  // 所以这里轮询等 ✓ 出现，而不是立刻断言（否则会读到进行中的进度角标）。
  const badgeDone = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const snapshot = await app.evaluate(async () => ({
        text: await chrome.action.getBadgeText({}),
        title: await chrome.action.getTitle({}),
      }))
      if (snapshot.text === '✓') return snapshot
      await new Promise((r) => setTimeout(r, 150))
    }
    return { text: null, title: null }
  })()
  check(
    'H3 工具栏角标：完成态显示 ✓（A2）',
    badgeDone.text === '✓',
    JSON.stringify(badgeDone),
  )

  const stats = await page.evaluate(() => {
    const translations = [...document.querySelectorAll('.transora-tr')]
    return {
      count: translations.length,
      sample: translations[0]?.querySelector('.transora-tr-body')?.textContent ?? '',
      // 注意：这里跑在浏览器上下文，Node 侧的 translatedBy() 拿不到，必须内联字符串判断
      allTranslated: translations.every((t) => (t.textContent ?? '').includes('【译·e2e-chat】')),
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

  /* ---------- G7 页面顶部状态栏（Sticky） ---------- */
  await page.waitForSelector('.transora-st .transora-st-inner', { timeout: 8000 })
  const st = await page.evaluate(() => {
    const bar = document.querySelector('.transora-st')
    const modes = [...document.querySelectorAll('.transora-st-mode')]
    const fill = document.querySelector('.transora-st-bar-fill')
    const cs = getComputedStyle(bar)
    const rect = bar.getBoundingClientRect()
    return {
      position: cs.position,
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      mark: document.querySelector('.transora-st-mark')?.textContent,
      title: document.querySelector('.transora-st-title')?.textContent,
      host: document.querySelector('.transora-st-host')?.textContent,
      count: document.querySelector('.transora-st-count')?.textContent,
      barH: Math.round(document.querySelector('.transora-st-bar').getBoundingClientRect().height),
      fillRatio: fill ? Math.round((fill.getBoundingClientRect().width / fill.parentElement.getBoundingClientRect().width) * 100) : null,
      modes: modes.map((n) => n.textContent.trim()),
      activeMode: modes.find((n) => n.classList.contains('is-active'))?.textContent?.trim(),
      langOptions: document.querySelectorAll('.transora-st-lang option').length,
      exit: Boolean(document.querySelector('.transora-st-exit svg')),
      radius: getComputedStyle(document.querySelector('.transora-st-inner')).borderRadius,
    }
  })
  check(
    'G7 顶栏吸顶且左侧为「译」章 + 对照状态 + 域名',
    st.position === 'fixed' && st.mark === '译' && st.title === '双语对照已开启' && st.host.startsWith('127.0.0.1'),
    JSON.stringify({ position: st.position, mark: st.mark, title: st.title, host: st.host }),
  )
  check(
    'G7 顶栏右侧 = 段数 + 4px 进度条 + 三态 + 目标语言 + 退出',
    /^\d+ \/ \d+ 段$/.test(st.count) &&
      st.barH === 4 &&
      st.modes.join(',') === '原文,译文,对照' &&
      st.activeMode === '对照' &&
      st.langOptions === 9 &&
      st.exit,
    JSON.stringify({ count: st.count, barH: st.barH, modes: st.modes, lang: st.langOptions, exit: st.exit }),
  )
  check('G7 顶栏为 56 高圆角卡片（圆角 10）', st.radius === '10px', st.radius)

  /* ---------- H1 快捷键 Alt+Shift+M：切换 对照 / 译文 / 原文 ---------- */
  // 真按浏览器快捷键在 Playwright 里做不到，改为走「Background → Content」的同一条指令通道，
  // 这样验证的是真实的命令往返，而不是绕过消息层直接改 DOM。
  const fixtureTabId = await app.evaluate(async (base) => {
    const tabs = await chrome.tabs.query({})
    return tabs.find((t) => (t.url ?? '').startsWith(base))?.id ?? null
  }, server.baseUrl)
  check('H1 指令通道可用（能定位 fixture 标签页）', fixtureTabId !== null, String(fixtureTabId))

  const sendCmd = (command) =>
    app.evaluate(
      ([tabId, cmd]) => chrome.tabs.sendMessage(tabId, { type: 'transora/cmd', command: cmd }),
      [fixtureTabId, command],
    )

  const activeMode = () =>
    page.evaluate(() =>
      document.querySelector('.transora-st-mode.is-active')?.textContent?.trim(),
    )

  await sendCmd('toggle-display-mode')
  await page.waitForFunction(
    () => document.querySelector('.transora-st-mode.is-active')?.textContent?.trim() === '译文',
    { timeout: 5000 },
  )
  check('Alt+Shift+M 对照 → 译文', (await activeMode()) === '译文')
  check(
    '切到「译文」后原文块被隐藏（FR-16）',
    (await page.evaluate(() => {
      const node = document.querySelector('.transora-src')
      return node ? getComputedStyle(node).display === 'none' : null
    })) === true,
  )

  await sendCmd('toggle-display-mode')
  await page.waitForFunction(
    () => document.querySelector('.transora-st-mode.is-active')?.textContent?.trim() === '原文',
    { timeout: 5000 },
  )
  check('Alt+Shift+M 译文 → 原文', (await activeMode()) === '原文')

  await sendCmd('toggle-display-mode')
  await page.waitForFunction(
    () => document.querySelector('.transora-st-mode.is-active')?.textContent?.trim() === '对照',
    { timeout: 5000 },
  )
  check('Alt+Shift+M 原文 → 对照（闭环）', (await activeMode()) === '对照')

  check(
    'manifest 声明 Alt+Shift+M（H1 / A9）',
    (await app.evaluate(
      () => chrome.runtime.getManifest().commands?.['toggle-display-mode']?.suggested_key?.default,
    )) === 'Alt+Shift+M',
  )

  const menuTitles = await app.evaluate(
    () =>
      Object.values(chrome.runtime.getManifest().commands ?? {})
        .map((c) => c.description)
        .join(','),
  )
  check(
    'manifest 四条快捷键齐备（S / T / R / M）',
    ['翻译本页 / 恢复原文', '翻译选中文本', '打开 / 关闭侧边栏', '切换 对照 / 译文 / 原文'].every((d) =>
      menuTitles.includes(d),
    ),
    menuTitles,
  )

  /* ---------- H1 右键菜单 4 项 ---------- */
  // chrome.contextMenus 没有「列出已注册项」的 API，改用重复 id 必然报错这一行为反证注册成功。
  const menuProbe = await worker.evaluate(async () => {
    const ids = [
      'transora:translate-selection',
      'transora:toggle-page',
      'transora:copy-source',
      'transora:copy-translation',
    ]
    const dup = await Promise.all(
      ids.map(
        (id) =>
          new Promise((resolve) => {
            chrome.contextMenus.create({ id, title: 'dup', contexts: ['selection'] }, () => {
              resolve(chrome.runtime.lastError?.message ?? null)
            })
          }),
      ),
    )
    return dup
  })
  check(
    'H1 右键菜单 4 项均已注册（重复 id 反证）',
    menuProbe.every((msg) => typeof msg === 'string' && msg.length > 0),
    JSON.stringify(menuProbe),
  )

  /* ---------- 侧边栏 ---------- */
  await hoverFab(page)
  await page.waitForSelector('[data-transora="fab"].transora-fab--open', { timeout: 5000 })
  await page
    .locator('[data-transora="fab"] .transora-fab-item', { hasText: '打开侧边栏' })
    .first()
    .click()
  await page.waitForSelector('.transora-sidebar.transora-sidebar--open', { timeout: 5000 })
  // G11：本页对照以「大纲」形式呈现，每条 = 一个已出块（含层级缩进 + 状态标签）
  const entries = await page.locator('.transora-sb-out-item').count()
  check('侧边栏 Slide 打开并列出本页对照', entries > 0, `entries=${entries}`)
  check(
    '侧边栏 G11 结构齐备（T 章标 / Tab 标签 / 翻译进度 / 三态切换）',
    await page.evaluate(() => {
      const q = (s) => document.querySelector(s)
      return {
        mark: q('.transora-sb-mark')?.textContent === 'T',
        tabs: document.querySelectorAll('.transora-sb-tab').length === 3,
        tabLabels:
          [...document.querySelectorAll('.transora-sb-tab')]
            .map((n) => n.childNodes[0]?.textContent?.trim())
            .join(',') === '本页对照,划词记录,多模型对比',
        progress: Boolean(q('.transora-sb-progress-count')),
        modes: document.querySelectorAll('.transora-sb-mode').length === 3,
      }
    }).then((r) => Object.values(r).every(Boolean)),
  )
  check(
    '侧边栏三态切换用设计稿名词「原文 / 译文 / 对照」（G3 / G11）',
    await page.evaluate(() =>
      [...document.querySelectorAll('.transora-sb-mode')]
        .map((n) => n.textContent.trim())
        .join(','),
    ).then((s) => s === '原文,译文,对照'),
  )
  check(
    '侧边栏打开时悬浮按钮隐藏（Q3-B：严格贴右，不让位）',
    await page.evaluate(
      () => getComputedStyle(document.querySelector('[data-transora="fab"]')).display === 'none',
    ),
  )
  await settle(page)
  await page.screenshot({ path: path.join(OUT, '05-sidebar.png') })

  /* ---------- G6 多模型对比（FR-09 / FR-10） ---------- */
  // 侧边栏此刻是打开着的，直接切到「多模型对比」Tab
  await page.locator('.transora-sb-tab', { hasText: '多模型对比' }).first().click()
  await page.waitForSelector('.transora-cmp', { timeout: 5000 })
  await page.waitForTimeout(420)

  // 对比 Tab 下侧边栏加宽到 728px（2026-09-17 裁决 A：400px 放不下三列可读的对比）
  const cmpWidth = await page.evaluate(() =>
    Math.round(document.querySelector('.transora-sidebar').getBoundingClientRect().width),
  )
  check('G6 对比 Tab 下侧边栏加宽到 728px（三列并排可读）', cmpWidth === 728, `${cmpWidth}px`)

  const picker = await page.evaluate(() => ({
    rows: document.querySelectorAll('.transora-cmp-pick-row').length,
    picked: document.querySelectorAll('.transora-cmp-pick-row.is-on').length,
    primary: document.querySelector('.transora-cmp-primary')?.textContent?.trim(),
    primaryDisabled: document.querySelector('.transora-cmp-primary')?.disabled === true,
    hasCompareTab: [...document.querySelectorAll('.transora-sb-tab')].some(
      (t) => t.childNodes[0]?.textContent?.trim() === '多模型对比',
    ),
  }))
  check(
    'G6 首屏为勾选态且已预选（I4 步骤 02）',
    picker.rows === 2 &&
      picker.picked === 2 &&
      picker.primary === '开始对比' &&
      picker.primaryDisabled === false,
    JSON.stringify(picker),
  )
  await page.screenshot({ path: path.join(OUT, '05-1-compare-picker.png') })

  const requestsBeforeCompare = server.getRequestCount()
  await page.locator('.transora-cmp-primary').click()

  // 两列都跑到「已完成」才算收尾（列头状态由 columnStatusOf 归并，失败块也算已处理）
  await page.waitForFunction(
    () => {
      const states = [...document.querySelectorAll('.transora-cmp-bar-state')]
      return states.length === 2 && states.every((n) => n.textContent.trim() === '已完成')
    },
    { timeout: 25000 },
  )

  const cmp = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.transora-cmp-card')]
    const cols = [...(cards[0]?.querySelectorAll('.transora-cmp-col') ?? [])]
    return {
      cards: cards.length,
      colsPerCard: cols.length,
      names: cols.map((c) => c.querySelector('.transora-cmp-col-name')?.textContent?.trim()),
      texts: cols.map((c) => c.querySelector('.transora-cmp-col-text')?.textContent?.trim() ?? ''),
      metas: [...document.querySelectorAll('.transora-cmp-bar-meta')].map((n) => n.textContent.trim()),
      states: [...document.querySelectorAll('.transora-cmp-bar-state')].map((n) => n.textContent.trim()),
      providers: [...document.querySelectorAll('.transora-cmp-bar-provider')].map((n) =>
        n.textContent.trim(),
      ),
      appliedNote: document.querySelector('.transora-cmp-applied')?.textContent?.trim() ?? '',
      colTextNodes: document.querySelectorAll('.transora-cmp-col-text').length,
      cardSrc: cards[0]?.querySelector('.transora-cmp-card-src')?.textContent?.trim() ?? '',
    }
  })

  check(
    'G6 逐块卡片：原文 + N 列并排（每块都在同一行里对齐）',
    cmp.cards >= 8 && cmp.colsPerCard === 2 && cmp.cardSrc.length > 0,
    JSON.stringify({ cards: cmp.cards, cols: cmp.colsPerCard, src: cmp.cardSrc.slice(0, 24) }),
  )
  check(
    'G6 两列译文分别来自各自的模型（列间不串味）',
    translatedBy(cmp.texts[0], 'e2e-chat') && translatedBy(cmp.texts[1], 'e2e-alt-chat'),
    JSON.stringify(cmp.texts.map((t) => t.slice(0, 16))),
  )
  check(
    'G6 列头 = 模型名 + 供应商 + 状态 + 耗时·token（A2 / Q6）',
    cmp.names.length === 2 &&
      cmp.providers.every((p) => p.length > 0) &&
      cmp.metas.every((m) => /^\d+\.\d+s · \d+ tok$/.test(m)) &&
      cmp.states.join(',') === '已完成,已完成',
    JSON.stringify({ names: cmp.names, metas: cmp.metas, providers: cmp.providers }),
  )
  check(
    'G6 已有译文时该列自动标为「已应用」（页面此刻显示 E2E Mock Model）',
    cmp.appliedNote.includes('E2E Mock Model'),
    cmp.appliedNote,
  )
  check('对比确实发起了请求（两列各跑一遍本页）', server.getRequestCount() > requestsBeforeCompare)

  /* ---------- FR-10「应用」：换显，不重新请求（D-3） ---------- */
  const beforeApply = server.getRequestCount()
  await page.locator('.transora-cmp-bar-item').nth(1).locator('.transora-cmp-apply').click()
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.transora-tr-body')].some((b) =>
        (b.textContent ?? '').includes('【译·e2e-alt-chat】'),
      ),
    { timeout: 8000 },
  )
  check(
    'FR-10 应用后页面译文换成所选模型的那一套（D-3 换显）',
    await page.evaluate(() => {
      const bodies = [...document.querySelectorAll('.transora-tr-body')]
      return (
        bodies.length > 0 &&
        bodies.every((b) => (b.textContent ?? '').includes('【译·e2e-alt-chat】'))
      )
    }),
  )
  check(
    'FR-10 应用不重新请求（译文已缓存，只换显示）',
    server.getRequestCount() === beforeApply,
    `${beforeApply} → ${server.getRequestCount()}`,
  )
  // 注意：emit() 是 rAF 批量渲染，而页面译文是同步换的 —— 上一个 waitForFunction 返回时
  // 侧边栏可能还没重绘。这里必须等「已应用」标记真的挪过去，不能立刻读。
  const appliedMoved = await page
    .waitForFunction(
      () => {
        const marked = [...document.querySelectorAll('.transora-cmp-bar-item.is-applied')]
        return (
          marked.length === 1 &&
          marked[0].querySelector('.transora-cmp-bar-name')?.textContent?.trim() === 'E2E Alt Model'
        )
      },
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false)
  check(
    'G6 应用后「已应用」标记转到第二列',
    appliedMoved,
    JSON.stringify(
      await page.evaluate(() =>
        [...document.querySelectorAll('.transora-cmp-bar-item')].map((n) => ({
          name: n.querySelector('.transora-cmp-bar-name')?.textContent?.trim(),
          applied: n.classList.contains('is-applied'),
          btn: n.querySelector('.transora-cmp-apply')?.textContent?.trim(),
        })),
      ),
    ),
  )
  await settle(page)
  await page.screenshot({ path: path.join(OUT, '05-2-compare-applied.png') })

  // 切回「本页对照」——后面的划词几何断言按 400px 侧边栏计算，必须先恢复宽度
  await page.locator('.transora-sb-tab', { hasText: '本页对照' }).first().click()
  await page.waitForTimeout(420)
  const restoredWidth = await page.evaluate(() =>
    Math.round(document.querySelector('.transora-sidebar').getBoundingClientRect().width),
  )
  check('切回其他 Tab 后侧边栏恢复 400px', restoredWidth === 400, `${restoredWidth}px`)

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
    isTranslated(await page.locator('.transora-sel-translated').textContent()),
  )
  check(
    '划词内容块不含多模型对比（A1 / X6）',
    (await page.locator('.transora-sel-card .transora-cmp').count()) === 0,
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
  await hoverFab(page)
  await page.waitForSelector('[data-transora="fab"].transora-fab--open', { timeout: 5000 })

  // 阶段 2 收口：菜单里的「多模型对比」不再是置灰的「阶段 2 开放」占位项
  const compareItem = await page.evaluate(() => {
    const item = [...document.querySelectorAll('[data-transora="fab"] .transora-fab-item')].find(
      (n) => n.querySelector('.transora-fab-item-label')?.textContent?.trim() === '多模型对比',
    )
    return item
      ? { disabled: item.disabled, hint: item.querySelector('.transora-fab-item-hint')?.textContent?.trim() }
      : null
  })
  check(
    '菜单「多模型对比」已开放（去掉 disabled / 阶段 2 开放）',
    compareItem !== null && compareItem.disabled === false && compareItem.hint !== '阶段 2 开放',
    JSON.stringify(compareItem),
  )

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

  /* ---------- A2 / H3：退出对照后角标清空 ---------- */
  const badgeCleared = await (async () => {
    for (let i = 0; i < 20; i += 1) {
      const text = await app.evaluate(() => chrome.action.getBadgeText({}))
      if (text === '') return true
      await new Promise((r) => setTimeout(r, 150))
    }
    return false
  })()
  check('H3 工具栏角标：退出对照后清空（A2）', badgeCleared)

  /* ---------- Popup ---------- */
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`, { waitUntil: 'load' })
  await popup.waitForSelector('.popup-header', { timeout: 8000 })
  // 这里是当普通标签页打开的，所以只量由 CSS 钉死的 #app（它决定真实 popup 窗口尺寸）
  const popupSize = await popup.evaluate(() => {
    const rect = document.getElementById('app').getBoundingClientRect()
    return { w: Math.round(rect.width), h: Math.round(rect.height) }
  })
  check('Popup 尺寸 400×600', popupSize.w === 400 && popupSize.h === 600, JSON.stringify(popupSize))
  // D2 就绪态：模型单选列表 + 目标语言下拉
  // 注意：popup 以普通标签页打开时，getActiveTab() 命中的是 popup 自己，
  // 拿不到 fixture 页的内容脚本 → pageStatus.available=false → 主按钮应降级为「当前页面不支持翻译」。
  const popupShape = await popup.evaluate(() => ({
    models: document.querySelectorAll('.popup-model-row').length,
    select: document.querySelectorAll('.popup-input-select').length,
    selected: document.querySelectorAll('.popup-model-row.is-selected').length,
    primary: document.querySelector('.popup-footer .popup-btn--primary')?.textContent?.trim(),
    primaryDisabled: document.querySelector('.popup-footer .popup-btn--primary')?.disabled === true,
  }))
  check(
    'Popup 渲染模型单选列表与目标语言（D2）',
    popupShape.models === 2 && popupShape.select === 1 && popupShape.selected === 1,
    JSON.stringify(popupShape),
  )
  check(
    'Popup 主按钮在无内容脚本页降级（D2 边界）',
    popupShape.primary === '当前页面不支持翻译' && popupShape.primaryDisabled,
    popupShape.primary,
  )
  await popup.screenshot({ path: path.join(OUT, '09-popup.png') })

  /* ---------- 其余区块 ---------- */
  await app.goto(`chrome-extension://${extensionId}/src/pages/index.html#general`, { waitUntil: 'load' })
  await app.waitForSelector('.setting-row', { timeout: 8000 })
  check('通用设置页渲染', (await app.locator('.setting-row').count()) >= 6)
  const general = await app.evaluate(() => {
    const rows = [...document.querySelectorAll('.setting-row')]
    const rowOf = (label) =>
      rows.find((r) => r.querySelector('.setting-label')?.textContent?.trim() === label)
    return {
      labels: rows.map((r) => r.querySelector('.setting-label')?.textContent?.trim()),
      hasResetAction: Boolean(
        [...document.querySelectorAll('.tr-btn')].find(
          (b) => b.textContent?.trim() === '恢复默认',
        ),
      ),
      autoRetry: Boolean(rowOf('失败自动重试')?.querySelector('.switch-input')),
      displayModeIsSelect: Boolean(rowOf('默认显示模式')?.querySelector('select')),
      compareIsSelect: Boolean(rowOf('全文对比模型上限')?.querySelector('select')),
      historyIsSelect: Boolean(rowOf('历史保留上限')?.querySelector('select')),
      compareOptions: [...(rowOf('全文对比模型上限')?.querySelectorAll('option') ?? [])].map(
        (o) => o.textContent?.trim(),
      ),
      historyOptions: [...(rowOf('历史保留上限')?.querySelectorAll('option') ?? [])].map((o) =>
        o.textContent?.trim(),
      ),
    }
  })
  check(
    'E5 通用设置页首含「恢复默认」（A5）',
    general.hasResetAction,
    JSON.stringify(general.labels),
  )
  check(
    'E5 通用设置含「失败自动重试」开关（A5）',
    general.autoRetry && general.labels.includes('失败自动重试'),
    JSON.stringify(general.labels),
  )
  check(
    'E5 默认显示模式改为下拉（B7）',
    general.displayModeIsSelect,
    String(general.displayModeIsSelect),
  )
  check(
    'E5 对比上限 / 历史上限改为可调下拉（B8）',
    general.compareIsSelect &&
      general.historyIsSelect &&
      general.compareOptions.join(',') === '1 个,2 个,3 个' &&
      general.historyOptions.join(',') === '100 条,500 条,1000 条,5000 条',
    JSON.stringify({
      compare: general.compareOptions,
      history: general.historyOptions,
    }),
  )
  await app.screenshot({ path: path.join(OUT, '10-app-general.png'), fullPage: true })

  await app.goto(`chrome-extension://${extensionId}/src/pages/index.html#about`, { waitUntil: 'load' })
  await app.waitForSelector('.about-hero', { timeout: 8000 })
  const aboutText = await app.locator('.main-body').innerText()
  check(
    '关于页含权限说明且不含 sidePanel（C2）',
    aboutText.includes('storage') && !aboutText.includes('sidePanel'),
  )
  const about = await app.evaluate(() => ({
    versionPill: [...document.querySelectorAll('.tr-pill')]
      .map((p) => p.textContent?.trim())
      .join('|'),
    buildDate: [...document.querySelectorAll('.about-row')]
      .filter((r) => r.querySelector('.about-row-name')?.textContent?.includes('构建日期'))
      .map((r) => r.querySelector('.about-row-value')?.textContent?.trim())[0],
    hasChangelog: Boolean(
      [...document.querySelectorAll('.settings-group-title')].find(
        (t) => t.textContent?.trim() === '更新说明',
      ),
    ),
    hasLicenseCard: Boolean(
      [...document.querySelectorAll('.settings-group-title')].find(
        (t) => t.textContent?.trim() === '开源许可与反馈',
      ),
    ),
    licenseButtons: [...document.querySelectorAll('.about-license-actions .tr-btn')].map((b) =>
      b.textContent?.trim(),
    ),
    licenseText: document.querySelector('.about-license .about-footnote')?.textContent ?? '',
    // 更新说明每条的「版本 / 规划中」行 + 版本标签 + 紧随其后的说明文字（行与说明是兄弟节点）
    changelog: [...document.querySelectorAll('.about-row')]
      .map((row) => ({
        label: row.querySelector('.about-row-name')?.textContent?.trim() ?? '',
        tag: row.querySelector('.about-row-tag')?.textContent?.trim() ?? '',
        desc: row.nextElementSibling?.textContent?.trim() ?? '',
      }))
      .filter((e) => e.tag.length > 0),
    shortcutKeys: [...document.querySelectorAll('.about-row-value')]
      .map((v) => v.textContent?.trim())
      .filter((t) => (t ?? '').includes('Alt + Shift')),
  }))
  check(
    'F6 关于页含「已是最新版本」与产品版本口径（A6）',
    about.versionPill.includes('已是最新版本') && about.versionPill.includes('产品版本 v0.2.0'),
    about.versionPill,
  )
  check(
    'F6 关于页含构建日期（A6）',
    /^\d{4}-\d{2}-\d{2}$/.test(about.buildDate ?? ''),
    String(about.buildDate),
  )
  check(
    'F6 关于页含更新说明与开源许可三入口（A6）',
    about.hasChangelog &&
      about.hasLicenseCard &&
      about.licenseButtons.join(',') === '查看许可证,使用文档,反馈问题' &&
      about.licenseText.includes('OFL'),
    JSON.stringify({ buttons: about.licenseButtons, license: about.licenseText.slice(0, 40) }),
  )
  // 更新说明必须与已上线能力一致：阶段 2 已交付，G6 与 F1–F5 都不能再挂在「规划中」那一条里，
  // 而「规划中」的阶段标签必须是阶段 3（SPA 动态补翻的归属，见 docs/05）。
  const planned = about.changelog.find((e) => e.label === '规划中')
  const current = about.changelog.find((e) => e.tag === '当前版本')
  const stage1 = about.changelog.find((e) => e.label === 'v0.1.0 · 2026-09-10')
  check(
    'F6 更新说明与已上线能力一致（G6 / F1–F5 不列在「规划中」，且归属阶段 3）',
    Boolean(planned && current && stage1) &&
      planned.tag === '阶段 3' &&
      !planned.desc.includes('多模型对比') &&
      !planned.desc.includes('F1') &&
      planned.desc.includes('SPA 动态补翻') &&
      current.tag === '当前版本' &&
      current.desc.includes('多模型对比') &&
      current.desc.includes('翻译历史') &&
      stage1.tag === '阶段 1',
    JSON.stringify(about.changelog),
  )
  check(
    'F6 快捷键一览含 Alt+Shift+M（与 H1 一致）',
    about.shortcutKeys.includes('Alt + Shift + S') &&
      about.shortcutKeys.includes('Alt + Shift + T') &&
      about.shortcutKeys.includes('Alt + Shift + R') &&
      about.shortcutKeys.includes('Alt + Shift + M'),
    JSON.stringify(about.shortcutKeys),
  )
  await app.screenshot({ path: path.join(OUT, '11-app-about.png'), fullPage: true })

  /* ---------- B10 左侧导航口径 ---------- */
  const nav = await app.evaluate(() => ({
    labels: [...document.querySelectorAll('.nav-item-label')].map((n) => n.textContent?.trim()),
    foot: document.querySelector('.nav-foot')?.innerText?.replace(/\s+/g, ' ') ?? '',
  }))
  check(
    'B10 导航第 4 项为「关于 Transora」',
    nav.labels.join(',') === '模型配置,通用设置,翻译历史,关于 Transora',
    nav.labels.join(','),
  )
  check(
    'B10 导航底部为产品版本 + Manifest V3',
    nav.foot.includes('v0.2.0 · Manifest V3'),
    nav.foot,
  )

  /* ---------- B9 模型表单 7 字段 ---------- */
  await app.goto(`chrome-extension://${extensionId}/src/pages/index.html#models`, { waitUntil: 'load' })
  await app.waitForSelector('.model-card', { timeout: 8000 })
  // 进编辑态：点第一张模型卡的「编辑」
  await app.locator('.model-card .tr-btn', { hasText: '编辑' }).first().click()
  await app.waitForSelector('.editor', { timeout: 8000 })
  const editor = await app.evaluate(() => {
    const card = document.querySelector('.editor')
    return {
      labels: [...card.querySelectorAll('.field-label')].map((l) => l.textContent?.trim()),
      selects: card.querySelectorAll('select').length,
      targetLangOptions: [...(card.querySelectorAll('select')[0]?.querySelectorAll('option') ?? [])]
        .map((o) => o.textContent?.trim())
        .slice(0, 2),
      buttons: [...card.querySelectorAll('.editor-actions .tr-btn')].map((b) =>
        b.textContent?.trim(),
      ),
    }
  })
  check(
    'B9 模型表单 7 个字段（含目标语言）',
    editor.labels.length === 7 && editor.labels.includes('目标语言'),
    editor.labels.join(','),
  )
  check(
    'B9 目标语言首项为「跟随全局设置」',
    editor.selects === 1 && (editor.targetLangOptions[0] ?? '').startsWith('跟随全局设置'),
    JSON.stringify(editor.targetLangOptions),
  )
  check(
    'B9 保存按钮文案为「保存配置」',
    editor.buttons[0] === '保存配置',
    JSON.stringify(editor.buttons),
  )

  /* ---------- F1–F5 翻译历史（FR-05 / FR-06 / FR-15） ---------- */
  // 此时本轮已经跑过：整页翻译、划词翻译、多模型对比 → 三条写入路径都该留下记录
  await app.goto(`chrome-extension://${extensionId}/src/pages/index.html#history`, { waitUntil: 'load' })
  await app.waitForSelector('.history-row, .history-empty', { timeout: 8000 })
  await app.waitForTimeout(300)

  const historyHead = await app.evaluate(() => ({
    title: document.querySelector('.main-title')?.textContent?.trim(),
    desc: document.querySelector('.main-desc')?.textContent?.trim(),
    headButtons: [...document.querySelectorAll('.main-head-actions .tr-btn')].map((b) =>
      b.textContent?.trim(),
    ),
    rows: document.querySelectorAll('.history-row').length,
    metas: [...document.querySelectorAll('.history-row-meta')].map((n) => n.textContent.trim()),
    searchPlaceholder: document.querySelector('.history-search-input')?.placeholder,
    chips: [...document.querySelectorAll('.history-chip-select')].map((s) => ({
      label: s.getAttribute('aria-label'),
      value: s.value,
      options: [...s.options].map((o) => o.textContent?.trim() ?? ''),
    })),
  }))

  check(
    'F1 页头 = 实时条数副标题 + 导出 / 清空（设计稿 F1）',
    historyHead.title === '翻译历史' &&
      /^共 \d+ 条记录 · 仅存储在本机（上限 \d+ 条，超出自动清理最早的记录）$/.test(
        historyHead.desc ?? '',
      ) &&
      historyHead.headButtons.join(',') === '导出,清空',
    JSON.stringify({ desc: historyHead.desc, buttons: historyHead.headButtons }),
  )
  check(
    'F1 工具栏 = 搜索框 + 模型 / 类型 / 时间三枚 chip',
    historyHead.searchPlaceholder === '搜索原文或译文…' &&
      historyHead.chips.map((c) => c.label).join(',') === '模型,类型,时间' &&
      historyHead.chips[0].options[0] === '全部' &&
      historyHead.chips[1].options[0] === '全部' &&
      historyHead.chips[2].options[0] === '全部时间' &&
      historyHead.chips[2].value === '7d',
    JSON.stringify(historyHead.chips),
  )
  check(
    'F1 页面翻译已经落库（行数 ≥ 3，元信息为「模型 · 类型 · 时间」）',
    historyHead.rows >= 3 && historyHead.metas.every((m) => (m.match(/ · /g) ?? []).length >= 2),
    JSON.stringify({ rows: historyHead.rows, metas: historyHead.metas.slice(0, 5) }),
  )
  check(
    'FR-05 记录同时来自整页与划词两个入口（两条写入路径都通）',
    historyHead.chips[1].options.includes('整页翻译') &&
      historyHead.chips[1].options.includes('划词翻译'),
    JSON.stringify(historyHead.chips[1].options),
  )

  /* ---------- F3 详情展开 ---------- */
  await app.locator('.history-row-head').first().click()
  await app.waitForSelector('.history-detail', { timeout: 5000 })
  const detail = await app.evaluate(() => ({
    meta: document.querySelector('.history-detail-meta')?.textContent?.trim() ?? '',
    labels: [...document.querySelectorAll('.history-detail-label')].map((n) => n.textContent?.trim()),
    source: document.querySelector('.history-detail-text')?.textContent?.trim() ?? '',
    url: document.querySelector('.history-detail-url')?.textContent?.trim() ?? '',
    actions: [...document.querySelectorAll('.history-action')].map((b) => b.textContent?.trim()),
  }))
  check(
    'F3 详情卡 = 规模摘要 + 原文 / 译文 · 模型 + 来源 + 4 个行内操作',
    /段 · [\d,]+ 字/.test(detail.meta) &&
      detail.labels[0] === '原文' &&
      (detail.labels[1] ?? '').startsWith('译文 · ') &&
      detail.source.length > 0 &&
      detail.url.includes('127.0.0.1:8787') &&
      detail.actions.join(',') === '复制译文,应用到页面,打开来源,删除记录',
    JSON.stringify(detail),
  )
  await app.screenshot({ path: path.join(OUT, '12-history-detail.png'), fullPage: true })

  /* ---------- FR-06 搜索 ---------- */
  await app.fill('.history-search-input', 'zzz-一定搜不到-zzz')
  await app.waitForTimeout(200)
  const noMatch = await app.evaluate(() => ({
    rows: document.querySelectorAll('.history-row').length,
    title: document.querySelector('.history-empty-title')?.textContent?.trim(),
  }))
  check(
    'FR-06 搜不到时给「没有符合条件的记录」，不与「尚无记录」混淆',
    noMatch.rows === 0 && noMatch.title === '没有符合条件的记录',
    JSON.stringify(noMatch),
  )

  await app.fill('.history-search-input', '【译·')
  await app.waitForTimeout(200)
  const searched = await app.evaluate(() => document.querySelectorAll('.history-row').length)
  check('FR-06 关键词能命中译文（不只搜原文）', searched >= 1, String(searched))

  await app.fill('.history-search-input', '')
  await app.waitForTimeout(200)

  /* ---------- FR-06 按类型筛选 ---------- */
  await app.selectOption('.history-chip-select >> nth=1', 'selection')
  await app.waitForTimeout(200)
  const filtered = await app.evaluate(() => ({
    rows: document.querySelectorAll('.history-row').length,
    metas: [...document.querySelectorAll('.history-row-meta')].map((n) => n.textContent.trim()),
    desc: document.querySelector('.main-desc')?.textContent ?? '',
  }))
  check(
    'FR-06 类型筛选生效，且副标题显示「已筛选」（设计稿 F3）',
    filtered.rows >= 1 &&
      filtered.metas.every((m) => m.includes('划词翻译')) &&
      filtered.desc.includes('已筛选「模型：全部 / 类型：划词翻译 / 近 7 天」'),
    JSON.stringify(filtered),
  )
  await app.selectOption('.history-chip-select >> nth=1', 'all')
  await app.waitForTimeout(200)

  /* ---------- F5 导出 ---------- */
  // 拦下 Blob 与真实下载：断言导出的是**真内容**，而不只是「菜单弹出来了」
  await app.evaluate(() => {
    window.__transoraExport = null
    const original = URL.createObjectURL
    URL.createObjectURL = (blob) => {
      window.__transoraExport = blob
      return original.call(URL, blob)
    }
    HTMLAnchorElement.prototype.click = function () {}
  })

  await app.locator('.main-head-actions .tr-btn', { hasText: '导出' }).first().click()
  await app.waitForSelector('.history-export-menu', { timeout: 5000 })
  const exportOptions = await app.evaluate(() =>
    [...document.querySelectorAll('.history-export-option')].map((n) => n.textContent?.trim()),
  )
  check(
    'F5 导出菜单两项，文案照设计稿',
    exportOptions.join(',') ===
      '导出为 JSON（含完整字段与时间戳）,导出为 Markdown（便于粘贴到笔记）',
    JSON.stringify(exportOptions),
  )

  await app.locator('.history-export-option').first().click()
  const exportedJson = await app.evaluate(async () => {
    const blob = window.__transoraExport
    return blob ? await blob.text() : null
  })
  let parsedExport = null
  try {
    parsedExport = JSON.parse(exportedJson)
  } catch {
    /* 解析失败下面那条断言会报到 */
  }
  check(
    'FR-15 导出 JSON 内容完整（字段 + 人读时间 + 条数）',
    parsedExport?.app === 'Transora' &&
      parsedExport?.count >= 3 &&
      parsedExport?.records?.length === parsedExport.count &&
      typeof parsedExport?.records[0]?.timestamp === 'number' &&
      typeof parsedExport?.records[0]?.time === 'string' &&
      typeof parsedExport?.records[0]?.modelName === 'string',
    exportedJson ? exportedJson.slice(0, 140) : 'null',
  )

  /* ---------- F4 清空二次确认 ---------- */
  await app.locator('.main-head-actions .tr-btn', { hasText: '清空' }).first().click()
  await app.waitForSelector('.history-modal', { timeout: 5000 })
  const modal = await app.evaluate(() => ({
    title: document.querySelector('.history-modal-title')?.textContent?.trim(),
    desc: document.querySelector('.history-modal-desc')?.textContent?.trim(),
    warning: document.querySelector('.history-modal-warning')?.textContent?.trim(),
    buttons: [...document.querySelectorAll('.history-modal-actions .tr-btn')].map((b) =>
      b.textContent?.trim(),
    ),
    width: Math.round(document.querySelector('.history-modal').getBoundingClientRect().width),
  }))
  check(
    'F4 清空 = 遮罩 + 480 宽模态 + 不可撤销警示 + 二次确认文案',
    /^清空全部 \d+ 条翻译记录？$/.test(modal.title ?? '') &&
      (modal.desc ?? '').includes('清空后无法恢复') &&
      modal.warning === '此操作不可撤销' &&
      modal.buttons.join(',') === '确认清空,取消' &&
      modal.width === 480,
    JSON.stringify(modal),
  )
  await app.screenshot({ path: path.join(OUT, '13-history-clear-menace.png') })

  // 取消必须什么都不删 —— 二次确认的意义就在这里
  await app.locator('.history-modal-actions .tr-btn', { hasText: '取消' }).click()
  await app.waitForTimeout(250)
  const afterCancel = await app.evaluate(() => ({
    rows: document.querySelectorAll('.history-row').length,
    modal: Boolean(document.querySelector('.history-modal')),
  }))
  check(
    'F4 点「取消」不删任何记录',
    afterCancel.rows >= 3 && afterCancel.modal === false,
    JSON.stringify(afterCancel),
  )
  await app.screenshot({ path: path.join(OUT, '14-history.png'), fullPage: true })

  /* ---------- F2 空态（真的清空后） ---------- */
  await app.locator('.main-head-actions .tr-btn', { hasText: '清空' }).first().click()
  await app.waitForSelector('.history-modal', { timeout: 5000 })
  await app.locator('.history-modal-actions .tr-btn', { hasText: '确认清空' }).click()
  await app.waitForSelector('.history-empty', { timeout: 8000 })

  const cleared = await app.evaluate(() => ({
    rows: document.querySelectorAll('.history-row').length,
    title: document.querySelector('.history-empty-title')?.textContent?.trim(),
    descText: document.querySelector('.history-empty-desc')?.textContent ?? '',
    desc: document.querySelector('.main-desc')?.textContent ?? '',
    headButtonsDisabled: [...document.querySelectorAll('.main-head-actions .tr-btn')].map(
      (b) => b.disabled,
    ),
  }))

  // 直接读 IndexedDB 复核：界面说空了，库里也必须真的空（而不是只把列表藏起来）
  const dbCount = await app.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('transora-history')
        open.onerror = () => resolve(-1)
        open.onsuccess = () => {
          const count = open.result.transaction('records', 'readonly').objectStore('records').count()
          count.onsuccess = () => resolve(count.result)
          count.onerror = () => resolve(-1)
        }
      }),
  )

  check(
    'F2 清空后回到空态，且 IndexedDB 里确实是 0 条',
    cleared.rows === 0 &&
      cleared.title === '还没有翻译记录' &&
      cleared.descText.includes('不会同步到任何服务器') &&
      cleared.desc.includes('共 0 条记录') &&
      cleared.headButtonsDisabled.every(Boolean) &&
      dbCount === 0,
    JSON.stringify({ ...cleared, dbCount }),
  )
  await app.screenshot({ path: path.join(OUT, '15-history-empty.png'), fullPage: true })

  /* ---------- 无未捕获错误 ---------- */
  check('测试期间无未捕获页面错误', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 240))
} catch (err) {
  check('e2e 流程执行完成', false, String(err).slice(0, 400))
  try {
    const fallback = context.pages().find((p) => p.url().startsWith('http'))
    if (fallback) await fallback.screenshot({ path: FAILURE_SHOT })
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
