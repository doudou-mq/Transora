#!/usr/bin/env python3
"""Transora — build final vector logo assets.

The wordmark is converted from the real Inter TTF into SVG outlines, so the
shipped SVGs have no font dependency. The symbol is the locked "A" mark.

Run:
  /Users/liuzhiming/.workbuddy/binaries/python/envs/default/bin/python \
    extension/scripts/build-logo-svg.py
"""
import os
import json
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FONTS = os.path.join(ROOT, "brand", "fonts")
OUT = os.path.join(ROOT, "brand", "logo")
os.makedirs(OUT, exist_ok=True)

INK, BLUE, WHITE = "#111827", "#2563EB", "#FFFFFF"

# ---------------------------------------------------------------- symbol (locked)
SW = 76
LEGS = ["M256 86 L86 426", "M256 86 L426 426"]
BAR = "M158 273 L354 273"
SYM_CONTENT = 416 / 512.0          # drawn extent inside the 512 box
SYM_BOX = 512


def symbol_group(color, size, x=0.0, y=0.0):
    """Symbol scaled so its 512 box is `size` px, placed at (x, y)."""
    s = size / SYM_BOX
    inner = "".join('<path d="%s"/>' % d for d in LEGS + [BAR])
    return '<g transform="translate(%f,%f) scale(%f)"><g fill="none" stroke="%s" ' \
           'stroke-width="%d" stroke-linecap="round" stroke-linejoin="round">%s</g></g>' % (
               x, y, s, color, SW, inner)


# ---------------------------------------------------------------- wordmark
_font_cache = {}


def _font(weight):
    if weight not in _font_cache:
        f = TTFont(os.path.join(FONTS, "Inter-%d.ttf" % weight))
        _font_cache[weight] = (f, f["head"].unitsPerEm, f["OS/2"].sCapHeight,
                               f.getGlyphSet(), f.getBestCmap(), f["hmtx"])
    return _font_cache[weight]


def wordmark_paths(text, weight=600, tracking=-0.015):
    """Return (paths, advance, capHeight) in font units, y already flipped."""
    font, upm, cap, gs, cmap, hmtx = _font(weight)
    tr = tracking * upm
    paths, x = [], 0.0
    for ch in text:
        gname = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[gname].draw(TransformPen(pen, Transform(1, 0, 0, -1, x, cap)))
        d = pen.getCommands()
        if d:
            paths.append(d)
        x += hmtx[gname][0] + tr
    return paths, x - tr, cap


def wordmark_group(text, color, cap_px, x=0.0, y=0.0, weight=600, tracking=-0.015):
    """Wordmark scaled to `cap_px` cap height, placed at (x, y) top-left."""
    paths, adv, cap = wordmark_paths(text, weight, tracking)
    s = cap_px / cap
    return ('<g transform="translate(%f,%f) scale(%f)"><g fill="%s">%s</g></g>'
            % (x, y, s, color, "".join('<path d="%s"/>' % d for d in paths))), adv * s


def svg_doc(body, w, h, vb=None):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s" width="%.2f" height="%.2f">%s</svg>'
            % (vb or ("0 0 %.2f %.2f" % (w, h)), w, h, body))


def save(name, body, w, h, vb=None):
    txt = svg_doc(body, w, h, vb)
    with open(os.path.join(OUT, name), "w") as f:
        f.write(txt)
    return txt


# ---------------------------------------------------------------- lockups
WORD = "Transora"


def lockup_horizontal(cap_px, ratio, tracking, sym_color, wm_color, bg=None, weight=600):
    """Symbol optical height : wordmark cap height = ratio."""
    sym_drawn = cap_px * ratio
    sym_box = sym_drawn / SYM_CONTENT
    gap = cap_px * 0.42
    pad = cap_px * 0.5
    H = max(sym_box, cap_px)
    probe = wordmark_group(WORD, wm_color, cap_px, weight=weight, tracking=tracking)
    wm_w = probe[1]
    W = pad * 2 + sym_box + gap + wm_w
    total_h = H + pad * 2
    body = ('<rect width="%f" height="%f" fill="%s"/>' % (W, total_h, bg)) if bg else ""
    body += symbol_group(sym_color, sym_box, pad, pad + (H - sym_box) / 2)
    body += wordmark_group(WORD, wm_color, cap_px, pad + sym_box + gap,
                           pad + (H - cap_px) / 2, weight=weight, tracking=tracking)[0]
    return body, W, total_h


def lockup_stacked(cap_px, ratio, tracking, sym_color, wm_color, bg=None, weight=600):
    sym_drawn = cap_px * ratio
    sym_box = sym_drawn / SYM_CONTENT
    gap = cap_px * 0.55
    wm_w = wordmark_group(WORD, wm_color, cap_px, weight=weight, tracking=tracking)[1]
    W = max(sym_box, wm_w)
    H = sym_box + gap + cap_px
    body = ('<rect width="%f" height="%f" fill="%s"/>' % (W, H, bg)) if bg else ""
    body += symbol_group(sym_color, sym_box, (W - sym_box) / 2, 0)
    body += wordmark_group(WORD, wm_color, cap_px, (W - wm_w) / 2, sym_box + gap,
                           weight=weight, tracking=tracking)[0]
    return body, W, H


# ---------------------------------------------------------------- emit
# 1. symbol, three colourways
save("symbol-blue.svg", symbol_group(BLUE, 512), 512, 512)
save("symbol-navy.svg", symbol_group(INK, 512), 512, 512)
save("symbol-white.svg", symbol_group(WHITE, 512), 512, 512)

# 2. wordmark alone
wm_grp, wm_w = wordmark_group(WORD, INK, 100, tracking=-0.015)
save("wordmark-navy.svg", wm_grp, wm_w, 100)
wm_grp_w, wm_w2 = wordmark_group(WORD, WHITE, 100, tracking=-0.015)
save("wordmark-white.svg", wm_grp_w, wm_w2, 100)

# 3. lockups — navy on light, white on navy
b, W, H = lockup_horizontal(64, 1.45, -0.015, INK, INK)
save("lockup-horizontal.svg", b, W, H)
b, W, H = lockup_horizontal(64, 1.45, -0.015, WHITE, WHITE, bg="#0B1220")
save("lockup-horizontal-inverse.svg", b, W, H)
b, W, H = lockup_stacked(64, 1.45, -0.015, INK, INK)
save("lockup-stacked.svg", b, W, H)
# stacked lockup for presentation plates — the mark needs more presence
b, W, H = lockup_stacked(64, 1.90, -0.015, INK, INK)
save("lockup-stacked-lg.svg", b, W, H)
b, W, H = lockup_horizontal(64, 1.45, -0.015, BLUE, INK)
save("lockup-horizontal-blue.svg", b, W, H)

# 4. lockup study for review
study = []
rows = []
for cap_px in (58, 64, 70):
    for ratio in (1.30, 1.45, 1.60):
        for tracking in (-0.005, -0.015, -0.025):
            body, W, H = lockup_horizontal(cap_px, ratio, tracking, INK, INK)
            label = "cap %d · ratio %.2f · track %.3f%%" % (cap_px, ratio, tracking * 100)
            study.append(dict(cap=cap_px, ratio=ratio, tracking=tracking,
                              w=round(W, 1), h=round(H, 1)))
            rows.append(
                '<div class="row"><div class="lbl">%s</div>'
                '<div class="art">%s</div></div>' % (label, svg_doc(body, W, H)))

with open(os.path.join(OUT, "_study.html"), "w") as f:
    f.write(
        '<!doctype html><meta charset="utf-8"><style>'
        'body{margin:0;background:#FBFBF9;font:12px Inter,-apple-system,sans-serif;color:#111827;padding:28px}'
        'h1{font-size:17px;margin:0 0 3px}p{color:#6B7280;margin:0 0 20px;font-size:12px}'
        '.row{background:#fff;border:1px solid #E9E9E3;border-radius:10px;padding:14px 18px;margin-bottom:10px;'
        'display:flex;align-items:center;gap:26px}'
        '.lbl{flex:0 0 210px;font:500 11px Inter,sans-serif;color:#807D72;letter-spacing:.02em}'
        '.art{flex:1}</style>'
        '<h1>Transora — horizontal lockup study</h1>'
        '<p>Iterating symbol-height : cap-height ratio, and wordmark tracking. Inter SemiBold outlines.</p>'
        + "".join(rows))

# 5. master composition sheet (the four required compositions)
b1, W1, H1 = lockup_horizontal(64, 1.45, -0.015, INK, INK)
b2, W2, H2 = lockup_stacked(64, 1.45, -0.015, INK, INK)
b3, W3, H3 = lockup_horizontal(64, 1.45, -0.015, WHITE, WHITE, bg="#0B1220")
blocks = [
    ("Primary symbol", symbol_group(BLUE, 300), 300, 300),
    ("Symbol + wordmark", b2, W2, H2),
    ("Horizontal lockup", b1, W1, H1),
    ("Inverse lockup", b3, W3, H3),
]
cards = "".join(
    '<div class="card"><div class="cap">%s</div><div class="art">%s</div></div>'
    % (t, svg_doc(b, w, h)) for t, b, w, h in blocks)
with open(os.path.join(OUT, "_compositions.html"), "w") as f:
    f.write(
        '<!doctype html><meta charset="utf-8"><style>'
        'body{margin:0;background:#FBFBF9;font:12px Inter,-apple-system,sans-serif;color:#111827;padding:30px}'
        'h1{font-size:17px;margin:0 0 4px}p{color:#6B7280;margin:0 0 22px;font-size:12px}'
        '.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}'
        '.card{background:#fff;border:1px solid #E9E9E3;border-radius:12px;padding:20px}'
        '.cap{font:600 10px Inter,sans-serif;letter-spacing:.14em;text-transform:uppercase;'
        'color:#2563EB;margin-bottom:16px}'
        '.art{display:flex;align-items:center;justify-content:center;min-height:150px}'
        'svg{max-width:100%;height:auto}</style>'
        '<h1>Transora — logo compositions</h1>'
        '<p>The four required compositions, drawn from the locked geometry.</p>'
        '<div class="grid">' + cards + '</div>')

with open(os.path.join(OUT, "_report.json"), "w") as f:
    json.dump({"symbolContentRatio": SYM_CONTENT, "study": study}, f, indent=1)

print(json.dumps({"symbolContentRatio": round(SYM_CONTENT, 4),
                  "wordmarkWidth_semibold_t-1.5": round(wm_w, 1),
                  "studyVariants": len(study)}, indent=1))
print("wrote ->", OUT)
