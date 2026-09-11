// Transora mark exploration — candidate geometry, rendered at true pixel sizes.
// Run: cd extension && node scripts/build-marks.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const MARKS = path.join(ROOT, 'brand', 'marks');
const PNG = path.join(MARKS, 'png');

fs.rmSync(MARKS, { recursive: true, force: true });
fs.mkdirSync(PNG, { recursive: true });

const INK = '#111827';
const BLUE = '#2563EB';
const V = '0 0 512 512';
const SIZES = [512, 256, 128, 64, 48, 32, 24, 16];

const svg = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${V}" fill="none">${inner}</svg>`;

const stroke = (paths, color = INK, w = 80) =>
  svg(
    `<g stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">` +
      paths.map((d) => `<path d="${d}"/>`).join('') +
      `</g>`
  );

// ---------------------------------------------------------------- candidates
// Final geometry: stroke 76, apex (256,86), feet (86,426)/(426,426), bar y=273.
const A_LEGS = ['M256 86 L86 426', 'M256 86 L426 426'];
const A_BAR = 'M162 273 L350 273';
const A_COUNTER = 'M256 160 L212 244 L300 244 Z'; // tucked under the strokes

const CANDIDATES = {
  // Solid Electric Blue A — the brand colour carries the whole mark.
  'g01-blue-a': stroke([...A_LEGS, A_BAR], BLUE, 76),

  // Deep Navy A with the Electric Blue core in its counter.
  'g02-navy-a-blue-core': svg(
    `<path fill="${BLUE}" d="${A_COUNTER}"/>` +
      `<g stroke="${INK}" stroke-width="76" stroke-linecap="round" stroke-linejoin="round">` +
      [...A_LEGS, A_BAR].map((d) => `<path d="${d}"/>`).join('') +
      `</g>`
  ),

  // Monochrome A — the mono reduction of the mark.
  'g03-navy-a': stroke([...A_LEGS, A_BAR], INK, 76),

  // Alternate direction: a T whose bar carries a blue core at the junction.
  'g04-t-blue-core': svg(
    `<g stroke="${INK}" stroke-width="84" stroke-linecap="round" stroke-linejoin="round">
       <path d="M96 168 L416 168"/><path d="M256 168 L256 448"/>
     </g>
     <g stroke="${BLUE}" stroke-width="84" stroke-linecap="butt">
       <path d="M214 168 L298 168"/>
     </g>`
  ),
};

// ---------------------------------------------------------------- render
const EXEC =
  process.env.TRANSORA_CHROME ||
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const browser = await chromium.launch({ executablePath: EXEC });
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const page = await ctx.newPage();

const written = [];
for (const [id, s] of Object.entries(CANDIDATES)) {
  fs.writeFileSync(path.join(MARKS, `${id}.svg`), s);
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent;overflow:hidden">${s.replace(
        '<svg ',
        `<svg width="${size}" height="${size}" `
      )}</body></html>`
    );
    const el = await page.$('svg');
    await el.screenshot({ path: path.join(PNG, `${id}-${size}.png`), omitBackground: true });
  }
  written.push(id);
}
await browser.close();

// ---------------------------------------------------------------- contact sheet
const rows = written
  .map((id) => {
    const cells = SIZES.map(
      (s) => `<div class="cell"><img src="png/${id}-${s}.png" width="${s}" height="${s}"><span>${s}</span></div>`
    ).join('');
    const zoom =
      `<div class="cell zoom"><img src="png/${id}-16.png" width="128" height="128"><span>16 → 8×</span></div>` +
      `<div class="cell zoom"><img src="png/${id}-32.png" width="128" height="128"><span>32 → 4×</span></div>`;
    return `<div class="row"><div class="name">${id}</div><div class="strip">${cells}${zoom}</div></div>`;
  })
  .join('');

fs.writeFileSync(
  path.join(MARKS, 'sheet.html'),
  `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#F4F6FB;font:13px/1.4 Inter,-apple-system,sans-serif;color:#111827;padding:32px}
  h1{font-size:18px;font-weight:600;margin:0 0 4px}
  p.sub{margin:0 0 24px;color:#6B7280;font-size:12px}
  .row{background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:16px 20px;margin-bottom:14px}
  .name{font:600 13px Inter,sans-serif;letter-spacing:.02em;margin-bottom:12px;color:#2563EB}
  .strip{display:flex;align-items:flex-end;gap:18px}
  .cell{display:flex;flex-direction:column;align-items:center;gap:6px}
  .cell span{font-size:10px;color:#9CA3AF;font-variant-numeric:tabular-nums}
  .zoom img{image-rendering:pixelated;padding:4px;background:#F9FAFB;border:1px solid #EEF2F7;border-radius:4px}
  </style><h1>Transora — mark candidates</h1>
  <p class="sub">True pixel sizes, deviceScaleFactor 1. Right two columns are nearest-neighbour zooms of the 16px and 32px renders.</p>${rows}`
);

console.log('marks written:', written.join(', '));
