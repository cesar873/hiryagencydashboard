# AgenCFO Dashboard Formatting

Apply this whenever you build an HTML dashboard, report, or styled HTML deliverable for AgenCFO or one of its clients. The look should feel like **a premium dark-mode CFO terminal** — confident, financial, slightly futuristic, never busy.

## Design tokens

```css
:root {
  /* Color */
  --blue:        #1390eb;          /* primary brand */
  --blue-soft:   rgba(19,144,235,0.18);
  --green:       #22c55e;          /* positive */
  --green-soft:  rgba(34,197,94,0.18);
  --red:         #ef4444;          /* negative */
  --red-soft:    rgba(239,68,68,0.18);
  --amber:       #f59e0b;          /* warning */
  --purple:      #c084fc;          /* accent / categorical */
  --yellow:      #fde047;          /* accent / categorical */

  /* Surface — black → navy → brand-blue gradient */
  --bg: linear-gradient(180deg, #000000 0%, #001a2e 50%, #003b6f 100%);

  /* Cards / panels */
  --card:         rgba(255,255,255,0.04);
  --card-strong:  rgba(255,255,255,0.07);
  --card-border:  rgba(255,255,255,0.08);

  /* Text */
  --text:  #ffffff;
  --muted: rgba(255,255,255,0.55);
}
```

**Do not** invent or substitute the primary color. Categorical chart series may use blue → green → purple → yellow → amber, in that order.

## Typography

- **Anton** (Google Fonts) — uppercase headlines, KPI values, section titles. Letter-spacing 0.5–1.5px.
- **DM Sans** (Google Fonts) — everything else: body, labels, table cells, captions.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
```

Type scale: page title 38–44px Anton · section H2 18–20px Anton uppercase · KPI value 32–36px Anton · body 13–14px DM Sans · labels 11–12px DM Sans uppercase letter-spaced.

## Logo

Two-tone wordmark, Anton, 26–28px:

```html
<div class="logo"><span style="color:#fff">AGEN</span><span style="color:#1390eb">CFO</span></div>
```

Lives top-left of the header. Do not stretch, recolor, or italicize it.

## Layout primitives

**Background.** Set the gradient on `body` with `background-attachment: fixed` so it doesn't repeat on scroll. Page padding ~28–36px horizontal, 28px top.

**Panels** (the boxes around every section):
```css
.panel {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 20px;
  backdrop-filter: blur(12px);
}
.panel h2 {
  font-family: 'Anton', sans-serif;
  font-size: 18px; text-transform: uppercase; letter-spacing: 1px;
}
.panel .sub { color: var(--muted); font-size: 12px; margin-bottom: 14px; }
```

**KPI cards** — small uppercase label, big Anton value, one-line muted delta:
```html
<div class="kpi">
  <div class="label">Revenue · Mar 2026</div>
  <div class="value">$115,000</div>
  <div class="delta up">▲ +2.4% vs prior month</div>
</div>
```
`.delta.up` → green, `.delta.down` → red, default → muted.

**Grids.** CSS grid, 12–16px gaps. Common rows: 4-up KPI grid, 2:1 chart+side-panel, 1:1 split, 4-up mini-charts. Collapse to single column under 1100px.

**Tabs** (when there are >1 view): top of page, Anton uppercase, blue underline on active.

**Tables.**
- Headers: muted, 11px, uppercase, letter-spaced.
- Body: 13px DM Sans, tabular numerals on numeric columns.
- Row hover: `rgba(255,255,255,0.02)`.
- Subtotals: bold, top-border.
- Grand totals: bold, blue top-border, light blue tint background.

**Inline-bar table cells.** When showing magnitude inside a table cell, render the number with a small colored bar next to it. Color rule:
- Blue = revenue / inflow / primary metric
- Red = costs / outflow / negative profit
- Green = positive profit or margin
- Bar width = `Math.abs(value) / max * 80px`

```html
<div class="cell-bar"><span class="v">$15k</span><span class="b blue" style="width:64px"></span></div>
```

**Pills** for status: `.pill.active` (green), `.pill.lost` (red), `.pill.warn` (amber), `.pill.info` (blue).

## Charts (Chart.js)

Set these globals once per page:
```js
Chart.defaults.color = 'rgba(255,255,255,0.65)';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
Chart.defaults.font.family = "'DM Sans', system-ui, sans-serif";
```

Series colors by purpose:
- Revenue / primary metric → `#1390eb` blue
- Profit / positive trend → `#22c55e` green
- Costs / negative → `#ef4444` red
- Warnings / churn → `#f59e0b` amber
- Categorical with no semantic meaning → blue, green, purple, yellow, amber, in order

Conventions:
- Hide legend if only one series; otherwise top-right with `boxWidth: 10, boxHeight: 10`.
- Hide x-axis grid lines (`grid: { display: false }`); keep y-axis ticks.
- Format USD axes as `'$' + (v/1000).toFixed(0) + 'k'` for $1k+.
- Line charts: `tension: 0.35`, `pointRadius: 2–3`, `borderWidth: 2`.
- Bar charts: `borderRadius: 3–4`.

## Voice & copy

- Section headlines: Anton uppercase, 1–3 words (REVENUE TREND, AR AGING, CLIENT MOVEMENT).
- Subheads under H2: sentence-case, descriptive, 5–10 words.
- Numbers always formatted: `$1,234` for cash, `12.3%` for percentages, never raw floats.
- Negative cash: leading minus inside the dollar sign — `-$1,234`. Never parens.

## What to avoid

- No light or white backgrounds. Always dark mode.
- No emoji in UI text.
- No drop shadows beyond very subtle ones; rely on gradient bg + glass cards.
- No purple/pink/teal in primary brand chrome — those are categorical chart accents only.
- No system-ui or Inter as a primary font (DM Sans is the body font).
- No round avatars, no gradient text, no hero images.
- Do not invent brand colors. If a new category color is genuinely needed, ask first.

## Reference implementation

A working end-to-end example lives at `/Users/joeydewit/Desktop/AgenCFO/dashboard.html` (built by `build_dashboard.py`). When in doubt about how a component should look, mirror that file.
