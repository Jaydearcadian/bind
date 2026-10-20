// Generates the Bind brand SVGs from one set of constants, so the mark, the wordmark and the lockup cannot drift apart.
// Usage: node docs/brand/build-assets.mjs        (writes docs/brand/assets/*.svg)
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "assets");
mkdirSync(OUT, { recursive: true });

const C = {
  ink: "#1A1612", copper: "#A94F25", bone: "#F5F0E6",
  inkDark: "#F2EBDD", copperDark: "#E08A57",
  pending: "#B07A00", approved: "#1F6A3E", held: "#3F5A7A", refused: "#A8321C",
};

// Mark geometry (viewBox 0 0 64 64): a ring centred at 32,32, radius 20, stroke 6, with a latch (the clasp) at the top.
// Open ring = proposed. Closed ring = committed.
const arcs = (r, cx = 32, cy = 32) => {
  const pt = (deg) => `${(cx + r * Math.cos((deg * Math.PI) / 180)).toFixed(2)} ${(cy + r * Math.sin((deg * Math.PI) / 180)).toFixed(2)}`;
  // The ring leaves a 56 degree gap at the top; the latch covers 48 degrees of it, so its round caps overlap the ring ends.
  return {
    ring: `M${pt(-62)} A${r} ${r} 0 1 1 ${pt(-118)}`,
    clasp: `M${pt(-114)} A${r} ${r} 0 0 1 ${pt(-66)}`,
  };
};
const { ring: RING, clasp: CLASP } = arcs(20);
const FAV = arcs(24);

const markBody = (ring, clasp, extra = "") =>
  `<path class="ring" d="${RING}" fill="none" stroke="${ring}" stroke-width="6" stroke-linecap="round" pathLength="100"/>` +
  `<path class="clasp" d="${CLASP}" fill="none" stroke="${clasp}" stroke-width="6" stroke-linecap="round"${extra}/>`;

const svg = (vb, title, body, style = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-label="${title}"><title>${title}</title>${style ? `<style>${style}</style>` : ""}${body}</svg>\n`;

const write = (name, text) => writeFileSync(join(OUT, name), text);

// Static marks
write("bind-mark.svg", svg("0 0 64 64", "Bind", markBody(C.ink, C.copper)));
write("bind-mark-mono.svg", svg("0 0 64 64", "Bind", markBody("currentColor", "currentColor")));
write("bind-mark-reverse.svg", svg("0 0 64 64", "Bind", markBody(C.inkDark, C.copperDark)));

// State marks: the latch position and colour carry the state, never colour alone.
const lift = ' transform="translate(0 -9)"';
const jam = ' transform="rotate(16 32 32)"';
const askew = ' transform="translate(0 -9) rotate(-18 32 32)"';
write("bind-state-pending.svg", svg("0 0 64 64", "Bind: waiting for you", markBody(C.ink, C.pending, lift)));
write("bind-state-approved.svg", svg("0 0 64 64", "Bind: done", markBody(C.ink, C.approved)));
write("bind-state-held.svg", svg("0 0 64 64", "Bind: paused", markBody(C.ink, C.held, jam)));
write("bind-state-refused.svg", svg("0 0 64 64", "Bind: refused", markBody(C.ink, C.refused, askew)));

// Animated intro: the ring draws, then the latch drops in and seats. 1.5 s, plays once. The animation sits inside prefers-reduced-motion:no-preference, so the default and the reduced-motion view are the finished mark.
const introCss = `
@media (prefers-reduced-motion:no-preference){
.ring{stroke-dasharray:100;animation:draw 700ms cubic-bezier(.2,0,0,1) both}
.clasp{animation:seat 520ms 640ms cubic-bezier(.2,0,0,1) both}
.all{transform-box:fill-box;transform-origin:center;animation:settle 380ms 1100ms cubic-bezier(.2,0,0,1) both}
}
@keyframes draw{from{stroke-dashoffset:100}to{stroke-dashoffset:0}}
@keyframes seat{0%{transform:translateY(-14px);opacity:0}60%{opacity:1}82%{transform:translateY(1.2px)}100%{transform:translateY(0);opacity:1}}
@keyframes settle{0%{transform:scale(1)}45%{transform:scale(1.035)}100%{transform:scale(1)}}`;
write("bind-mark-animated.svg", svg("0 0 64 64", "Bind", `<g class="all">${markBody(C.ink, C.copper)}</g>`, introCss));

// Wordmark: monoline letters on the same 5-unit stroke as the mark, no font needed. The dot of the i is the latch colour.
const W = 5;
const word = (ink, dot) =>
  `<g fill="none" stroke="${ink}" stroke-width="${W}" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M10 10V46"/><circle cx="22" cy="34" r="12"/>` + // b
  `<path d="M47 22V46"/>` + // i stem
  `<path d="M58 46V33A11 11 0 0 1 80 33V46"/>` + // n
  `<circle cx="103" cy="34" r="12"/><path d="M115 10V46"/>` + // d
  `</g><circle cx="47" cy="11" r="3.4" fill="${dot}"/>`;
write("bind-wordmark.svg", svg("0 0 126 58", "Bind", word(C.ink, C.copper)));
write("bind-wordmark-reverse.svg", svg("0 0 126 58", "Bind", word(C.inkDark, C.copperDark)));

// Lockup: mark at 0.8 scale, then the wordmark. Mark box 64 -> 51; wordmark follows after a 14-unit gap.
const lock = (ring, clasp, ink, dot) =>
  `<g transform="translate(0 7) scale(.8)">${markBody(ring, clasp)}</g><g transform="translate(66 -1)">${word(ink, dot)}</g>`;
write("bind-lockup.svg", svg("0 0 192 58", "Bind", lock(C.ink, C.copper, C.ink, C.copper)));
write("bind-lockup-reverse.svg", svg("0 0 192 58", "Bind", lock(C.inkDark, C.copperDark, C.inkDark, C.copperDark)));

// Favicon: heavier stroke for 16 px, follows the system theme.
write("favicon.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>Bind</title><style>.r{stroke:${C.ink}}.c{stroke:${C.copper}}@media (prefers-color-scheme:dark){.r{stroke:${C.inkDark}}.c{stroke:${C.copperDark}}}</style>` +
  `<path class="r" d="${FAV.ring}" fill="none" stroke-width="10" stroke-linecap="round"/><path class="c" d="${FAV.clasp}" fill="none" stroke-width="10" stroke-linecap="round"/></svg>\n`);

// Loader (added for the comparison, 2026-10-20): the latch lifts out, seats, dwells, and lifts again. 1.4 s loop.
const loadCss = `
.clasp{transform:translateY(-5px)}
@media (prefers-reduced-motion:no-preference){.clasp{animation:lift 1400ms infinite}}
@keyframes lift{
0%{transform:translateY(-9px);animation-timing-function:cubic-bezier(.45,0,.2,1)}
28%,52%{transform:translateY(0);animation-timing-function:cubic-bezier(.45,0,.2,1)}
80%,100%{transform:translateY(-9px)}}`;
write("bind-loader.svg", svg("-8 -12 80 80", "Loading", markBody(C.ink, C.copper), loadCss));
write("bind-loader-reverse.svg", svg("-8 -12 80 80", "Loading", markBody(C.inkDark, C.copperDark), loadCss));
console.log("wrote", OUT);
