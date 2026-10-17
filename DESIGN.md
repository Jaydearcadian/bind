# DESIGN.md — Bind Supply Operator Design System
**Reference Architecture:** Superpower Editorial Telemetry (`1001394520.jpg`) × Bind Operational Governance (`SPEC_DEFINITION.md` & `PRD.md`)
**Version:** 1.0 (Tameion Agents Hackathon Release)

## 1. Visual North Star & Core Philosophy
Bind combines the **editorial warmth and precision telemetry of Superpower** with the **deterministic financial rigor of an operational treasury control room**.
- **Warm Alabaster Meets Smoked Obsidian Glass:** The primary page canvas is a calm, warm alabaster paper (`#FAF8F5`) that prevents eye fatigue during daily business operations. High-density telemetry, status pills, and navigation float inside **smoked obsidian glass containers** (`backdrop-filter: blur(20px)`) with crisp hairline borders.
- **High-Signal Vermilion Punctuation (`#FF5324`):** Color is never decorative. Primary workflow triggers (`Check Stock ->`, `Approve On-Chain ->`) and active radial ticks use a single unmistakable Signal Vermilion pill accent.
- **Editorial Display + Tabular Monospace:** Headlines use a light, high-craft humanist display face (`Plus Jakarta Sans` / `Inter Tight` at `300–500` weight with tight `-0.03em` tracking), while every dollar/USDC amount, pack multiple, Jev confidence score, and Arc transaction hash uses strict tabular monospace (`IBM Plex Mono`).
- **Authentic Iconography:** Uses official Heroicons (`@heroicons/react`, `@heroicons/vue`) 20×20 solid & 24×24 outline SVG primitives—never generic Unicode fallbacks.

---

## 2. Color Tokens (Perceptual OKLCH + Hex Fallbacks)

```css
:root {
  /* Surfaces */
  --bg-canvas: #FAF8F5;                /* oklch(0.982 0.005 78) — Primary warm alabaster canvas */
  --bg-surface: #FFFFFF;               /* oklch(1.000 0 0) — Elevated white cards & tables */
  --bg-stone: #F2EFE9;                 /* oklch(0.952 0.008 75) — Recessed deterministic math wells */
  --bg-hero-abyss: #0D222C;            /* oklch(0.245 0.038 225) — Hero atmospheric dark petrol */
  --bg-decoder-terracotta: #4A1814;    /* oklch(0.285 0.088 26) — Signal Decoder dark crimson panel */

  /* Smoked Glass Surfaces */
  --glass-nav: rgba(18, 17, 16, 0.86);
  --glass-hud: rgba(22, 20, 18, 0.78);
  --glass-border: rgba(255, 255, 255, 0.14);
  --border-hairline: #E4DFD7;
  --border-strong: #141312;

  /* Typography Ink */
  --ink-primary: #121110;              /* 17.8:1 AAA on canvas */
  --ink-secondary: #5A5650;            /* 7.2:1 AAA on canvas */
  --ink-muted: #8C867E;
  --ink-ghost: #C8C3BA;                /* Inactive Signal Decoder rows */

  /* Brand & Action Accents */
  --accent-orange: #FF5324;            /* Primary Pill CTA & Active Radial Tick */
  --accent-orange-hover: #E04114;
  --accent-glow: radial-gradient(in oklch circle at 50% 60%, oklch(0.88 0.06 45 / 0.55), transparent 70%);

  /* Semantic Verification & Policy Statuses */
  --status-confirmed: #22A06B;         /* VERIFIED_REMOTE / Confirmed on Arc Testnet */
  --status-confirmed-bg: rgba(34, 160, 107, 0.14);
  --status-hold: #F59E0B;              /* APPROVAL_REQUIRED / Manual Fulfilment Pending */
  --status-hold-bg: rgba(245, 158, 11, 0.16);
  --status-rejected: #E03131;          /* POLICY_REJECTED / 0x65e822e9 / 0xef664d6a */
  --status-rejected-bg: rgba(224, 49, 49, 0.15);
}
```

---

## 3. Typography & Hierarchy Scale
- **Display / Section Headlines (`--font-display`):** `'Plus Jakarta Sans', 'Inter', -apple-system, sans-serif`
  - **Hero Title:** `clamp(2.4rem, 5vw, 4.25rem)`, `font-weight: 400`, `line-height: 1.06`, `letter-spacing: -0.035em`
  - **Section H2 ("It starts with...", "Know your numbers..."):** `clamp(1.85rem, 3.5vw, 2.85rem)`, `font-weight: 500`, `line-height: 1.12`, `letter-spacing: -0.025em`
  - **Signal Decoder List Triggers:** `clamp(1.35rem, 2.4vw, 2.15rem)`, `font-weight: 500`, `line-height: 1.25`, transitioning from `color: var(--ink-ghost)` (`#C8C3BA`) to `color: var(--ink-primary)` (`#121110`) on active selection.
- **Operational UI & Body (`--font-sans`):** `'IBM Plex Sans', -apple-system, sans-serif`
  - **Body Copy:** `15px` (`0.9375rem`), `line-height: 1.55`, `color: var(--ink-secondary)`
  - **Eyebrow Index Labels (`01`, `02`, `03`, `HOW IT WORKS`):** `11px`, `font-family: var(--font-mono)`, `text-transform: uppercase`, `letter-spacing: 0.08em`, `color: var(--ink-muted)`
- **Telemetry, Money, & Hashes (`--font-mono`):** `'IBM Plex Mono', monospace` with `font-variant-numeric: tabular-nums`
  - **Giant Card Metric (e.g., `25` or `94.2%`):** `clamp(2.2rem, 4vw, 3.25rem)`, `font-weight: 500`, `letter-spacing: -0.03em`
  - **Table Numerals & Hashes:** `12.5px`, `font-weight: 500`

---

## 4. Signature Component Blueprints (Extracted from Reference)

### 4.1 Floating Obsidian Pill Navbar
- Anchored at `top: 20px`, `margin: 0 auto`, `max-width: 1180px`, `height: 54px`, `padding: 0 10px 0 22px`, `border-radius: 9999px`.
- Background: `var(--glass-nav)` with `backdrop-filter: blur(16px)` and `border: 1px solid rgba(255,255,255,0.12)`.
- Left: 5 main workspace view triggers (`Operations`, `Approvals`, `Activity`, `Business Setup`, `Settings`).
- Center: Lowercase geometric wordmark `bind` (`font-weight: 700`, `letter-spacing: -0.04em`, `font-size: 18px`, `#FFFFFF`).
- Right: Testnet indicator pill (`ARC-TESTNET • 5042002`) + Primary Vermilion Pill CTA (`Check Stock ->`, `background: var(--accent-orange)`, `border-radius: 9999px`, `padding: 8px 18px`).

### 4.2 The 100-Tick Radial Telemetry Dial
- Centered circular SVG (`viewBox="0 0 440 440"`) rendered with 100 radial `<line>` ticks.
- **Active Ticks:** Ticks corresponding to consumed daily budget (`dailySpent / dailySpendLimit`) and completed verification gates light up in `var(--accent-orange)` (`#FF5324`); remaining capacity ticks render in `#D8D3C8`.
- **Center Copy:** Displays the live vault budget summary ("It starts with deterministic checks — 1.0000 USDC 24h Vault Cap").
- **Bottom Overlapping Notification Card:** A crisp white card (`border-radius: 16px`, `box-shadow: 0 16px 36px rgba(18,17,16,0.08)`) overlapping the bottom arc of the dial, surfacing the active held request (`REQ-2026-0102`: 25 cases Tomatoes held above 0.0050 USDC limit) with a 1-click `Inspect & Approve ->` action.

### 4.3 3-Column Numbered Bento with Smoked-Glass Overlays (`01`, `02`, `03`)
- Each column starts with a clean top metadata block: monospace index (`01`, `02`, `03`), bold title, and 2-line description on the light canvas.
- Below the text sits a `340px`-tall rounded visual container (`border-radius: 20px`, `overflow: hidden`) housing a centered **Smoked-Glass HUD Card** (`.hud-glass-card`):
  - **Card 01 (Stock & Quote Snapshot):** Large tabular stock deficit numeral + confirmed supplier quote provenance badge (`MANUAL_RECORDED_QUOTE` vs `DEMO_SEED`).
  - **Card 02 (TypeSafe Jev & On-Chain Policy Grid):** 2-column smoked-glass checklist of 6 status pills with Heroicons indicators (`[Whitelist: PASS]`, `[Daily Cap: PASS]`, `[Jev Urgency: 4/5]`, `[Confidence: 94.2%]`, `[Idempotency: Unique]`, `[Auto Route: Held]`).
  - **Card 03 (Circle Agent Stack & 3-Way Match):** Floating white/glass hybrid card showing the confirmed Arc Testnet transaction (`0x626129...1bbb` in Block `67155117`) alongside the separate physical fulfilment status (`Order fulfilment not yet confirmed`).

### 4.4 Interactive 2-Column "Signal Decoder"
- **Left Column:** Vertical list of operational scenarios (`Low-Stock Autonomous Replenishment`, `Above-Threshold Owner Approval Hold`, `Unapproved Supplier On-Chain Revert (0x65e822e9)`, `24h Budget Cap Revert (0xef664d6a)`, `Social / POS Webhook Role Guard`, `3-Way Match Reconciliation`).
  - Active item displays a green rounded-square Heroicon badge and full `#121110` ink; inactive items fade to `#C8C3BA`.
- **Right Column:** Deep terracotta/espresso card (`background: linear-gradient(145deg, #4A1814, #1C0B09)`, `border-radius: 22px`, `padding: 32px`) with floating coordinate pins pointing to the exact contract address, error selector, Jev score, and SHA-256 `decisionHash` for the selected signal.

### 4.5 Tactile Vermilion Vault Card + 7-Tier Request Detail Inspector
- **Vault Card:** Styled after the reference's metallic orange membership card (`background: radial-gradient(circle at 25% 20%, #FF7A45, #E03E12 65%, #8F2206 100%)`, `border-radius: 18px`) displaying `BindSettlement.sol`, `0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`, Chain ID `5042002`, Treasury Balance (`#treasuryBalance`), and the `Pause Agent Execution` hardware toggle.
- **7-Tier Request Detail Inspector:** Implements the exact 7 numbered sections from `PRD.md` Section 9:
  1. Status and next required action
  2. Item, quantity, and supplier
  3. Quote/source and deterministic total calculation (`BigInt` base units)
  4. Budget, policy decision, and TypeSafe Jev score card
  5. Approval and Arc Testnet transaction evidence
  6. Order/fulfilment progress & 3-Way Match packet viewer
  7. Agent explanation and append-only event history

### 4.6 Oversized Edge-to-Edge Footer Wordmark
- Full-bleed lowercase `bind` wordmark (`font-size: clamp(5rem, 18vw, 15rem)`, `font-weight: 700`, `letter-spacing: -0.05em`, `line-height: 0.86`) filled with `linear-gradient(in oklch 90deg, #141210 0%, #7A2812 52%, #FF5324 100%)` and `-webkit-background-clip: text; color: transparent;` above a 5-column minimal architectural footer.

---

## 5. Do / Don't Guardrails (Enforcing Spec & Reference Fidelity)
- **DO** keep the page canvas warm alabaster (`#FAF8F5`) and reserve dark surfaces strictly for the Hero container, Floating Pill Nav, Smoked-Glass Bento Overlays, and Signal Decoder right-hand card.
- **DO** use exact truthful status strings: `"Confirmed on Arc Testnet"`, `"Approval required"`, `"Policy rejected"`, and `"Order fulfilment not yet confirmed"`.
- **DO** use official Heroicons (`@heroicons/react`, `@heroicons/vue`) SVG paths for all icons and status badges.
- **DON'T** use neon cyan/purple crypto gradients, candlestick charts, or chatbot bubble UIs.
- **DON'T** break any existing Playwright E2E test selectors (`tests/e2e/dashboard.spec.ts`); keep all interactive workspace tables, approval buttons, and evidence drawers accessible in the DOM.
