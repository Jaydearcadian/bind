#!/usr/bin/env python3
"""A smooth, ownable ring mark. The ring's own monoline wordmark and its palette are used exactly as they were.
(A second idea, a "coil" that slides past its own start, was drawn and dropped: it reads as a progress gauge.)

  bead  The ring's uniform round stroke with a copper bead seated in it at one o'clock. The bead is the same shape and colour as
        the dot of the i in the existing wordmark, so the mark and the name share one detail.

Run: python3 docs/brand/compare/ring-v2/build_ring_v2.py      (no dependencies)
Writes bead/assets/*.svg next to this script.
"""
import math, os, re
HERE = os.path.dirname(os.path.abspath(__file__))
RING_ASSETS = os.path.join(HERE, "..", "ring", "assets")
C = dict(ink="#1A1612", copper="#A94F25", plate="#F2EBDD", copper_lit="#E08A57",
         pending="#B07A00", herb="#1F6A3E", slate="#3F5A7A", tomato="#A8321C")
VB, VBM = "0 0 64 64", "-12 -16 88 92"

def svg(vb, title, body, style=""):
    st = f"<style>{style}</style>" if style else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="{title}"><title>{title}</title>{st}{body}</svg>\n'
def f(x): return f"{x:.2f}"

# --- the ring's existing wordmark, copied verbatim (never redrawn here)
wm = open(os.path.join(RING_ASSETS, "bind-wordmark.svg")).read()
WORD_INNER = re.search(r"</title>(.*)</svg>", wm, re.S).group(1)
def word(ink, dot):
    return WORD_INNER.replace('stroke="#1A1612"', f'stroke="{ink}"').replace('fill="#A94F25"', f'fill="{dot}"')

CX = CY = 32.0
# ---------------------------------------------------------------- bead
R, SW = 20.0, 6.0
BEAD_A, BEAD_R = math.radians(-60), 6.4
bx, by = CX + R * math.cos(BEAD_A), CY + R * math.sin(BEAD_A)
DIR = (math.cos(BEAD_A), math.sin(BEAD_A))
ring_d = f"M{f(CX)} {f(CY-R)} A{R} {R} 0 1 1 {f(CX)} {f(CY+R)} A{R} {R} 0 1 1 {f(CX)} {f(CY-R)}"
def bead_mark(ring_fill, bead_fill, tf=""):
    t = f' transform="{tf}"' if tf else ""
    return (f'<defs><mask id="mb" maskUnits="userSpaceOnUse" x="-12" y="-12" width="88" height="88"><rect x="-12" y="-12" width="88" height="88" fill="#fff"/>'
            f'<circle cx="{f(bx)}" cy="{f(by)}" r="{BEAD_R+1.7}" fill="#000"/></mask></defs>'
            f'<path class="pr" d="{ring_d}" fill="none" stroke="{ring_fill}" stroke-width="{SW}" stroke-linecap="round" pathLength="100" mask="url(#mb)"/>'
            f'<circle class="pl" cx="{f(bx)}" cy="{f(by)}" r="{BEAD_R}" fill="{bead_fill}"{t}/>')
def lift(n): return f"translate({f(DIR[0]*n)} {f(DIR[1]*n)})"
bead_states = {"working": (C["pending"], lift(11), "Bind: working on it"), "done": (C["herb"], "", "Bind: done"),
               "held": (C["slate"], lift(4), "Bind: paused"), "failed": (C["tomato"], lift(11) + " translate(7 4)", "Bind: needs you")}
u = lambda n: f"{f(DIR[0]*n)}px,{f(DIR[1]*n)}px"
BEAD_IN = f"""
@media (prefers-reduced-motion:no-preference){{
.pr{{stroke-dasharray:100;animation:draw 640ms cubic-bezier(.45,0,.2,1) both}}
.pl{{animation:drop 520ms 560ms both}}}}
@keyframes draw{{from{{stroke-dashoffset:100}}to{{stroke-dashoffset:0}}}}
@keyframes drop{{0%{{transform:translate({u(30)});opacity:0;animation-timing-function:cubic-bezier(.45,0,.2,1)}}
20%{{opacity:1}}80%{{transform:translate({u(-1.6)});animation-timing-function:cubic-bezier(.3,.9,.2,1)}}100%{{transform:translate(0,0)}}}}"""
BEAD_LOAD = f"""
.pl{{transform:translate({u(5)})}}
@media (prefers-reduced-motion:no-preference){{.pl{{animation:tick 1400ms infinite}}}}
@keyframes tick{{0%{{transform:translate({u(12)});animation-timing-function:cubic-bezier(.45,0,.2,1)}}
24%,42%{{transform:translate(0,0);animation-timing-function:cubic-bezier(.45,0,.2,1)}}
76%,100%{{transform:translate({u(12)})}}}}"""

def build(name, mark, states, intro, load):
    out = os.path.join(HERE, name, "assets"); os.makedirs(out, exist_ok=True)
    W = lambda fn, t: open(os.path.join(out, fn), "w").write(t)
    W("bind-mark.svg", svg(VB, "Bind", mark(C["ink"], C["copper"])))
    W("bind-mark-reverse.svg", svg(VB, "Bind", mark(C["plate"], C["copper_lit"])))
    W("bind-mark-mono.svg", svg(VB, "Bind", mark("currentColor", "currentColor")))
    for label, (fill, tf, title) in states.items():
        W(f"bind-state-{label}.svg", svg(VBM, title, mark(C["ink"], fill, tf)))
    W("bind-mark-animated.svg", svg(VBM, "Bind", mark(C["ink"], C["copper"]), intro))
    W("bind-loader.svg", svg(VBM, "Loading", mark(C["ink"], C["copper"]), load))
    W("bind-loader-reverse.svg", svg(VBM, "Loading", mark(C["plate"], C["copper_lit"]), load))
    W("favicon.svg", svg(VB, "Bind", '<style>.r{filter:none}@media (prefers-color-scheme:dark){.pr{stroke:#F2EBDD}}</style>' + mark(C["ink"], C["copper"]).replace('class="pr"', 'class="pr r"')))
    # lockup: exactly the ring's lockup geometry, with only the mark replaced
    def lock(a, b, ink, dot):
        return f'<g transform="translate(0 7) scale(.8)">{mark(a, b)}</g><g transform="translate(66 -1)">{word(ink, dot)}</g>'
    W("bind-lockup.svg", svg("0 0 192 58", "Bind", lock(C["ink"], C["copper"], C["ink"], C["copper"])))
    W("bind-lockup-reverse.svg", svg("0 0 192 58", "Bind", lock(C["plate"], C["copper_lit"], C["plate"], C["copper_lit"])))
    W("mark-paths.js", f"/* bead: the ring path and bead position in a 64 x 64 box */\nwindow.BIND_V2 = {{ ring: '{ring_d}', bx: {f(bx)}, by: {f(by)}, br: {BEAD_R}, sw: {SW}, dx: {f(DIR[0])}, dy: {f(DIR[1])} }};\n")

build("bead", bead_mark, bead_states, BEAD_IN, BEAD_LOAD)
print("ok")
