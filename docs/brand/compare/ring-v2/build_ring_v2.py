#!/usr/bin/env python3
"""A smooth way to make the ring ownable. Keeps the ring's palette and the Newsreader wordmark. (A second idea, a self-tying loop,
was drawn and dropped: its copper tail read as a swoosh.)

  pearl  A ring drawn with serif-style stroke contrast (thick sides, hairline top and bottom, like the 'o' of Newsreader) with
         a copper bead that seats in the top hairline. The bead is also the dot of the i in the wordmark.
  loop   One round-capped stroke that goes once around and tucks its own copper end inside its start: a ring that ties itself.

Run: BIND_FONT_SRC=<dir with Newsreader[opsz,wght].ttf> python3 build_ring_v2.py   (needs fonttools, shapely)
Writes pearl/assets/*.svg next to this script.
"""
import os, math
from shapely.geometry import Point, Polygon, LineString
from shapely import affinity
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get("BIND_FONT_SRC", "/tmp/fonts")
C = dict(ink="#1A1612", copper="#A94F25", plate="#F2EBDD", copper_lit="#E08A57",
         pending="#B07A00", herb="#1F6A3E", slate="#3F5A7A", tomato="#A8321C")
VB, VBM = "0 0 64 64", "-10 -16 84 92"

def svg(vb, title, body, style=""):
    st = f"<style>{style}</style>" if style else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="{title}"><title>{title}</title>{st}{body}</svg>\n'
def poly_d(p):
    s = ""
    for ring in [p.exterior] + list(p.interiors):
        s += ("M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in list(ring.coords)[:-1]) + " Z ")
    return s.strip()

# ---------------------------------------------------------------- pearl
CX = CY = 32.0
OUTER = Point(CX, CY).buffer(27, quad_segs=64)
INNER = affinity.rotate(affinity.scale(Point(CX, CY).buffer(1, quad_segs=64), 16.4, 22.7), -8, origin=(CX, CY))   # thick sides, hairline top
RING_FULL = OUTER.difference(INNER)
# the ring's hairline is thinnest where the inner ellipse is tallest; find the point of the ring nearest the top centre
BEAD_C = (CX + 0.4, 32 - 25.2)            # sits on the top hairline
BEAD_R = 5.8
HALO = Point(*BEAD_C).buffer(BEAD_R + 1.1, quad_segs=48)
RING = RING_FULL.difference(HALO)
if RING.geom_type != "Polygon":           # the hairline is cut through by the halo; keep both tapered ends as one multipolygon path
    pearl_pr = " ".join(poly_d(g) for g in RING.geoms)
else:
    pearl_pr = poly_d(RING)
pearl_pl = f"M{BEAD_C[0]-BEAD_R:.2f} {BEAD_C[1]:.2f} a{BEAD_R} {BEAD_R} 0 1 0 {2*BEAD_R} 0 a{BEAD_R} {BEAD_R} 0 1 0 {-2*BEAD_R} 0 Z"

# ---------------------------------------------------------------- loop
def spiral(r0, r1, a0, a1, n=120):
    pts = []
    for i in range(n + 1):
        t = i / n; a = math.radians(a0 + (a1 - a0) * t); r = r0 + (r1 - r0) * (t ** 1.4)
        pts.append((CX + r * math.cos(a), CY + r * math.sin(a)))
    return pts
def path_d(pts): return "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in pts)
# one stroke: starts at -100 degrees on r=23, goes clockwise once around, ends inside the start at r=14 after 330 degrees... split in two colours
ALL = spiral(23, 15.5, -105, -105 + 372)
cut = int(len(ALL) * 0.82)
loop_pr = path_d(ALL[: cut + 1])
loop_pl = path_d(ALL[cut:])
LOOP_W = 7.2

# ---------------------------------------------------------------- shared writers
def make(name, kind, states, intro_css, loader_css):
    out = os.path.join(HERE, name, "assets"); os.makedirs(out, exist_ok=True)
    W = lambda f, t: open(os.path.join(out, f), "w").write(t)
    def mark(pr_fill, pl_fill, tf=""):
        t = f' transform="{tf}"' if tf else ""
        if kind == "pearl":
            return f'<path class="pr" d="{pearl_pr}" fill="{pr_fill}" fill-rule="evenodd"/><path class="pl" d="{pearl_pl}" fill="{pl_fill}"{t}/>'
        under = f'<path d="{loop_pl}" fill="none" stroke="#000" stroke-width="{LOOP_W + 4.4}" stroke-linecap="round" stroke-linejoin="round"/>'
        ids = f"k{abs(hash((pr_fill, pl_fill, tf)))%10**6}"
        return (f'<defs><mask id="{ids}" maskUnits="userSpaceOnUse" x="-10" y="-10" width="84" height="84"><rect x="-10" y="-10" width="84" height="84" fill="#fff"/>'
                f'<path d="{loop_pl}" fill="none" stroke="#000" stroke-width="{LOOP_W + 3.6}" stroke-linecap="round" stroke-linejoin="round"{(" transform=%r" % tf) if tf else ""}/></mask></defs>'
                f'<path class="pr" d="{loop_pr}" fill="none" stroke="{pr_fill}" stroke-width="{LOOP_W}" stroke-linecap="round" stroke-linejoin="round" mask="url(#{ids})"/>'
                f'<path class="pl" d="{loop_pl}" fill="none" stroke="{pl_fill}" stroke-width="{LOOP_W}" stroke-linecap="round" stroke-linejoin="round"{t}/>')
    W("bind-mark.svg", svg(VB, "Bind", mark(C["ink"], C["copper"])))
    W("bind-mark-reverse.svg", svg(VB, "Bind", mark(C["plate"], C["copper_lit"])))
    W("bind-mark-mono.svg", svg(VB, "Bind", mark("currentColor", "currentColor")))
    for label, (fill, tf, title) in states.items():
        W(f"bind-state-{label}.svg", svg(VBM, title, mark(C["ink"], fill, tf)))
    W("bind-mark-animated.svg", svg(VBM, "Bind", mark(C["ink"], C["copper"]), intro_css))
    W("bind-loader.svg", svg(VBM, "Loading", mark(C["ink"], C["copper"]), loader_css))
    W("bind-loader-reverse.svg", svg(VBM, "Loading", mark(C["plate"], C["copper_lit"]), loader_css))
    W("favicon.svg", svg(VB, "Bind", f'<style>.pr{{--c:{C["ink"]}}}@media (prefers-color-scheme:dark){{.pr{{--c:{C["plate"]}}}}}</style>' + mark(C["ink"], C["copper"]).replace(f'fill="{C["ink"]}"', 'fill="var(--c)"').replace(f'stroke="{C["ink"]}"', 'stroke="var(--c)"')))
    return out, mark

# ---- animation css
LIFT_IN = """
@media (prefers-reduced-motion:no-preference){
.pr{animation:in 220ms cubic-bezier(.2,0,0,1) both}
.pl{animation:drop 560ms 140ms both}}
@keyframes in{from{opacity:0}to{opacity:1}}
@keyframes drop{0%{transform:translateY(-28px);opacity:0;animation-timing-function:cubic-bezier(.45,0,.2,1)}
18%{opacity:1}82%{transform:translateY(1.4px);animation-timing-function:cubic-bezier(.3,.9,.2,1)}100%{transform:translateY(0)}}"""
LIFT_LOAD = """
.pl{transform:translateY(-5px)}
@media (prefers-reduced-motion:no-preference){.pl{animation:tick 1400ms infinite}}
@keyframes tick{0%{transform:translateY(-11px);animation-timing-function:cubic-bezier(.45,0,.2,1)}
24%,42%{transform:translateY(0);animation-timing-function:cubic-bezier(.45,0,.2,1)}
76%,100%{transform:translateY(-11px)}}"""
LOOP_IN = """
@media (prefers-reduced-motion:no-preference){
.pr{stroke-dasharray:200;animation:draw 620ms cubic-bezier(.45,0,.2,1) both}
.pl{animation:tuck 420ms 520ms both}}
@keyframes draw{from{stroke-dashoffset:200}to{stroke-dashoffset:0}}
@keyframes tuck{0%{transform:translate(-3px,-9px);opacity:0;animation-timing-function:cubic-bezier(.45,0,.2,1)}30%{opacity:1}80%{transform:translate(.6px,.8px);animation-timing-function:cubic-bezier(.3,.9,.2,1)}100%{transform:none}}"""
LOOP_LOAD = """
.pl{transform:translate(-1.5px,-4.5px)}
@media (prefers-reduced-motion:no-preference){.pl{animation:tick 1400ms infinite}}
@keyframes tick{0%{transform:translate(-3px,-9px);animation-timing-function:cubic-bezier(.45,0,.2,1)}
24%,42%{transform:none;animation-timing-function:cubic-bezier(.45,0,.2,1)}
76%,100%{transform:translate(-3px,-9px)}}"""

pearl_states = {"working": (C["pending"], "translate(0 -10)", "Bind: working on it"), "done": (C["herb"], "", "Bind: done"),
                "held": (C["slate"], "translate(0 -4)", "Bind: paused"), "failed": (C["tomato"], "translate(8 -10)", "Bind: needs you")}
loop_states = {"working": (C["pending"], "translate(-3 -9)", "Bind: working on it"), "done": (C["herb"], "", "Bind: done"),
               "held": (C["slate"], "translate(-1.5 -4)", "Bind: paused"), "failed": (C["tomato"], "translate(6 -10)", "Bind: needs you")}

# ---- wordmark (Newsreader 500, dotless i); the copper dot of the i is the same bead
src = TTFont(os.path.join(SRC, "Newsreader[opsz,wght].ttf"))
inst = instancer.instantiateVariableFont(src, {"wght": 500, "opsz": 72})
gs, cmap = inst.getGlyphSet(), inst.getBestCmap()
x, letters, bp, ix = 0, [], BoundsPen(gs), None
for ch, uni in [("b", ord("b")), ("i", 0x131), ("n", ord("n")), ("d", ord("d"))]:
    n = cmap[uni]; pen = SVGPathPen(gs)
    gs[n].draw(TransformPen(pen, (1, 0, 0, -1, x, 0))); gs[n].draw(TransformPen(bp, (1, 0, 0, -1, x, 0)))
    letters.append(pen.getCommands())
    if ch == "i": ix = x + gs[n].width / 2
    x += gs[n].width - 6
wx0, wy0, wx1, wy1 = bp.bounds; ASC = -wy0
def lockup(mark_fn, pr_fill, pl_fill, ink):
    BX0, BY0, BX1, BY1 = 5, 5, 59, 59
    k = ASC / (BY1 - BY0); mw = (BX1 - BX0) * k; gap = ASC * .5
    m = f'<g transform="translate({-BX0*k:.2f} {-ASC - BY0*k:.2f}) scale({k:.4f})">{mark_fn(pr_fill, pl_fill)}</g>'
    dot = f'<circle cx="{ix - 4:.0f}" cy="-1235" r="112" fill="{pl_fill}"/>'
    w = f'<g transform="translate({mw+gap:.2f} 0)"><g fill="{ink}">{"".join(f"<path d=%r/>" % l for l in letters).replace(chr(39), chr(34))}</g>{dot}</g>'
    pad = 40
    return f"{-pad} {-ASC-pad:.0f} {mw+gap+(wx1-wx0)+2*pad:.0f} {ASC+wy1+2*pad:.0f}", m + w

for name, kind, states, i_css, l_css in [("pearl", "pearl", pearl_states, LIFT_IN, LIFT_LOAD)]:
    out, mk = make(name, kind, states, i_css, l_css)
    for fn, a, b, ink in [("bind-lockup.svg", C["ink"], C["copper"], C["ink"]), ("bind-lockup-reverse.svg", C["plate"], C["copper_lit"], C["plate"])]:
        vb, body = lockup(mk, a, b, ink); open(os.path.join(out, fn), "w").write(svg(vb, "Bind", body))
open(os.path.join(HERE, "pearl", "assets", "mark-paths.js"), "w").write(f'window.BIND_PEARL = {{ pr: "{pearl_pr}", pl: "{pearl_pl}" }};\n')
print("ok")
