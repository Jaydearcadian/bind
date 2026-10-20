#!/usr/bin/env python3
"""Generates the Bind brand SVGs and web fonts from one set of constants, so the mark, wordmark and lockup cannot drift.

Run:   python3 docs/brand/build_assets.py
Needs: pip install fonttools brotli shapely   (and the three OFL font files in docs/brand/fonts-src, see BRAND.md)
Writes docs/brand/assets/*.svg and docs/brand/fonts/*.woff2.
"""
import os, sys
from shapely.geometry import Polygon, box
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "assets")
SRC = os.environ.get("BIND_FONT_SRC", os.path.join(HERE, "fonts-src"))
os.makedirs(OUT, exist_ok=True)

C = dict(cast="#1A1F12", olive="#272E18", pass_="#E9EBE2", plate="#F8F9F3", yolk="#F5C518", chili="#BE2F19",
         steel="#5F675A", chili_on_dark="#FF7A63", steel_on_dark="#A9B0A0")

# ---------------------------------------------------------------- mark geometry (64 x 64 box)
# A square split by a dovetail seam. The left piece carries the flared tongue; the right piece holds the groove. A dovetail
# only slides along the seam (vertically), so a piece that is offset up or down reads as "in motion" and aligned reads "seated".
BODY = box(4, 4, 60, 60).buffer(-9).buffer(9, quad_segs=10)               # rounded square, r = 9
LEFT0 = BODY.intersection(box(0, 0, 32, 64)).union(Polygon([(32, 23), (47, 16), (47, 48), (32, 41)]))
RIGHT0 = BODY.difference(LEFT0)

def shape(poly):
    p = poly.buffer(-0.7, join_style=2)                                     # 1.4 unit seam between the pieces
    p = p.buffer(-1.3, join_style=1, quad_segs=6).buffer(1.3, join_style=1, quad_segs=6)   # round convex corners
    p = p.buffer(1.1, join_style=1, quad_segs=6).buffer(-1.1, join_style=1, quad_segs=6)   # round concave corners
    return p.simplify(0.02)

def d(poly):
    pts = list(poly.exterior.coords)[:-1]
    return "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in pts) + " Z"

PL, PR = d(shape(LEFT0)), d(shape(RIGHT0))
BX0, BY0, BX1, BY1 = shape(BODY.buffer(0)).bounds                          # visible bounds of the whole mark

def svg(vb, title, body, style="", extra=""):
    st = f"<style>{style}</style>" if style else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="{title}"{extra}><title>{title}</title>{st}{body}</svg>\n'

def mark(left_fill, right_fill, dy=0, cls=""):
    t = f' transform="translate(0 {dy})"' if dy else ""
    return (f'<path class="pr" d="{PR}" fill="{right_fill}"/>'
            f'<path class="pl" d="{PL}" fill="{left_fill}"{t}/>')

def write(name, text):
    open(os.path.join(OUT, name), "w").write(text)

VB = "0 0 64 64"
VBM = "-8 -8 80 80"      # extra room for assets in which the left piece moves off the seat
write("bind-mark.svg", svg(VB, "Bind", mark(C["yolk"], C["cast"])))
write("bind-mark-reverse.svg", svg(VB, "Bind", mark(C["yolk"], C["plate"])))
write("bind-mark-mono.svg", svg(VB, "Bind", mark("currentColor", "currentColor")))
write("bind-mark-yolk.svg", svg(VB, "Bind", mark(C["cast"], C["yolk"])))   # for use on a yolk field

# States: how far the left piece sits from the seat, and its colour, say the state. A text label is always shown too.
write("bind-state-working.svg", svg(VBM, "Bind: working on it", mark(C["yolk"], C["cast"], -10)))
write("bind-state-done.svg", svg(VBM, "Bind: done", mark(C["cast"], C["cast"], 0)))
write("bind-state-held.svg", svg(VBM, "Bind: paused", mark(C["steel"], C["cast"], -4)))
write("bind-state-failed.svg", svg(VBM, "Bind: needs attention", mark(C["chili"], C["cast"], 10)))

# ---------------------------------------------------------------- animated mark ("slide and seat", 0.75 s, plays once)
INTRO = """
@media (prefers-reduced-motion:no-preference){
.pr{animation:pr-in 160ms cubic-bezier(.45,0,.2,1) both,pr-knock 170ms 568ms cubic-bezier(.3,.9,.2,1) both}
.pl{animation:pl-slide 560ms 120ms both}
}
@keyframes pr-in{from{opacity:0}to{opacity:1}}
@keyframes pr-knock{0%{transform:translateY(0)}45%{transform:translateY(.9px)}100%{transform:translateY(0)}}
@keyframes pl-slide{
0%{transform:translateY(30px);opacity:0;animation-timing-function:cubic-bezier(.45,0,.2,1)}
18%{opacity:1}
80%{transform:translateY(-1.6px);animation-timing-function:cubic-bezier(.3,.9,.2,1)}
100%{transform:translateY(0);opacity:1}}"""
write("bind-mark-animated.svg", svg(VBM, "Bind", mark(C["yolk"], C["cast"]), INTRO))

# ---------------------------------------------------------------- loader ("tick-tock": the piece passes the seat twice per cycle)
LOAD = """
.pl{transform:translateY(-5px)}
@media (prefers-reduced-motion:no-preference){
.pl{animation:tick 1400ms infinite}
}
@keyframes tick{
0%{transform:translateY(-10px);animation-timing-function:cubic-bezier(.45,0,.2,1)}
22%,34%{transform:translateY(0);animation-timing-function:cubic-bezier(.45,0,.2,1)}
56%{transform:translateY(10px);animation-timing-function:cubic-bezier(.45,0,.2,1)}
72%,84%{transform:translateY(0);animation-timing-function:cubic-bezier(.45,0,.2,1)}
100%{transform:translateY(-10px)}}"""
write("bind-loader.svg", svg(VBM, "Loading", mark(C["yolk"], C["cast"]), LOAD))
write("bind-loader-reverse.svg", svg(VBM, "Loading", mark(C["yolk"], C["plate"]), LOAD))

# ---------------------------------------------------------------- wordmark (outlined from Bricolage Grotesque 700, OFL)
src = TTFont(os.path.join(SRC, "BricolageGrotesque[opsz,wdth,wght].ttf"))
inst = instancer.instantiateVariableFont(src, {"wght": 700, "wdth": 100, "opsz": 96})
gs, cmap = inst.getGlyphSet(), inst.getBestCmap()
x, letters = 0, []
bp = BoundsPen(gs)
for ch in "bind":
    name = cmap[ord(ch)]
    pen = SVGPathPen(gs)
    gs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
    gs[name].draw(TransformPen(bp, (1, 0, 0, -1, x, 0)))
    letters.append(pen.getCommands())
    x += gs[name].width
wx0, wy0, wx1, wy1 = bp.bounds           # y is negative above the baseline
ASC = -wy0                                # ascender height in font units
TRACK = -6                                # tighten slightly

def word(fill, cls=True):
    g = "".join(f'<path class="l{i}" d="{p}"/>' for i, p in enumerate(letters))
    return f'<g fill="{fill}">{g}</g>'

pad = 40
write("bind-wordmark.svg", svg(f"{wx0-pad:.0f} {wy0-pad:.0f} {wx1-wx0+2*pad:.0f} {ASC+wy1+2*pad:.0f}", "Bind", word(C["cast"])))
write("bind-wordmark-reverse.svg", svg(f"{wx0-pad:.0f} {wy0-pad:.0f} {wx1-wx0+2*pad:.0f} {ASC+wy1+2*pad:.0f}", "Bind", word(C["plate"])))

# ---------------------------------------------------------------- lockup: the mark's height equals the ascender height, bottom on the baseline
k = ASC / (BY1 - BY0)
mw = (BX1 - BX0) * k
gap = ASC * 0.26
def lockup(ring_fill, left_fill, word_fill, with_class=False, style=""):
    m = f'<g transform="translate({-BX0*k:.2f} {-ASC - BY0*k:.2f}) scale({k:.4f})">{mark(left_fill, ring_fill)}</g>'
    w = f'<g transform="translate({mw+gap:.2f} 0)">{word(word_fill)}</g>'
    vb = f"{-pad} {-ASC-pad:.0f} {mw+gap+(wx1-wx0)+2*pad:.0f} {ASC+wy1+2*pad:.0f}"
    return vb, m + w
vb, body = lockup(C["cast"], C["yolk"], C["cast"]); write("bind-lockup.svg", svg(vb, "Bind", body))
vb, body = lockup(C["plate"], C["yolk"], C["plate"]); write("bind-lockup-reverse.svg", svg(vb, "Bind", body))

LOCK_ANIM = INTRO.replace("translateY(30px)","translateY(16px)") + """
@media (prefers-reduced-motion:no-preference){
.l0,.l1,.l2,.l3{animation:letter 260ms both cubic-bezier(.3,.9,.2,1)}
.l0{animation-delay:520ms}.l1{animation-delay:565ms}.l2{animation-delay:610ms}.l3{animation-delay:655ms}
}
@keyframes letter{from{transform:translateY(40px);opacity:0}to{transform:translateY(0);opacity:1}}"""
vb, body = lockup(C["cast"], C["yolk"], C["cast"]); write("bind-lockup-animated.svg", svg(vb, "Bind", body, LOCK_ANIM))
vb, body = lockup(C["plate"], C["yolk"], C["plate"]); write("bind-lockup-animated-reverse.svg", svg(vb, "Bind", body, LOCK_ANIM))

# favicon: heavier seam, theme aware
write("favicon.svg",
      f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>Bind</title><style>.pr{{fill:{C["cast"]}}}@media (prefers-color-scheme:dark){{.pr{{fill:{C["plate"]}}}}}</style>'
      f'<path class="pr" d="{PR}"/><path d="{PL}" fill="{C["yolk"]}"/></svg>\n')

# ---------------------------------------------------------------- web fonts (woff2 subsets are not made: whole files, OFL)
FD = os.path.join(HERE, "fonts")
os.makedirs(FD, exist_ok=True)
for fname, outname in [("BricolageGrotesque[opsz,wdth,wght].ttf", "BricolageGrotesque-var.woff2"),
                       ("InstrumentSans[wdth,wght].ttf", "InstrumentSans-var.woff2"),
                       ("IBMPlexMono-Medium.ttf", "IBMPlexMono-Medium.woff2")]:
    f = TTFont(os.path.join(SRC, fname)); f.flavor = "woff2"; f.save(os.path.join(FD, outname))

open(os.path.join(OUT, "mark-paths.js"), "w").write(
    "/* Generated by build_assets.py. The two mark paths in a 64 x 64 box, for pages that build the inline mark. */\n"
    f'window.BIND_MARK = {{ pl: "{PL}", pr: "{PR}" }};\n')
print("mark bounds", round(BX0, 2), round(BY0, 2), round(BX1, 2), round(BY1, 2), "| ascender", ASC, "| wrote", OUT)
