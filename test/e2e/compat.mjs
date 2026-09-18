/**
 * 三端兼容性验证 —— `docs/00` §6.1 · G-1 的六条实机清单。
 *
 * 为什么单独开一个脚本，而不是并进 smoke.mjs：
 *   smoke.mjs 回答的是「功能对不对」，它跑在 Playwright 自带的 Chromium 上；
 *   本脚本回答的是「**换一个浏览器还能不能跑**」——360 / QQ 这类国产 Chromium 分支
 *   有权限熔断、内核锁频、扩展分发白名单等定制，只有真机侧载才能得到结论。
 *
 * 六条判据（原文见 `docs/00` §6.1）：
 *   1. 内核版本 ≥ Chromium 111
 *   2. 加载 MV3 扩展后 Service Worker 注册成功
 *   3. 声明 activeTab / scripting / contextMenus 未被熔断
 *   4. 静态声明式 content script 注入生效
 *   5. 从 Background 发起跨域 fetch 拿到 200 响应体
 *   6. chrome.runtime.onInstalled 能自动打开扩展独立页（C1 落地页）
 *
 * 两条启动通道（自动降级）：
 *   A. `launchPersistentContext`（Playwright 标准通道，走 `--remote-debugging-pipe`）
 *   B. 自己 spawn 浏览器 + `--remote-debugging-port` + `connectOverCDP`
 *   → 国产浏览器常把 pipe 通道裁掉（表现为 launch 超时），B 是其上唯一的替换路径。
 *
 * 用法：
 *   npm run build
 *   npm run test:compat                      # 探测本机全部目标
 *   TRANSORA_COMPAT_ONLY=360 npm run test:compat
 *   TRANSORA_COMPAT_360=/path/to/bin npm run test:compat   # 手工指定可执行文件
 *
 * 产出：`.verify/compat-report.json`（逐端逐条的判据结果）+ 控制台对照表。
 *
 * ⚠️ 有头启动：侧载扩展需要持久化上下文，且国产浏览器对新 headless 的支持未知，
 * 所以默认**弹出窗口**跑（`TRANSORA_COMPAT_HEADLESS=1` 可强制加 `--headless=new`）。
 */

import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockServer } from './mock-server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = path.join(ROOT, 'dist')
const OUT = path.join(ROOT, '.verify')
const PORT = Number(process.env.TRANSORA_COMPAT_PORT ?? 8788)
const ONLY = process.env.TRANSORA_COMPAT_ONLY
  ? process.env.TRANSORA_COMPAT_ONLY.split(',').map((s) => s.trim()).filter(Boolean)
  : null

/** MV3 全面落地的起点（docs/00 §6.1 判据 1） */
const MIN_CHROMIUM = 111

/* ------------------------------------------------------------------ */
/* 目标探测                                                            */
/* ------------------------------------------------------------------ */

/** macOS .app 里的可执行文件：Contents/MacOS 下第一个可执行普通文件 */
function firstExecutable(appDir) {
  const macos = path.join(appDir, 'Contents', 'MacOS')
  if (!fs.existsSync(macos)) return null
  for (const name of fs.readdirSync(macos)) {
    const full = path.join(macos, name)
    try {
      const st = fs.statSync(full)
      if (st.isFile() && (st.mode & 0o111)) return full
    } catch {
      /* 忽略读不到的条目 */
    }
  }
  return null
}

function resolveApp(appNames) {
  for (const name of appNames) {
    const dir = path.join('/Applications', name)
    if (fs.existsSync(dir)) {
      const exe = firstExecutable(dir)
      if (exe) return exe
    }
  }
  return null
}

/** Playwright 下载的 Chromium（与 smoke.mjs 同一套查找逻辑） */
function resolvePlaywrightChromium() {
  const cacheDir =
    process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  const macApp = ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']
  const layouts = [
    ['chrome-mac-arm64', macApp],
    ['chrome-mac', macApp],
    ['chrome-linux', ['chrome']],
    ['chrome-win', ['chrome.exe']],
  ]
  const found = []
  if (fs.existsSync(cacheDir)) {
    for (const entry of fs.readdirSync(cacheDir)) {
      if (!/^chromium-\d+$/.test(entry)) continue
      for (const [platform, rel] of layouts) {
        const full = path.join(cacheDir, entry, platform, ...rel)
        if (fs.existsSync(full)) found.push({ order: Number(entry.split('-')[1]), full })
      }
    }
  }
  found.sort((a, b) => b.order - a.order)
  return found[0]?.full ?? null
}

const TARGETS = [
  {
    key: 'chrome',
    label: 'Chrome / Chromium（基线对照）',
    resolve: () =>
      process.env.TRANSORA_COMPAT_CHROME ||
      resolvePlaywrightChromium() ||
      resolveApp(['Google Chrome.app']),
  },
  {
    key: '360',
    label: '360 安全浏览器',
    resolve: () => process.env.TRANSORA_COMPAT_360 || resolveApp(['360Chrome.app', '360安全浏览器.app']),
  },
  {
    // 附加对照端（不属于「三端」）：本机 `Google Chrome86.app` 实为 Chromium 114，
    // 是离 §6.1 判据线（≥111）最近的真机样本，用来验证判据本身在边界附近仍然成立。
    key: 'chrome114',
    label: 'Google Chrome86.app（附加·旧内核对照）',
    resolve: () => process.env.TRANSORA_COMPAT_CHROME114 || resolveApp(['Google Chrome86.app']),
  },
  {
    key: 'qq',
    label: 'QQ 浏览器',
    resolve: () => process.env.TRANSORA_COMPAT_QQ || resolveApp(['QQBrowser.app', 'QQ浏览器.app']),
  },
]

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeout, interval = 250) {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await sleep(interval)
  }
}

/** 六条判据的容器；passed 允许三态：true / false / null（null = 该端不支持探测手段） */
function makeChecks() {
  const list = []
  return {
    list,
    add(id, name, criterion, passed, detail = '') {
      list.push({ id, name, criterion, passed, detail: String(detail).slice(0, 300) })
    },
  }
}

const verdictOf = (checks) => {
  if (checks.some((c) => c.passed === false)) return 'fail'
  if (checks.some((c) => c.passed === null)) return 'partial'
  return 'pass'
}

const extensionArgs = () => [
  `--disable-extensions-except=${DIST}`,
  `--load-extension=${DIST}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate',
  // 国产浏览器未必认 `--headless=new`，默认不加
  ...(process.env.TRANSORA_COMPAT_HEADLESS === '1' ? ['--headless=new'] : []),
]

/* ------------------------------------------------------------------ */
/* 启动通道                                                            */
/* ------------------------------------------------------------------ */

/** 通道 A：Playwright 标准 launchPersistentContext（走 remote-debugging-pipe） */
async function launchViaPlaywright(exe, userDataDir) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: exe,
    headless: false,
    args: extensionArgs(),
    viewport: { width: 1280, height: 900 },
    // 国产浏览器首次冷启动明显更慢（Gatekeeper 校验 + 写共享缓存），默认给到 25s
    timeout: Number(process.env.TRANSORA_COMPAT_LAUNCH_TIMEOUT ?? 25000),
  })
  return { channel: 'playwright', context, browser: context.browser(), close: () => context.close() }
}

/**
 * 通道 B：自己 spawn + `--remote-debugging-port` + `connectOverCDP`。
 * 国产浏览器（360 等）常把 pipe 通道裁掉，表现为 launchPersistentContext 直接超时；
 * 显式开端口再连是同一内核上唯一还能用的自动化入口。
 */
async function launchViaCdp(exe, userDataDir, port) {
  const child = spawn(
    exe,
    [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`, ...extensionArgs()],
    { stdio: 'ignore' },
  )

  const ready = await waitFor(
    async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (!r.ok) return null
        const j = await r.json()
        return j?.webSocketDebuggerUrl ? j : null
      } catch {
        return null
      }
    },
    Number(process.env.TRANSORA_COMPAT_CDP_TIMEOUT ?? 20000),
    400,
  )

  if (!ready) {
    child.kill('SIGKILL')
    return { channel: 'cdp', context: null, browser: null, close: async () => {}, error: 'CDP 端口未就绪' }
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 })
  const context = browser.contexts()[0] ?? (await browser.newContext())
  return {
    channel: 'cdp',
    context,
    browser,
    version: ready,
    close: async () => {
      await browser.close().catch(() => {})
      child.kill('SIGKILL')
    },
  }
}

/* ------------------------------------------------------------------ */
/* 单端验证                                                            */
/* ------------------------------------------------------------------ */

async function verifyTarget(target, server, index) {
  const exe = target.resolve()
  const result = {
    key: target.key,
    label: target.label,
    exe: exe ?? null,
    status: 'ok',
    kernel: null,
    checks: [],
  }

  if (!exe) {
    result.status = 'not-installed'
    return result
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `transora-compat-${target.key}-`))
  const checks = makeChecks()
  let handle = null

  try {
    /* --- 启动（A → A 重试 → B 降级） --- */
    // 为什么先原地重试 A：360 这类国产浏览器**首次冷启动**会明显超过常规内核
    // （Gatekeeper 校验 + 自己写共享缓存），实测首跑 30s 超时、紧接二跑 13s 通过。
    // 这条重试把「冷启动慢」与「根本没有自动化通道」两类失败区分开。
    let errA = null
    for (let attempt = 0; attempt < 2 && !handle; attempt += 1) {
      try {
        handle = await launchViaPlaywright(exe, userDataDir)
      } catch (err) {
        errA = err
        if (attempt === 0) await sleep(1500)
      }
    }
    if (!handle) {
      result.launchErrorA = String(errA?.message ?? errA).split('\n')[0]
      try {
        handle = await launchViaCdp(exe, userDataDir, 9400 + index)
      } catch (errB) {
        result.status = 'launch-failed'
        result.error = `A: ${result.launchErrorA} ｜ B: ${String(errB?.message ?? errB).split('\n')[0]}`
        return result
      }
      if (!handle.context) {
        result.status = 'cdp-unreachable'
        result.error = `A: ${result.launchErrorA} ｜ B: ${handle.error}`
        return result
      }
    }

    result.channel = handle.channel
    const context = handle.context

    if (!context) {
      result.status = 'launch-failed'
      result.error = result.launchErrorA ?? '无法建立浏览器上下文'
      return result
    }

    /* --- 判据 1：内核版本 --- */
    let product = ''
    let userAgent = ''
    try {
      const cdp = handle.browser
        ? await handle.browser.newBrowserCDPSession()
        : await context.newCDPSession(context.pages()[0] ?? (await context.newPage()))
      const version = await cdp.send('Browser.getVersion')
      product = version.product ?? ''
      userAgent = version.userAgent ?? ''
      await cdp.detach?.().catch?.(() => {})
    } catch (err) {
      result.versionError = String(err?.message ?? err).split('\n')[0]
    }

    const major = Number((product.match(/Chrome\/(\d+)/) ?? userAgent.match(/Chrome\/(\d+)/) ?? [])[1] ?? 0)
    result.kernel = { product, major, userAgent }
    checks.add(
      'C1',
      '内核版本 ≥ Chromium 111',
      `≥ ${MIN_CHROMIUM}`,
      major === 0 ? null : major >= MIN_CHROMIUM,
      product || userAgent || `拿不到版本号（${result.versionError ?? 'CDP 不可用'}）`,
    )

    /* --- 判据 2：Service Worker 注册 --- */
    let worker = context.serviceWorkers()[0]
    if (!worker) {
      try {
        worker = await context.waitForEvent('serviceworker', { timeout: 15000 })
      } catch {
        worker = null
      }
    }
    const extensionId = worker ? new URL(worker.url()).host : null
    result.extensionId = extensionId
    checks.add(
      'C2',
      'MV3 Service Worker 注册成功',
      'SW 处于运行态且能取到扩展 ID',
      Boolean(worker && extensionId),
      extensionId ?? '15s 内未等到 serviceworker',
    )

    /* --- 判据 6：onInstalled 自动打开扩展独立页 --- */
    // 必须在「自己打开扩展页」之前判定，否则会把自己的页面误当成自动打开的
    const autoOpened = await waitFor(
      () =>
        context
          .pages()
          .find((p) => p.url().startsWith('chrome-extension://') && p.url().includes('src/pages/index.html')),
      10000,
    )
    checks.add(
      'C6',
      'onInstalled 自动打开扩展独立页（C1 落地页）',
      '安装后自动出现 chrome-extension://…/src/pages/index.html',
      Boolean(autoOpened),
      autoOpened
        ? autoOpened.url().replace(/^chrome-extension:\/\/[^/]+/, 'chrome-extension://<id>')
        : '10s 内未自动打开',
    )

    /* --- 判据 3：权限是否被熔断 --- */
    if (extensionId) {
      const extPage = await context.newPage()
      try {
        await extPage.goto(`chrome-extension://${extensionId}/src/pages/index.html#models`, {
          waitUntil: 'load',
          timeout: 15000,
        })
        const perms = await extPage.evaluate(async () => {
          const all = await chrome.permissions.getAll()
          const manifest = chrome.runtime.getManifest()
          return {
            granted: all.permissions ?? [],
            origins: all.origins ?? [],
            declared: manifest.permissions ?? [],
            scriptingApi: typeof chrome.scripting,
            sidePanelApi: typeof chrome.sidePanel,
          }
        })
        result.permissions = perms
        const missing = perms.declared.filter((p) => !perms.granted.includes(p))
        checks.add(
          'C3',
          '声明权限未被熔断（activeTab / scripting / contextMenus）',
          '已声明权限全部出现在 permissions.getAll() 中',
          missing.length === 0,
          missing.length === 0
            ? `granted=[${perms.granted.join(',')}] origins=[${perms.origins.join(',')}]`
            : `被拦截：${missing.join(',')}`,
        )
      } catch (err) {
        checks.add(
          'C3',
          '声明权限未被熔断（activeTab / scripting / contextMenus）',
          '已声明权限全部出现在 permissions.getAll() 中',
          null,
          `无法判定：${String(err?.message ?? err).split('\n')[0]}`,
        )
      }
    } else {
      checks.add(
        'C3',
        '声明权限未被熔断（activeTab / scripting / contextMenus）',
        '已声明权限全部出现在 chrome.permissions.getAll() 中',
        null,
        '无扩展 ID，无法打开扩展页探测',
      )
    }

    /* --- 判据 4：静态声明式注入 --- */
    const page = await context.newPage()
    try {
      await page.goto(server.baseUrl, { waitUntil: 'load', timeout: 20000 })
      await page.waitForSelector('[data-transora="root"]', { state: 'attached', timeout: 10000 })
      const mounted = await page
        .waitForSelector('[data-transora="fab"] .transora-fab-btn', { timeout: 8000 })
        .then(() => true)
        .catch(() => false)
      checks.add(
        'C4',
        '静态声明式 content script 注入生效',
        '目标页出现 [data-transora="root"]，悬浮按钮挂载',
        mounted,
        mounted ? 'root + FAB 均已挂载' : 'root 出现但 FAB 未挂载',
      )
    } catch (err) {
      checks.add(
        'C4',
        '静态声明式 content script 注入生效',
        '目标页出现 [data-transora="root"]，悬浮按钮挂载',
        false,
        `注入失败：${String(err?.message ?? err).split('\n')[0]}`,
      )
    }

    /* --- 判据 5：Background 跨域 fetch --- */
    if (worker) {
      let r = null
      try {
        r = await worker.evaluate(async (url) => {
          try {
            const resp = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'compat-probe', messages: [{ role: 'user', content: '<1>ping' }] }),
            })
            const text = await resp.text()
            return { ok: resp.ok, status: resp.status, len: text.length, head: text.slice(0, 60) }
          } catch (e) {
            return { error: String((e && e.message) || e) }
          }
        }, `${server.baseUrl}/v1/chat/completions`)
      } catch (err) {
        r = { error: String(err?.message ?? err).split('\n')[0] }
      }
      checks.add(
        'C5',
        'Background 跨域 fetch 拿到 200',
        'SW 内 fetch 返回 200 且有响应体',
        Boolean(r && r.status === 200 && r.len > 0),
        r?.error ? `报错：${r.error}` : JSON.stringify(r),
      )
    } else {
      checks.add('C5', 'Background 跨域 fetch 拿到 200', 'SW 内 fetch 返回 200 且有响应体', null, '无 SW，无法探测')
    }

    if (process.env.TRANSORA_COMPAT_SHOT !== '0') {
      await page.screenshot({ path: path.join(OUT, `compat-${target.key}.png`) }).catch(() => {})
    }
  } finally {
    if (handle) await handle.close().catch(() => {})
    await sleep(500)
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }

  result.checks = checks.list
  result.verdict = verdictOf(checks.list)
  return result
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
  console.error('未找到 dist/manifest.json，请先执行 npm run build')
  process.exit(2)
}
fs.mkdirSync(OUT, { recursive: true })

const server = await startMockServer(PORT)
console.log(`mock 模型服务：${server.baseUrl}\n`)

const targets = ONLY ? TARGETS.filter((t) => ONLY.includes(t.key)) : TARGETS
const results = []
for (const [i, target] of targets.entries()) {
  process.stdout.write(`▶ ${target.label} … `)
  const r = await verifyTarget(target, server, i)
  results.push(r)
  const done = r.checks.filter((c) => c.passed === true).length
  const tag =
    r.status === 'not-installed'
      ? '未安装（N/A）'
      : r.status === 'ok'
        ? `${r.verdict.toUpperCase()} ${done}/${r.checks.length}（通道 ${r.channel}）`
        : `${r.status}：${r.error ?? ''}`
  console.log(tag)
}

await server.close()

/* ---------- 输出 ---------- */
fs.writeFileSync(
  path.join(OUT, 'compat-report.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), minChromium: MIN_CHROMIUM, results }, null, 2),
  'utf-8',
)

const cell = (r, id) => {
  const c = r.checks.find((x) => x.id === id)
  if (!c) return '—'
  return c.passed === true ? '✅' : c.passed === false ? '❌' : '⚠️'
}

console.log('\n===== 三端兼容性对照表（docs/00 §6.1）=====')
console.log(['端', '内核', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', '结论'].join(' | '))
for (const r of results) {
  if (r.status !== 'ok') {
    const na = r.status === 'not-installed' ? 'N/A' : '—'
    console.log([r.label, '—', na, na, na, na, na, na, r.status === 'not-installed' ? '未安装' : r.status].join(' | '))
    continue
  }
  console.log(
    [
      r.label,
      r.kernel?.major ? `Chromium ${r.kernel.major}` : '未知',
      cell(r, 'C1'),
      cell(r, 'C2'),
      cell(r, 'C3'),
      cell(r, 'C4'),
      cell(r, 'C5'),
      cell(r, 'C6'),
      r.verdict,
    ].join(' | '),
  )
}

console.log('\n逐条明细：')
for (const r of results) {
  console.log(`\n【${r.label}】${r.exe ?? ''}`)
  if (r.status === 'not-installed') {
    console.log('  未安装 → 记 N/A')
    continue
  }
  if (r.status !== 'ok') {
    console.log(`  启动失败：${r.error ?? ''}`)
    continue
  }
  console.log(`  启动通道：${r.channel}${r.launchErrorA ? `（A 通道失败：${r.launchErrorA}）` : ''}`)
  for (const c of r.checks) {
    const mark = c.passed === true ? 'PASS' : c.passed === false ? 'FAIL' : 'N/A '
    console.log(`  ${mark} ${c.id} ${c.name}`)
    console.log(`         判据：${c.criterion}`)
    console.log(`         实测：${c.detail}`)
  }
}
console.log(`\n报告已写入 ${path.relative(ROOT, path.join(OUT, 'compat-report.json'))}`)

const anyFail = results.some((r) => r.status === 'ok' && r.checks.some((c) => c.passed === false))
process.exit(anyFail ? 1 : 0)
