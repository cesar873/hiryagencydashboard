# Finance Dashboard — Tab Structure & Phasing

> **Purpose.** Defines which tabs exist in an AgenCFO-style finance dashboard, what lives on each, and the order they're built in. Together with [formatting.md](formatting.md) this is enough to ship a dashboard end-to-end. Formatting tells you how things look; this file tells you what to build.
>
> **Audience.** Claude reads this when a team member is setting up a new client dashboard or extending an existing one.
>
> **Reference build.** This repo (`finance-dashboard-system`) is the canonical AgenCFO template. Treat it as the "looks-like-this" example for every tab — what you ship for a client must match this template in structure, layout, and behaviour. Per-client differences (sheet column names, available metrics, optional tabs) are normalised at the data layer, never in the UI.

---

## Phase model

Build dashboards in this order. Don't jump ahead — Phase 2 depends on Phase 1's range behavior, Phase 3 depends on Phase 1 + 2.

| Phase | Tabs added | Unlocks | Typical client tier |
|---|---|---|---|
| **1** Historic Only | Financials · Revenue · Expenses | Past-only reporting from QBO data | Bookkeeping / simple dashboard |
| **2** Forecasting & Analytics | + Analytics | Forecast months enabled in the global range; unit economics view | CFO baseline |
| **3** Client & People Profitability | + Clients · People | Per-client and per-person P&L | Full CFO (with time tracking populated) |
| **Operations** | + Payments | Day-to-day AR / invoice operations: pipeline, outstanding, AR grid | Any phase — bolt-on when the client wants invoice ops visibility |

**Client tier mapping:**
- **Bookkeeping clients** ship at Phase 1 and stop there.
- **CFO clients** go through all three phases as data becomes available.
- **Operations** is independent of the phase ladder — bolt it on whenever the client has invoice data in the sheet (`Invoices` tab). Most clients ship Operations alongside Phase 1 or Phase 2.

**Navigation order** (left → right in the top nav). Payments always sits at the end:
```
Phase 1:                Financials  Revenue  Expenses
Phase 1 + Operations:   Financials  Revenue  Expenses                              Payments
Phase 2:                Financials  Revenue  Expenses  Analytics                   Payments  (if Operations on)
Phase 3:                Financials  Revenue  Expenses  Analytics  Clients  People  Payments  (if Operations on)
```

---

## Universal setup protocol

**Apply this every time a tab is being added.**

When the user asks to build a tab:

1. **Read their Google Sheet first.** Use the `lib/sources/<tab>.ts` helpers if they exist, or `readTab(tabName)` to inspect the raw shape. Don't write code until you know what's there.
2. **Match against the required-fields list for that tab** (see each tab's "Sheet inputs" section below).
3. **For every required field that's missing or named differently, ask before assuming.**
   - Example: "Your sheet has a column called `Category` where the template expects `Service Line`. Should I treat these as the same?"
   - Example: "I don't see a `Status` row in your Finance Model. Without it, forecast styling won't apply. Should I detect forecast months by date instead, or do you want to add a Status row?"
4. **Where it's safe to assume, assume — but say so in chat before you build.** Format: `"Assumption: <thing>. <why>. Push back if wrong."`
5. **If the user's sheet is missing a whole concept** (e.g. no Budget tab → can't do Budget Achievement KPI): build the tab without that section and call out in chat what was skipped and what would unlock it.
6. **Don't invent fields**. If a number isn't in the sheet, the KPI shows `—` (em-dash), the chart hides, or the table column disappears. Never fabricate.

This applies in every phase. The "ask questions, share assumptions" loop is the contract.

---

## Universal page skeleton

**Every tab uses this exact structure**, in this order:

```tsx
export default async function <Tab>Page({ searchParams }) {
  // 1. Parse global filters from URL (months, from, to)
  // 2. Fetch source data in parallel via Promise.all
  // 3. Compute selectedMonths (default = [latestActualIso])
  // 4. Compute priorPeriod (same length, immediately before selectedMonths)

  return (
    <div className="mx-auto max-w-[1400px] px-6 pb-12 pt-8">
      <PageHero
        eyebrow="<Section>"
        title="<Tab Name>"
        period={periodLabel}            // "April 2026" or "Apr → Jun 2026 (3 months)"
        source="<sheet tabs read>"      // e.g. "Finance Model + Budget"
      />

      <WhatToDoNext
        periodLabel={periodLabel.toUpperCase()}
        insights={generateWhatToDoNext<Tab>(selected, prior, ...extras)}
      />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {/* KPI strip — see per-tab spec for which KPIs */}
      </section>

      <section className="mt-8">{/* primary chart, full-width */}</section>
      <section className="mt-6">{/* secondary chart, full-width */}</section>
      <section className="mt-8">{/* tertiary block — grid of cards OR a table */}</section>
      <section className="mt-8">{/* main table */}</section>

      <p className="mt-10 text-[10px] text-muted-foreground">
        Live from <a className="underline hover:text-foreground" target="_blank" rel="noreferrer" href="<sheet-url>"><sheet-name></a>
        {" — "}<sources> · cached 5 minutes
      </p>
    </div>
  );
}
```

Spacing, padding, and the footer copy are non-negotiable — see formatting.md §1.7.

**Every page also gets:**
- `export const dynamic = "force-dynamic"` (inherited from `app/layout.tsx`).
- `export const revalidate = 300;` at the top of the page module.
- `export const metadata = { title: "<Tab> · <Client> Finance" }`.

---

# Phase 1 — Historic Only

Bookkeeping baseline. Past data only. Forecasts are not exposed yet (data may already contain future months in the sheet, but the UI must clamp the global range to the actual data window).

## Phase 1 range & main-month rules

These rules **override** the default behavior in formatting.md / `lib/default-range.ts`:

1. **Main range default — `from` and `to`.**
   - `from` = first month with non-empty actuals data in the source sheet.
   - `to` = `latestActualMonthIso` (the last month marked Actuals — read from the Legend tab if present; if not, the latest month with any non-zero numbers).
   - **Do NOT** extend `to` past the last actual month in Phase 1. That's a Phase 2 change.
2. **Main month default (single-month selector).**
   - Set to `latestActualMonthIso` on first load.
   - All KPI strips, all single-month scorecard tables, and any "current snapshot" cards read from the selected single month.
3. **Trend charts.**
   - **Every** monthly trend chart on every tab respects the global range. The chart's data array is filtered to `from ≤ monthIso ≤ to` before render.
   - Do not let charts default to "last 12 months" or any other window that diverges from the global range in Phase 1.
4. **Forecast styling is disabled in Phase 1.**
   - Don't pass `lastActualMonthIso` into charts during Phase 1 unless future months are in the sheet AND visible in the chart's slice. If everything in view is historical, there's no forecast boundary to draw.
   - Forecast UI lights up in Phase 2.
5. **Range picker bounds.**
   - `min` = earliest data month.
   - `max` = `latestActualMonthIso`.
   - Months past the last actual are **disabled** in the picker.

This means a Phase 1 client opens the dashboard and sees the full history out of the box, with the most recent actual month already selected for snapshot cards. Zero clicks to read the dashboard.

## Tab 1 — Financials  (Phase 1)

**Route.** `/financials` (and the root `/` redirects here).

**Purpose.** P&L health. The first tab anyone lands on.

### Sheet inputs (must exist before building)

| Concept | Template field name | Where it lives | Notes |
|---|---|---|---|
| Total Revenue per month | `TOTAL REVENUE` | Finance Model row | Required |
| Total COGS per month | `TOTAL COST OF SALES` | Finance Model row | Required |
| Gross Profit per month | `GROSS PROFIT` | Finance Model row | Required (or derive: revenue − COGS) |
| Gross Margin per month | `Gross Margin` | Finance Model row | Optional — derive if missing |
| Total OpEx per month | `TOTAL OPERATING EXPENSES` | Finance Model row | Required |
| Operating Profit per month | `OPERATING PROFIT` | Finance Model row | Required (or derive) |
| Operating Margin per month | `Operating Margin` | Finance Model row | Optional — derive if missing |
| Net Profit per month | `NET PROFIT` | Finance Model row | Optional |
| Net Margin per month | `Net Profit Margin` | Finance Model row | Optional |
| Ending Cash per month | `Ending Cash` | Finance Model row | Optional. If missing or empty → Cash KPI shows `—`. Don't fabricate. |
| Status row (Actuals/Forecast) | `Status` | Finance Model row | Optional but recommended. Falls back to "all rows are actuals" if missing — Phase 1 doesn't show forecast anyway. |
| Budget per category per month | Budget tab | A separate tab | Optional. Without it, drop the Budget Achievement KPI and the Budget vs Actual table. |

**Setup questions to ask before building:**
- "What's the sheet ID and which tab is the P&L on?"
- "Is there a Status row marking each month Actuals vs Forecast? If not, I'll derive the last-actual month from the latest non-zero row."
- "Do you have a Budget tab? If not, I'll skip the Budget Achievement KPI and the Budget vs Actual table." (CFO clients usually have one; bookkeeping clients often don't.)
- "Do you track ending cash per month? If not, the Cash KPI shows `—` until populated."

### Components, in page order

**A. PageHero**
- Eyebrow: `"Financial overview"`
- Title: `"Financials"`
- Period: dynamic label of selected months
- Source: e.g. `"Finance Model"` or `"Finance Model + Budget"`

**B. WhatToDoNext insights panel**
Branching prose generator covering:
1. **Profitability headline.** `win` if net profit > 0 and net margin ≥ 0.15; `info` if positive but margin < 0.15; `alert` if net loss.
2. **MoM margin direction.** `warn` if margin compressed ≥ 3pp; `win` if expanded ≥ 3pp; otherwise check revenue MoM (`warn` if revenue down ≥ 5%).
3. **Budget overruns.** Only if Budget tab exists. `warn` for the worst over-budget cost category. Plural-aware ("X cost categories over budget — worst: Y at +Z%").
4. **Revenue vs budget.** `win` if ≥ 102% of plan; `alert` if < 95%.
5. **Cash insight.** Only if ending cash is populated. `info` if positive, `alert` if negative or trending down.

Sort: `alert → warn → win → info`. Cap at 5. (See formatting.md §3.3 for full prose construction rules.)

**C. KPI strip — 5 tiles**
Use `<KpiStat size="sm">` for each. Tones driven by thresholds:

| KPI | Format | Tone thresholds |
|---|---|---|
| Revenue | `formatCurrency(total, { compact: true })` | neutral |
| Operating Profit | compact currency | `< 0` danger, `> 0` success, `0` neutral |
| Gross Margin | percent (1dp) | `≥ 0.5` success, `≥ 0.3` warning, else danger |
| Operating Margin | percent (1dp) | `≥ 0.15` success, `≥ 0.05` warning, else danger |
| Budget Achievement | percent | `≥ 1` success, `≥ 0.95` warning, else danger. If no Budget tab → drop this tile and let the strip be 4 wide. |

Every KPI shows a delta vs prior period (same length, immediately preceding selectedMonths). Delta label: `"vs <prior-period-label>"` or `"no prior period"` when none exists.

**D. Primary chart — Revenue & Operating Profit (dual-axis trend, full-width)**
- Component: `<TimedMultiLineChart>` wrapping `MultiLineChart`.
- Series: Revenue (`#1390eb`, currency) + Operating Profit (`#22c55e`, currency).
- Both on left axis (visual gap between the two lines shows how much profit lags revenue — that's the design intent).
- Title: `"Revenue & Operating Profit by month"`. Subtitle: `"Same axis — visual gap shows how much profit lags revenue"`. In Phase 1, drop the `· forecast included` suffix.
- Bound to the global `fromIso` / `toIso`.

**E. Secondary chart — Margin trend (full-width)**
- Component: `<TimedMultiLineChart>` (same wrapper, different series).
- Series: Gross Margin (`#1390eb`, percent) + Operating Margin (`#22c55e`, percent).
- `leftFormat="percent"`.
- Title: `"Gross & Operating Margin"`. Subtitle: `"Two-line margin trend"`.

**F. Service line economics — only if applicable**
Skip in Phase 1 unless the sheet has per-service metric tabs (see Phase 2). They require LTV/CAC/NRR/churn metrics that bookkeeping clients don't track. **Default for Phase 1: do not include.**

**G. Main table — Budget vs Actual**
- Component: `<BudgetVsActualTable>`.
- Skip entirely if no Budget tab.
- Categorise across selected months. Order: Revenue groups → COGS groups → Expense groups.
- Header: H2 `text-base font-semibold` = `"Budget vs Actual"`. Right-side helper text: `"Categorised across the selected months · ordered Revenue → COGS → Expenses"`.

**H. Footer**
- `Live from <Sheet> — Finance Model{` + Budget` if used} · cached 5 minutes`.

### Assumptions Claude should announce during Phase 1 Financials setup

- "I'm reading rows by their label (case-insensitive regex). If a row is renamed upstream, the value will silently go to 0 — I'd rather fail loud, but the trade-off is robustness against column inserts. Flag if you'd rather I fail loud."
- "Numbers formatted as `($1,234)` are treated as negative `-$1,234`. Numbers with `%` suffix are parsed as percent (`81.9%` → `0.819`)."
- "Prior period = same length as selected, immediately before. Single month selected → one prior month. Three months selected → three prior months."

---

## Tab 2 — Revenue  (Phase 1)

**Route.** `/revenue`.

**Purpose.** Service revenue health (i.e. revenue excluding passthrough costs that flow through). Drilldowns by service line, industry, source, pod; top growers / decliners; client × service MoM table.

### Sheet inputs

| Concept | Template field name | Where | Notes |
|---|---|---|---|
| Client roster | Clients tab | rows = clients | Required: name, status, source, industry, pod (if applicable) |
| Per-client × per-month revenue | Services tab | grid: client rows × month columns | Required. `monthIso → revenue` shape. |
| Passthrough flag | Passthrough tab | list of clients to exclude | Optional. If absent, no exclusion. **Ask** the user whether any of their revenue should be excluded from totals (e.g. ad-spend passthrough). |

**Setup questions:**
- "Is your revenue split per client per month? What tab?"
- "Do you have anything to exclude from revenue totals (passthrough costs, reimbursements, etc.)?"
- "What dimensions do you want to break revenue down by? The template uses Service Line, Industry, Source, Pod. Which of these exist in your Clients tab and what are they called?"

### Components

**A. PageHero**
- Eyebrow: `"Service revenue"`
- Title: `"Revenue"`
- Subline source: `"Services + Clients"`

**B. WhatToDoNext** (insight branches):
1. Revenue trend (`win` if up ≥ 5%, `warn` if down ≥ 5%, `info` otherwise).
2. Biggest decliner client (`alert` if a top-10 client revenue down ≥ 50% vs prior; `warn` if 20–50%).
3. New client wins (`win` if any new clients added in selected period with material revenue).
4. Concentration risk (`warn` if top-1 client > 25% of total or top-3 > 50%).
5. Service-line mix shift (`info` if any service line gained/lost > 10pp share vs prior).

**C. KPI strip — 5 tiles**

| KPI | Format | Notes |
|---|---|---|
| Total Revenue (excl. passthrough) | compact currency | |
| Active Clients | integer | clients with non-zero revenue in selected months |
| Avg Revenue / Client | compact currency | total / active |
| New Clients (period) | integer | clients with first revenue in the selected window |
| Concentration (top-3 share) | percent | `≤ 0.4` success, `≤ 0.6` warning, else danger |

**D. Primary chart — Revenue by service line (stacked bar, full-width)**
- Component: `<TimedStackedBarChart>` wrapping `StackedBarChart`.
- One series per service line.
- `paletteSort="blue"` — biggest at bottom, darkest color.
- Total label above each bar.
- Title: `"Revenue by service line"`. Subtitle: `"Stacked monthly · biggest service at the base"`.

**E. Secondary charts — breakdowns (grid, 3 across on lg, 1 on mobile)**
For the **selected single month** (not the range — these are snapshots):

| Card | Chart | Component |
|---|---|---|
| By Industry | Horizontal ranked bars | `<RankedBarChart>` (`color="#1390eb"`) |
| By Source | Horizontal ranked bars | `<RankedBarChart>` (`color="#22c55e"`) |
| By Pod | Horizontal ranked bars | `<RankedBarChart>` (`color="#c084fc"`) |

Skip any breakdown whose dimension doesn't exist in the client's data. Card title: `text-base font-semibold` = `"By <dimension>"`.

**F. Top growers / decliners (two `<MoverCard>`s side-by-side on lg, stacked otherwise)**
- Current period vs prior period.
- 5–8 clients each side, sorted by absolute delta descending.
- Each card title: `"Top growers"` / `"Top decliners"`. Subtitle: `"Comparing <current> vs <prior>"`.

**G. Main table — Client × Service MoM revenue**
- Component: `<MonthOverMonthTable>`.
- Primary col: client name. Link to `/client-profit/<client>` **only if Phase 3 is built**; otherwise no link.
- Secondary col: service line.
- Tertiary col (optional): pod or industry.
- Status filter: client status (Active / Project / Churned), default to Active.
- Bar color: `"rgba(34,211,238,0.45)"` (sky — see formatting.md §2.C.1).
- Default sort: total desc.

**H. Footer.** `Live from <Sheet> — Services + Clients · cached 5 minutes`.

---

## Tab 3 — Expenses  (Phase 1)

**Route.** `/expenses`.

**Purpose.** Cost view. Department-scoped via multi-select. Stacked bar by department, dept-cost as % of revenue, by-type/category, vendor MoM table.

### Sheet inputs

| Concept | Template field name | Where | Notes |
|---|---|---|---|
| Per-vendor / contractor cost grid | Costs tab | rows = vendors, month columns | Required |
| Cost type | column in Costs tab | "COGS" / "OpEx" / "Mixed" | Optional. **Ask** if missing — without it, can't split type. |
| Department allocation | column or rows in Costs tab | e.g. `Growth %`, `SEO %` cols summing to 100% | Optional. Without it, drop the "by department" stacked bar. |
| Category | column in Costs tab | e.g. "Payroll", "Software", "Marketing" | Required for the "by category" view. |
| Department list | Sheet | distinct department names | Read from Costs tab columns or a Settings tab. **Ask** the user for the dept list. |
| Total revenue per month | Finance Model | for "% of revenue" charts | Required |

**Setup questions:**
- "What's the cost data structure — per-vendor rows with month columns? Or transaction-level?"
- "Do you allocate costs to departments? If yes, what departments do you have?"
- "Are costs flagged as COGS vs OpEx vs Mixed? If not, I'll treat everything as OpEx — flag if you want a different default."

### Components

**A. PageHero**
- Eyebrow: `"Costs"`
- Title: `"Expenses"`
- Source: `"Costs + Finance Model"`

**B. WhatToDoNext** (insight branches):
1. Total expense trend (`warn` if up ≥ 5%, `info` if down).
2. Worst category overrun vs prior (`warn` plural-aware).
3. New vendors this period (`info` listing top 2–3 new).
4. Departments running hot (`warn` if any dept > X% of revenue threshold — set X based on industry; ask user if unclear).
5. Vendor concentration (`info` if top-1 vendor > 15% of total).

**C. Department multi-select** (only if dept allocation exists)
- Place this **just under the WhatToDoNext panel**, before the KPI strip.
- Component: `<DepartmentMultiSelect>` (see formatting.md §3.1.a).
- URL param: `?depts=`.
- All-selected = no param.
- All KPIs, charts, and the vendor table filter to selected depts.

**D. KPI strip — 5 tiles**

| KPI | Format | Notes |
|---|---|---|
| Total Expenses | compact currency | |
| COGS | compact currency | only if cost-type exists |
| OpEx | compact currency | only if cost-type exists |
| Expenses / Revenue | percent (1dp) | `≤ 0.5` success, `≤ 0.7` warning, else danger |
| Active Vendors | integer | distinct vendors with non-zero cost in period |

If cost-type is missing → replace COGS + OpEx with two other KPIs (e.g. Avg Cost / Vendor, MoM change).

**E. Primary chart — Expenses by department (stacked bar, full-width)**
- Skip if no dept allocation.
- Component: `<TimedStackedBarChart>` with `paletteSort="red"`.
- One series per department. Filtered by the multi-select.
- Title: `"Expenses by department"`. Subtitle: `"Stacked monthly · biggest dept at the base"`.

**F. Secondary chart — Dept cost as % of revenue (full-width)**
- Skip if no dept allocation.
- Component: `<TimedMultiLineChart>` (percent format).
- Series: one line per selected department, color from `PALETTE_RED` evenly spaced.
- Title: `"Department cost as % of revenue"`. Subtitle: `"Tracks each department's burn vs total revenue"`.

**G. Tertiary block — By type and by category (grid, 2 cards)**

| Card | Chart |
|---|---|
| By type (COGS / OpEx / Mixed) | `<VerticalBarChart>` color `#ef4444`. Skip if no type field. |
| By category | `<RankedBarChart>` color `#ef4444`, top 10 categories. |

**H. Main table — Vendor MoM expense**
- Component: `<VendorExpenseTable>` (or `<MonthOverMonthTable>` if vendor table doesn't fit needs).
- Bar color: rose.
- Filters: vendor search, type filter (if type exists).
- Default sort: amount desc.

**I. Footer.** `Live from <Sheet> — Costs + Finance Model · cached 5 minutes`.

---

# Phase 2 — Forecasting & Analytics

Two changes when advancing to Phase 2:

1. **Forecast months become visible** in the global range across **every tab** (Phase 1 tabs included). This is a system-wide change, not a per-tab one.
2. **Analytics tab is added.**

## Enabling forecast in the main range (system-wide)

When the user moves to Phase 2:

1. **Read the Legend tab** for `Last Actual Month`. If it doesn't exist, ask the user how forecasts are marked (Status row? Bold formatting? Hardcoded month?).
2. **Update default-range logic** (`lib/default-range.ts` or equivalent):
   - `to` default = `addMonthsIso(latestActualIso, 3)` — i.e. show 3 months of forecast by default (`FORECAST_LOOKAHEAD_MONTHS = 3`).
   - `min` of the Range picker stays at first data month.
   - `max` of the Range picker now extends to the latest forecast month in the sheet (not capped at `latestActualMonthIso` anymore).
3. **Pass `lastActualMonthIso` into every chart** that supports it (`StackedBarChart`, `StackedAreaChart`, `SimpleAreaChart`, `MultiLineChart`, `MarginTrendChart`, `SignedLostBars`). This lights up the forecast styling defined in formatting.md §2.A.
4. **MoM tables** show forecast months with the italic + crosshatch treatment automatically (see formatting.md §3.9).
5. **"Last actuals" badge in the GlobalFiltersBar** appears — see formatting.md §1.6.
6. **WhatToDoNext insights** can now reference forecast trends. Add a "forecast trajectory" branch to each tab's prose generator (e.g. "Forecast shows revenue declining vs current — pull on pipeline now.").
7. **Update the period-label** so users see when forecast is in the selection. Suggested: when selected period extends past `lastActualMonthIso`, append `"(includes <N> forecast months)"` to the subline.

**Single-month main month default stays at `latestActualMonthIso`.** Don't auto-jump to a forecast month — users will explicitly pick a forecast month if they want to compare against plan.

---

## Tab 4 — Analytics  (Phase 2)

**Route.** `/analytics`.

**Purpose.** Unit economics. LTV/CAC, churn (MRR + Client), Signed vs Lost movement, support-department cost margins.

The template's Analytics tab is heavy. **Default for Phase 2 = a subset.** Pick the metrics you have data for, in this order of importance:

### Sheet inputs (in priority order — build what you have)

| Concept | Template field | Required for | Notes |
|---|---|---|---|
| MRR per month | Metrics tab | LTV, MRR Churn | Must have. If absent, the tab can't really exist. |
| New clients per month | Metrics tab or derived from Clients | Signed bars, CAC | Required |
| Lost clients per month | Metrics tab or derived | Lost bars, Churn | Required |
| Total active clients per month | Derived | Signed/Lost line overlay | Always derivable from Clients |
| LTGP | Metrics tab | LTV/CAC chart | Optional. If absent, use LTV directly. |
| CAC | Metrics tab | LTV/CAC chart | Optional. Falls back to total marketing spend / new clients. |
| Per-service-line metrics | Growth/SEO/Direct Mail Metrics tabs | Service line economics cards | Optional. Skip cards if missing. |
| Support dept margins | Support Metrics tab | Support margins chart | Optional. |

**Setup questions:**
- "What's your headline unit-economics metric? LTV / LTGP, CAC, LTV/CAC ratio, MRR churn, client churn — which do you track?"
- "Do you have per-service-line metrics broken out (e.g. growth marketing vs SEO)? Or one combined view?"
- "Do you have a 'Last Actual Month' marker in the sheet? If yes, where?"

### Components, in page order

**A. PageHero**
- Eyebrow: `"Unit economics"`
- Title: `"Analytics"`
- Source: `"Metrics"` (or list specific metric tabs)

**B. WhatToDoNext** (insight branches):
1. LTV/CAC ratio (`win` if ≥ 3, `warn` if 1–3, `alert` if < 1).
2. Churn trend (`warn` if MRR churn ≥ 2% or client churn rising MoM).
3. Signed vs Lost (`win` if net positive 3 months running, `alert` if net negative).
4. Support dept margins (`info` if a support dept's cost as % of revenue trending up).
5. Forecast trajectory (`info` or `warn` — leverages forecast months now that they're visible).

**C. KPI strip — 5 tiles** (pick the 5 most relevant for this client)

| KPI | Format | Tone thresholds |
|---|---|---|
| LTV (or LTGP) | compact currency | neutral |
| CAC | compact currency | neutral |
| LTV/CAC ratio | `(v).toFixed(1):1` | `≥ 3` success, `≥ 1` warning, else danger |
| MRR Churn | percent (1dp) | `≤ 0.02` success, `≤ 0.05` warning, else danger. Lower is better. |
| Client Churn | percent (1dp) | same threshold, lower is better |

If a metric is absent, replace with another (e.g. ARPU, net new MRR, payback months).

**D. Primary chart — LTV vs CAC overlay (dual-axis trend)**
- Component: `<TimedMultiLineChart>`.
- Series: LTV/LTGP (`#1390eb`, currency, left axis), CAC (`#ef4444`, currency, left axis), LTV/CAC ratio (`#22c55e`, number with `:1` suffix, right axis — optional).
- Title: `"LTV, CAC, and ratio"`. Subtitle: `"Currency on the left, ratio on the right"`.

**E. Secondary chart — Churn trend (full-width)**
- Component: `<TimedMultiLineChart>` (percent).
- Series: MRR Churn (`#ef4444`), Client Churn (`#f59e0b`).
- Title: `"Churn"`. Subtitle: `"MRR vs client churn"`.

**F. Signed vs Lost with total clients (full-width)**
- Component: `<TimedSignedLostBars>` (formatting.md §2.B.12).
- Bars: Signed (green), Lost (red). Line: Total clients (blue, right axis).
- Title: `"Signed & Lost clients"`. Subtitle: `"Net movement with total client trend"`.

**G. Service-line economics cards (grid, only if per-service metrics exist)**
- 3 `<ServiceLineCard>`s side-by-side (or N for however many service lines).
- Each shows: profit, margin, NRR, churn, avg invoice, active services — for the selected single month.

**H. Support dept margins (optional, only if Support Metrics tab exists)**
- `<TimedMultiLineChart>` (percent).
- One series per support department (Engineering, Sales, Operations, Executive).

**I. Footer.** `Live from <Sheet> — Metrics{ + Support Metrics if used} · cached 5 minutes`.

---

# Phase 3 — Client & People Profitability

Per-client and per-person P&L. Both tabs depend on the **Client Profit** and **Team Profit** sheet tabs being filled in (pre-cooked rollups). Most clients won't have time tracking populated — that's fine, the table-level views still work, just the drilldowns lose detail.

## Prerequisites (don't start Phase 3 without these)

| Sheet tab | Why |
|---|---|
| **Client Profit** | Per-client P&L grid (revenue, people cost, referrals, other costs, client profit, margin). Required for Clients tab. |
| **Team Profit** | Per-person P&L grid (hours, revenue covered, utilization, vs target, revenue gap). Required for People tab. |
| **Time Tracking** | Granular hours per date × client × person. Optional — only needed for drilldown detail pages. |

**Setup questions before starting Phase 3:**
- "Are the Client Profit and Team Profit rollups filled in for the months we care about? If they're empty or partial, I should wait — the dashboard will look broken with `—`s everywhere."
- "Do you track time per person × client? If yes, I'll build the drilldown pages. If no (most clients), I'll just build the table-level views and skip the per-client/per-person drilldown links."

**IMPORTANT (per Joey):** most clients **don't** have time tracking. The default Phase 3 build assumes **no drilldown** — i.e. client/person names in tables are not linked, and there's no `/client-profit/[client]` or `/people-profit/[person]` route. Only build drilldowns when the user confirms time tracking exists and is populated.

## Tab 5 — Clients  (Phase 3)

**Route.** `/client-profit`. (Do not introduce a `/clients` route — that name has been reserved for an older stub and is not used.)

**Purpose.** Per-client profitability. Who's making money, who's costing money, who needs a price review.

### Components, in page order

**A. PageHero**
- Eyebrow: `"Client profitability"`
- Title: `"Clients"`
- Source: `"Client Profit"`

**B. WhatToDoNext** (insight branches):
1. Unprofitable clients (`alert` if any client has negative margin in selected period; lists worst 1–3).
2. Margin compression (`warn` if average margin compressed ≥ 5pp vs prior).
3. Top profit drivers (`win` listing top 3 most-profitable clients).
4. Concentration risk (`warn` if top-1 client > 25% of total profit).
5. Loss-leader pattern (`info` if a client has high revenue but margin < 30%).

**C. KPI strip — 5 tiles**

| KPI | Format | Tone |
|---|---|---|
| Total Client Profit | compact currency | `> 0` success, `≤ 0` danger |
| Avg Margin | percent (1dp) | `≥ 0.5` success, `≥ 0.3` warning, else danger |
| Profitable Clients | integer | neutral |
| Unprofitable Clients | integer | `0` success, `> 0` danger |
| Top Client % of Profit | percent (1dp) | `≤ 0.25` success, `≤ 0.4` warning, else danger |

**D. Primary chart — Profit by client (horizontal ranked, full-width)**
- Component: `<RankedBarChart>` (`format="currency"`, `color="#1390eb"`).
- Sorted descending. Top 15–20 by default; long-tail collapsed into "Other" if > 20.
- Title: `"Client profit"`. Subtitle: `"Selected period · top contributors first"`.

**E. Secondary chart — Margin distribution (full-width)**
- Component: `<MarginByGroup>` — horizontal bars, red below 0, blue above.
- One bar per client, sorted descending by margin.
- Title: `"Margin by client"`. Subtitle: `"Red bars are unprofitable"`.

**F. Main table — Client Profit**
- Component: `<ClientProfitTable>` (formatting.md §2.C.5).
- Columns: Client | Service | Pod | Team (count) | Revenue (bar sky) | People Cost (bar rose) | Referral Fees (bar amber) | Other Costs (bar orange) | Client Profit (bar green or rose) | Margin (badge).
- **Skip the "Team (count)" column if no time tracking** — otherwise team-count will be 0 everywhere and the popover is empty.
- **Don't link the Client column** unless drilldown is enabled.
- Sticky header + footer. Default sort by clientProfit desc.

**G. Footer.** `Live from <Sheet> — Client Profit{ + Time Tracking if used} · cached 5 minutes`.

### Drilldown — `/client-profit/[client]` (only if time tracking exists)

Per-client deep dive page. Components:
- `<PageHero>` with eyebrow `"Client"`, title = client name, source = `"Time Tracking + Client Profit"`.
- WhatToDoNext (per-client insights — billable ratio, who's most allocated, etc.).
- KPI strip (4 tiles): Revenue, People Cost, Profit, Margin.
- Trend chart: monthly revenue vs cost for this client (`<TimedMultiLineChart>`).
- Per-person contribution table: `<PersonContributionTable>` (formatting.md §2.C.11).
- Footer.

**Skip this whole drilldown route in Phase 3 unless explicitly enabled.**

---

## Tab 6 — People  (Phase 3)

**Route.** `/people-profit`.

**Purpose.** Per-person profitability. Who's covering their cost, who needs more hours, who's over-utilised.

### Components, in page order

**A. PageHero**
- Eyebrow: `"Team profitability"`
- Title: `"People"`
- Source: `"Team Profit"`

**B. WhatToDoNext**:
1. Under-target people (`alert` listing 1–3 with biggest revenue gaps).
2. Over-utilised people (`warn` if anyone > 110% util — burnout risk).
3. High performers (`win` listing 1–3 with most surplus revenue).
4. Department imbalance (`info` if one dept consistently above/below target).
5. Bench (`info` if any active person has < 20% util — placement opportunity).

**C. KPI strip — 5 tiles**

| KPI | Format | Tone |
|---|---|---|
| Revenue Covered | compact currency | neutral |
| Avg Utilization | percent (1dp) | `≥ 0.75` success, `≥ 0.5` warning, else danger |
| People on target | integer | neutral |
| Revenue Gap (under-target total) | compact currency | `0` success, `> 0` danger |
| Hours billable | integer | neutral |

**D. Primary chart — Revenue gap by person (full-width)**
- Component: `<RevenueGapByPerson>` (formatting.md §2.B.13).
- Diverging horizontal bars — red for under-target, green for surplus.
- Optional drilldown link to `/people-profit/[person]` only if drilldown is enabled.
- Title: `"Revenue gap by person"`. Subtitle: `"Red = below target · green = surplus"`.

**E. Secondary chart — Utilization trend (full-width)**
- Component: `<TimedMultiLineChart>` (percent).
- Series: one line per department (or per person if small team), each color from `PALETTE_BLUE` evenly spaced.
- Title: `"Utilization by department"`. Subtitle: `"Tracks how each team is loaded"`.

**F. Main table — People Profit**
- Component: `<PeopleProfitTable>` (formatting.md §2.C.9).
- Columns: Team Member | Department | Hours Available | Revenue Covered | Utilization | vs Target | Revenue Gap.
- **Don't link the Team Member column** unless drilldown is enabled.
- Default sort by `revenueCovered desc`.

**G. Footer.** `Live from <Sheet> — Team Profit{ + Time Tracking if used} · cached 5 minutes`.

### Drilldown — `/people-profit/[person]` (only if time tracking exists)

Per-person deep dive. Components:
- `<PageHero>` with eyebrow `"Team member"`, title = person's name.
- WhatToDoNext per-person.
- KPI strip (4 tiles): Hours, Revenue Covered, Utilization, vs Target.
- Trend chart: monthly utilization + revenue covered.
- Per-client contribution table: `<ClientContributionTable>` (formatting.md §2.C.4).
- Footer.

Same rule as Clients: skip unless explicitly enabled.

---

# Phase Operations — Day-to-day AR / invoice ops

Operations is the bolt-on for clients who want active invoice-ops visibility — what's outstanding, what's overdue, what's about to go out, who needs to approve. Independent of the Phase 1/2/3 ladder: ship it whenever the client has populated an `Invoices` tab in the sheet.

## Tab 7 — Payments  (Phase Operations)

**Route.** `/payments`. (Historically `/cash-flow` — renamed to Payments because the page is about invoice payment ops, not the cash-flow statement.)

**Purpose.** Live AR view: what's been billed, what's outstanding, what's overdue, what's in pre-send pipeline. Drives weekly billing rituals.

### Sheet inputs

| Concept | Template field | Where | Notes |
|---|---|---|---|
| Invoice grid | Invoices tab | one row per invoice line | Required. Per-row fields: client, service, status, amount, openAmount, invoiceDate, sentDate, dueDate, paidDate, daysOverdue, payType, paymentRule, adSpend, discounts, otherChange, notes, payPlatform, currency, invoiceNumber. |
| Status enum | column in Invoices | one of: `In Progress`, `AgenCFO Review`, `Client Review`, `Ready`, `Unpaid`, `Partially Paid`, `Fully Paid` | Required. "Overdue" is derived from `Unpaid`/`Partially Paid` + `daysOverdue > 0`. |
| Days overdue | column in Invoices | integer (positive = late, negative = future-due, null = paid) | Required for the AR aging KPIs. |
| Chart of accounts | Bookkeeping tab, column B | one CoA category per row (row 2+) | Optional. Required only if you want the Transactions toggle (see below). Drives the Category dropdown. |
| Unclear-transaction queue | Bookkeeping tab, columns E:O | one row per transaction needing client clarification | Optional. **E–M** are bookkeeper context — standard fields surfaced in the UI (matched by header): `Date / Vendor / Description / Amount / Account`. Account (col M) is shown in the row because clients often recognise spends by the card or bank they hit. **N** is client-picked Category (with data validation against column B); **O** is the client free-text Comment. |

**Setup questions:**
- "Do you bill from QBO, Stripe, or somewhere else? The `payPlatform` column should reflect what the user opens to take action."
- "What statuses do you use? If your sheet has different status names, map them to the template enum (above) — UI styling is keyed to those exact strings."
- "Any clients you want excluded from the AR view (e.g. internal entities, prepaid retainers)? Pass them via a `Passthrough` flag if so."
- "Do you want the **Transactions clarification** queue? If yes, add a `Bookkeeping` tab with the Chart of Accounts in column B and post unclear transactions to columns E–M (M = Account, e.g. card or bank). Columns N (Category) and O (Comment) stay blank — the client fills them through the dashboard."

### Components, in page order

**A. PageHero**
- Eyebrow: `"Accounts receivable"`
- Title: `"Payments"`
- Source: `"Invoices"`
- No page-level filter in the rightSlot — the global period filter is enough.

**B. KPI strip — 5 tiles**

| KPI | Format | Tone |
|---|---|---|
| Outstanding AR | compact currency | `0` neutral, else warning |
| Overdue | compact currency | `0` success, else danger |
| Due Next 7 Days | compact currency | neutral |
| Pipeline (pre-send) | compact currency | neutral |
| Collected (period) | compact currency | success |

Each tile shows a count + qualifier in the delta line (e.g. "4 open invoices", "all current", "avg 32d to pay").

**C. Two-column workspace** (ratio 6:4 on `lg`)
- **Left (6/10 width):** `<ActionsCenter>` — bi-modal workspace with a segmented `Invoices | Transactions` toggle in the header. Show Breakdown lives left of the toggle and is Invoices-only.
  - **Invoices mode** (default). Two sections — "Awaiting your review" (need client approve) + "Scheduled" (drafts + ready). **Default columns (6):** Date · Client · Service · Amount · Status · Actions — widths `50 / 120 / 100 / 72 / 96 / 170` px (~620px total). **Show breakdown adds 5 columns** (Pay type · Rule · Ad spend · Discount · Other) and intentionally triggers horizontal scroll. Pay type lives in the breakdown — it's a "why" column, not part of the at-a-glance queue.
  - **Transactions mode.** Only available when the `Bookkeeping` tab has CoA / unclear-transaction rows (toggle hides otherwise). Two sections — "Awaiting clarification" (no category or comment yet) + "Clarified" (one of them filled). **Columns (7):** Date · Description · Vendor · Amount · Account · Category · Comment — widths `80 / 180 / 120 / 75 / 100 / 125 / 110` (~790px total, fits without scroll). Category is a dropdown popover sourced from the CoA; Comment is a textarea popover. Both **empty** triggers render in solid `var(--blue)` to read as "client action required" (same visual weight as the Approve button on invoices); filled triggers fade to subtle emerald (category) / amber (comment).
    - **Row-click detail popover.** Clicking anywhere on a row outside the Category / Comment cells opens a Radix Popover **anchored to the row** (~380px wide, opens to the left — same visual language as Outstanding Invoices in `OpenSummary`). Shows the full Description (un-truncated), Account, any non-standard bookkeeper columns surfaced from `raw` (Reference, Type, etc.), plus inline Category picker + Comment textarea so the client can clarify from one place. Not a modal — keeps the rest of the page visible and dismissable. The inline cells stay as quick-edit shortcuts; clicks on them `stopPropagation()` so they don't also open the row popover.
    - **Flashing badge on the toggle.** When `awaitingCount > 0`, the Transactions pill renders a small red badge with the count and an `animate-ping` halo. The halo settles when the toggle is already active (no need to flash if the client is already looking at the queue). Clarification rule: **either field non-empty** moves the row to the bottom section. The bookkeeper deletes the row from the sheet once actioned — the row then drops off the dashboard entirely on the next refresh.
- **Right (4/10 width):** `<OpenSummary>` — donut + outstanding invoice list. The Age sparkline column is **omitted** (the per-row days-overdue number already carries the urgency signal). Client + Service cells truncate at `max-w-[110px]` to keep the 5-column table fitting cleanly without overflow.

**D. AR grid (full-width)**
- Component: `<ArGrid>`. Client × month matrix of invoice statuses + amounts. Sticky left column (Client) + sticky right column (Total). Status multi-select popover above the grid. Whole-table subtle heatmap on `$ outstanding` (palette `"blue"`, scope `"matrix"` — see formatting.md §3.7.a).

**E. Footer.** `Live from <Sheet> — Invoices · cached 1 minute · period anchored to <today>`. Tighter cache (1 minute) than other tabs because invoice ops is the most-action-driven view.

### Layout sizing rules (non-negotiable)

- **ActionsCenter** default-fit goal: every column visible without horizontal scroll inside its 6-of-10 grid column on a 1400px container (≈ 800px usable). Apply to BOTH modes:
  - Invoices mode: Date 50, Client 120, Service 100, Amount 72, Status 96, Actions 170 (sum ≈ 620px). `px-2 py-2` cell padding. Pay type lives in showBreakdown, not the default columns.
  - Transactions mode: Date 80, Description 180, Vendor 120, Amount 75, Account 100, Category 125, Comment 110 (sum ≈ 790px). Description / Vendor / Account cells truncate, but the row-click popover gives access to the full text. Empty Category / Comment triggers render with the short labels `"Category"` and `"Comment"` (the blue CTA formatting carries the "fill me in" signal — verbs would just take up space).
- **OpenSummary (Outstanding Invoices)** takes 4-of-10 of the row. Drop the Age sparkline column; days-overdue already shows that signal numerically. Truncate Client + Service cells at `max-w-[110px]` so the 5-column table never overflows.
- **When the user clicks "Show breakdown"**, horizontal scroll IS expected on ActionsCenter — that's the trade-off for surfacing the four extra columns.
- **Forecast lookahead is on by default.** The Payments page respects the global Range filter, which extends `FORECAST_LOOKAHEAD_MONTHS` past `latestActualMonthIso` out of the gate. AR cells past the last actual get the standard forecast styling (italic + crosshatch — see formatting.md §3.9).

### Two-way sync — how transactions get cleared up

This is the **only** place in the dashboard where the client writes data back into the sheet, and the bookkeeper acts on what the client wrote. Both sides edit the same `Bookkeeping` tab; the dashboard and the sheet stay in lockstep through a short cache + a per-write invalidation. Get this loop right and you've unlocked a whole class of "client clarifies → bookkeeper acts" workflows the team can reuse in future tabs.

#### The loop (what happens, in order)

```
  ┌─────────────────────────────────────────────────────────────────┐
  │ 1. Bookkeeper sees a transaction they can't categorise.         │
  │    Posts a row to Bookkeeping!E:M — Date / Vendor / Description │
  │    / Amount / Account, plus any extra context columns. N + O    │
  │    stay blank.                                                  │
  └────────────────────────────────┬────────────────────────────────┘
                                   │ next dashboard read
                                   │ (≤ 60 s cache, instant on Refresh)
                                   ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ 2. Dashboard surfaces the row under "Awaiting clarification".   │
  │    Transactions toggle on Payments shows a pulsing red count    │
  │    badge so the client can't miss that work is queued.          │
  └────────────────────────────────┬────────────────────────────────┘
                                   │ client opens /payments
                                   ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ 3. Client does ONE of:                                          │
  │    (a) inline blue **Category** trigger → pick from CoA         │
  │    (b) inline blue **Comment** trigger → free-text explanation  │
  │    (c) click anywhere else on the row → detail popover opens    │
  │        with full description + raw bookkeeper context + both    │
  │        editors                                                  │
  └────────────────────────────────┬────────────────────────────────┘
                                   │ server action `updateTransactionCategory`
                                   │ or `updateTransactionComment` writes
                                   │ Bookkeeping!N{row} or !O{row}
                                   ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ 4. Sheet now has the client input. Cache invalidated, page      │
  │    revalidated. Row moves to "Clarified" in the UI. Bookkeeper  │
  │    sees the same value when they next look at the sheet.        │
  └────────────────────────────────┬────────────────────────────────┘
                                   │ bookkeeper actions the input
                                   │ (categorises in QBO etc.) and
                                   │ deletes the sheet row
                                   ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ 5. Next dashboard read: row disappears entirely. Awaiting count │
  │    drops. If it was the last one, the red badge stops flashing. │
  └─────────────────────────────────────────────────────────────────┘
```

#### Sheet → Dashboard (read path)

| What | Where | Notes |
|---|---|---|
| Reader | [`lib/sources/bookkeeping.ts::fetchBookkeeping()`](lib/sources/bookkeeping.ts) | One call reads `Bookkeeping!A1:O500`. |
| Chart of Accounts | Column B, row 2+ | Deduped + sorted alpha → the Category dropdown options. |
| Unclear transactions | Rows 2+ where any of E–M is non-empty | Fully-blank rows skipped. |
| Account binding | Column **M** is bound directly to `account` | Header is ignored on M so an earlier "Account #" / "Account Code" column can't shadow it. |
| Display fields | Row 1 headers in E–L are classified (regex, case-insensitive) | `Date` (matches `^date|posted|transaction date`), `Vendor` (`vendor|merchant|payee|name`), `Description` (`desc|memo|detail`), `Amount` (`amount|total`). |
| Unknown columns | Anything else in E–M | Stored in `raw` — surfaced in the row-click detail popover under "From the bookkeeper". |

#### Dashboard → Sheet (write path)

Server actions in [`app/payments/actions.ts`](app/payments/actions.ts):

| Action | Writes | Semantics |
|---|---|---|
| `updateTransactionCategory(rowIndex, value)` | Column **N** | Empty string clears (drops row back to Awaiting if Comment is also empty). |
| `updateTransactionComment(rowIndex, text)` | Column **O** | **Replace**, not append — these are short clarifications ("personal", "marketing test budget"), not running logs. |

Both actions go through `writeCell` with `valueInputOption: USER_ENTERED`. That preserves any data validation on column N (the CoA dropdown) — if a stale value slips through, Sheets rejects it server-side and the action returns an error that the UI surfaces under the trigger. After every successful write the action calls `invalidateTabCache("Bookkeeping")` and `revalidatePath("/payments")`, so the client sees their write reflected on the next render with no manual Refresh.

#### Cache + freshness contract

- Server-side per-tab cache TTL is **60 seconds** for every sheet read (`CACHE_TTL_MS` in [`lib/sources/sheets-live.ts`](lib/sources/sheets-live.ts)).
- **Bookkeeper-side changes** (new row posted, or row deleted) show on the dashboard within ≤ 60 s. The Refresh button in the global filter bar bypasses the cache when the user wants instant freshness.
- **Dashboard-side writes** are reflected immediately on the same render because the action invalidates the cache before `revalidatePath`. The client never has to wait the 60 s after their own write.
- **No row-level lock.** Concurrent edits (bookkeeper deletes the row while the client is writing Category) are intentionally permitted — the queue is shallow and the human cycle time on each row is measured in days, not seconds. If the write lands in a now-deleted cell, no harm. If Sheets returns a hard error, the toast surfaces it.

#### Permissions

The service account configured via `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` (or `GOOGLE_CREDENTIALS_JSON` / `GOOGLE_CREDENTIALS_FILE`) **must have Editor access** on the sheet via Drive sharing. Read-only won't cut it — the Transactions clarification view fails the moment a client tries to save and Sheets returns `403`. The action surfaces this as: _"Sheet write permission denied — share the sheet with the service account as Editor."_

#### Recovery — what to do when things look stuck

| Symptom | Most likely cause | Fix |
|---|---|---|
| Client saved but row didn't move to Clarified | Cache lag (≤ 60 s) | Click Refresh in the global filter bar |
| Save button errored with a 403 | Service account lacks Editor on the sheet | Re-share the sheet with the service account email as Editor |
| Bookkeeper posted a row but client never saw it | All of E–M empty (we skip those) OR cache lag | Verify at least one of E–M has a value; then Refresh |
| Pulsing red badge sticks at the wrong count | Caused by either of the above | Refresh |
| Category dropdown shows no options | Column B of `Bookkeeping` is empty | Fill in the CoA in column B (row 2+) |

#### Why this beats Sheets comments / Slack / email

We considered all three. The dashboard pattern wins because:

- **The client is already here.** Payments is their daily/weekly stop — adding a "go check Sheets / Slack" step kills adoption.
- **Categorisation is structured.** A dropdown sourced from the live Chart of Accounts means the client picks a real category, not a free-text guess the bookkeeper then has to map.
- **The badge pulses until acknowledged.** Comments / DMs sit unread. The toggle badge demands a glance every time the client opens the page.
- **Resolution is unambiguous.** The bookkeeper deletes the row when done — there's no "is this still pending?" ambiguity that comment threads create.

#### Reusing this pattern for future tabs

The whole loop is generalised across two files: a sheet reader (`lib/sources/<thing>.ts`) and a pair of server actions (`app/<route>/actions.ts`). Anything client-input-with-bookkeeper-action can follow the same shape:

1. Bookkeeper-write columns left of N/O.
2. Client-write columns N/O (or wherever — but the **last two columns** convention is worth keeping so the schema is grep-able).
3. Empty = awaiting, non-empty = clarified.
4. Row is removed by bookkeeper when actioned. No status flag, no soft-delete.
5. UI surfaces awaiting count with a pulsing badge until acknowledged.

---

# Phase 4 — Other

Reserved. Nothing built here yet. When future tabs are added (e.g. cash-flow forecast, scenario modeling, executive summary PDF export), document them under this phase.

---

# Appendix A — Required sheet tabs by phase

Quick reference. Cross-check against the client's sheet before building any phase.

| Phase | Sheet tab | Used by tab | Required? |
|---|---|---|---|
| 1 | Finance Model | Financials | Yes |
| 1 | Legend (Last Actual Month cell) | All tabs (forecast cutoff) | Recommended |
| 1 | Budget | Financials | Optional |
| 1 | Clients | Revenue | Yes |
| 1 | Services | Revenue | Yes |
| 1 | Passthrough | Revenue | Optional |
| 1 | Costs | Expenses | Yes |
| 2 | Metrics | Analytics | Yes for Phase 2 |
| 2 | Growth/SEO/Direct Mail Metrics | Analytics (service-line cards) | Optional |
| 2 | Support Metrics | Analytics (support margins) | Optional |
| 3 | Client Profit | Clients | Yes for Phase 3 |
| 3 | Team Profit | People | Yes for Phase 3 |
| 3 | Time Tracking | Drilldown pages | Optional |
| Ops | Invoices | Payments | Yes for Phase Operations |
| Ops | Bookkeeping (col B = CoA, E:M = bookkeeper context with M=Account, N:O = client-writeable Category + Comment) | Payments / Transactions toggle | Optional — enables the Transactions clarification view (two-way sync, see Phase Operations) |

---

# Appendix B — Setup question bank

When you're about to start a new client build, work through these in order. Don't proceed past a section until you have answers (or have explicitly assumed-and-told-the-user).

### Step 1 — Connection

1. What's the Google Sheet ID? (the long string in the URL)
2. What's the sheet called? (used in the page footer "Live from <X>")
3. Are credentials in place? Test with a sheet-connection script before building anything.

### Step 2 — Forecast marker

4. Is there a Legend tab with a "Last Actual Month" cell? Or a Status row in the P&L?
5. If neither: how should I detect actual-vs-forecast months? (Most recent non-zero, hardcoded month, "all is actual", or some other rule?)

### Step 3 — Phase 1 fields

6. P&L tab name and structure: rows or columns for months?
7. Row labels — are these named exactly `TOTAL REVENUE` / `TOTAL COST OF SALES` / `OPERATING PROFIT` / etc., or different? List the rows.
8. Is there a Budget tab? If yes, structure?
9. Does the client want any revenue excluded from totals (passthrough)?
10. Service / category / pod dimensions for clients — which exist and what are they called?
11. Cost data: per-vendor rows × month columns, or transaction-level rows?
12. Department allocations on costs — exist? List the departments.
13. COGS / OpEx tagging on costs — exist?

### Step 4 — Phase 2 (when advancing)

14. Confirm `latestActualMonthIso` source.
15. Does the client track LTV (or LTGP) and CAC?
16. MRR-based or invoice-based revenue?
17. Per-service-line metrics — exist?
18. Support / non-billable departments to track separately?

### Step 5 — Phase 3 (when advancing)

19. Are Client Profit and Team Profit rollup tabs populated for the months we care about?
20. Is time tracking populated? **(Most clients = no. Confirm before enabling drilldowns.)**
21. Team / Department list — pull from sheet or have user confirm.

### Step 6 — Auth & deploy

22. Single shared password OR per-role passwords?
23. If per-role: which departments does each role see?
24. Vercel project — already linked or new?
25. **Service account permissions.** Is the sheet shared with the dashboard's service account email as **Editor**? Read-only access works for the read-only tabs but **breaks the Payments Transactions clarification view** the moment a client tries to save (Sheets returns 403). Confirm Editor access before shipping any tab with write-back.

---

# Appendix C — Anti-patterns (don't do these)

These bit the template at one point or another. Don't repeat them.

- **Don't put the dept filter only on /expenses.** If the user expects scoping, plumb it through the relevant pages and document the scope clearly.
- **Don't pre-render finance pages at build time.** Always `export const dynamic = "force-dynamic"`. Pre-rendering needs the env vars at build, which is a foot-gun on Vercel.
- **Don't link client/person names to drilldowns that don't exist.** Dead-end links are worse than no links.
- **Don't show forecast styling in Phase 1.** Save the affordance for when the data actually has forecast.
- **Don't ship a tab with `—` in every KPI cell.** If the data isn't there yet, hold the tab until it is — or ship with empty-state messaging that explains why.
- **Don't invent metrics that aren't in the sheet.** A bookkeeping client doesn't have LTV; computing it from incomplete data and showing a number is worse than leaving the tile out.
- **Don't reorder phases.** Phase 2's forecast UI depends on Phase 1's range logic being right. Phase 3's drilldowns depend on Phase 2's analytics already trusting the forecast marker.
- **Don't ship a write-back tab on a read-only service account.** Always verify the service account has **Editor** access on the sheet before enabling any write surface (the Transactions toggle is the only one today, but anything that calls `writeCell` qualifies). Read-only access is silently fine on page load and then explodes the moment a client tries to save.
- **Don't append to the Comment column.** Comments on transactions are short clarifications, not running logs — replace semantics. Append semantics are reserved for invoice Notes (where every chase / status change deserves its own line).
