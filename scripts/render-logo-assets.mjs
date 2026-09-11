// Transora — render final logo image assets.
// Run: cd extension && node scripts/render-logo-assets.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const LOGO = path.join(ROOT, 'brand', 'logo');
const EXPORT = path.join(LOGO, 'export');
const PNG = path.join(LOGO, 'png');
const EXTICONS = path.join(ROOT, 'extension', 'public', 'icons');

for (const d of [EXPORT, PNG, EXTICONS]) fs.mkdirSync(d, { recursive: true });

const EXEC =
  process.env.TRANSORA_CHROME ||
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const read = (f) => fs.readFileSync(path.join(LOGO, f), 'utf8');

// Scale an SVG to `w`; derive `h` from its own aspect ratio unless given.
const sized = (svg, w, h) => {
  const ow = parseFloat(/width="([\d.]+)"/.exec(svg)[1]);
  const oh = parseFloat(/height="([\d.]+)"/.exec(svg)[1]);
  const hh = h ?? (w * oh) / ow;
  return svg
    .replace(/width="[^"]*"/, `width="${w}"`)
    .replace(/height="[^"]*"/, `height="${hh}"`);
};

const GROUND = '#FAFAFA';
const DARK = '#0B1220';

const SYM_BLUE = read('symbol-blue.svg');
const SYM_NAVY = read('symbol-navy.svg');
const SYM_WHITE = read('symbol-white.svg');
const LOCK_H = read('lockup-horizontal.svg');
const LOCK_H_INV = read('lockup-horizontal-inverse.svg');

// rounded-square app icon: blue plate + white mark
const APP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="114" fill="#2563EB"/>
  <g transform="translate(80,80) scale(0.6875)"><g fill="none" stroke="#FFFFFF" stroke-width="76"
     stroke-linecap="round" stroke-linejoin="round">
     <path d="M256 86 L86 426"/><path d="M256 86 L426 426"/><path d="M158 273 L354 273"/>
  </g></g></svg>`;

const browser = await chromium.launch({ executablePath: EXEC });
const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
const log = [];

const shoot = async (svg, n, out) => {
  await page.setViewportSize({ width: n, height: n });
  await page.setContent(
    `<html><body style="margin:0;background:transparent;overflow:hidden">${sized(svg, n, n)}</body></html>`
  );
  const el = await page.$('svg');
  await el.screenshot({ path: out, omitBackground: true });
};

// ---------------------------------------------------------------- 1. rasters
const LADDER = [16, 24, 32, 48, 64, 96, 128, 192, 256, 512];
for (const [name, svg] of Object.entries({ blue: SYM_BLUE, navy: SYM_NAVY, white: SYM_WHITE })) {
  for (const n of LADDER) await shoot(svg, n, path.join(PNG, `symbol-${name}-${n}.png`));
}
log.push(`png/symbol-{blue,navy,white}-{${LADDER.join(',')}}.png`);

for (const n of [128, 256, 512]) await shoot(APP_ICON, n, path.join(PNG, `appicon-blue-${n}.png`));
log.push('png/appicon-blue-{128,256,512}.png');

// extension toolbar icons — the bare mark is the most legible at 16px
for (const n of [16, 32, 48, 128]) await shoot(SYM_BLUE, n, path.join(EXTICONS, `icon${n}.png`));
fs.writeFileSync(path.join(EXTICONS, 'icon.svg'), SYM_BLUE);
log.push('extension/public/icons/icon{16,32,48,128}.png + icon.svg');

// ---------------------------------------------------------------- 2. plates
const plates = [
  { file: '01-standalone-symbol.png', w: 2000, h: 2000, bg: GROUND, html: sized(SYM_BLUE, 1240, 1240) },
  { file: '02-symbol-wordmark.png', w: 2000, h: 2000, bg: GROUND, html: sized(read('lockup-stacked-lg.svg'), 1180) },
  { file: '03-horizontal-lockup.png', w: 2600, h: 1000, bg: GROUND, html: sized(LOCK_H, 1740) },
  { file: '04-centered-presentation.png', w: 2400, h: 1350, bg: GROUND, html: sized(LOCK_H, 1320) },
  { file: '05-app-icon.png', w: 1024, h: 1024, bg: GROUND, html: sized(APP_ICON, 768, 768) },
  { file: '06-inverse-lockup.png', w: 2600, h: 1000, bg: DARK, html: sized(LOCK_H_INV, 1740) },
];

// scale ladder — the "must survive 16x16" proof. Needs a real file origin so the
// 16px / 32px rasters can be shown nearest-neighbour zoomed.
const SHOW = [16, 24, 32, 48, 64, 96, 128, 192];
const cell = (n) =>
  `<div class="cell"><div class="box"><img src="png/symbol-blue-${n}.png" width="${n}" height="${n}" alt="${n}"></div><span>${n}</span></div>`;
const zoomCell = (n, mult) =>
  `<div class="cell"><div class="box"><img class="px" src="png/symbol-blue-${n}.png" width="128" height="128" alt="${n}"></div><span>${n} &rarr; ${mult}&times;</span></div>`;
fs.writeFileSync(
  path.join(LOGO, '_ladder.html'),
  `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:2400px;height:900px;background:${GROUND};overflow:hidden;
      font:13px Inter,-apple-system,sans-serif;color:#111827}
    .wrap{width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;
      padding:0 130px;box-sizing:border-box}
    .row{display:flex;align-items:flex-end;gap:60px}
    .cell{display:flex;flex-direction:column;align-items:center;gap:16px}
    .box{height:192px;display:flex;align-items:flex-end;justify-content:center}
    .cell span{font-size:12px;color:#807D72;letter-spacing:.05em}
    .px{image-rendering:pixelated;background:#fff;border:1px solid #EFEEE8;border-radius:4px}
    </style><div class="wrap"><div class="row">${SHOW.map(cell).join('')}${zoomCell(16, 8)}${zoomCell(32, 4)}</div></div>`
);
plates.push({ file: '07-scale-ladder.png', w: 2400, h: 900, goto: path.join(LOGO, '_ladder.html') });

for (const p of plates) {
  await page.setViewportSize({ width: p.w, height: p.h });
  if (p.goto) {
    await page.goto('file://' + p.goto);
  } else {
    await page.setContent(
      `<html><body style="margin:0;width:${p.w}px;height:${p.h}px;background:${p.bg};
        display:flex;align-items:center;justify-content:center;overflow:hidden">${p.html}</body></html>`
    );
  }
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(EXPORT, p.file) });
  log.push(`${p.file}  ${p.w}x${p.h}`);
}

await browser.close();
console.log(log.join('\n'));
