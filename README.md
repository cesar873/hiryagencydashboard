# Hiry Agency × AgenCFO Dashboard

Live financial dashboard for Hiry Agency, pulling data straight from the AgenCFO Google Sheet.

## Stack

- **Frontend**: single-page HTML + Chart.js (`hiry-dashboard.html`)
- **Backend**: Vercel serverless function (`api/data.js`) that reads the Google Sheet via a service account
- **Auth**: client-side password gate on the dashboard
- **Hosting**: Vercel (git-connected)

## How it works

1. User opens the dashboard → password gate.
2. After unlock, the page calls `GET /api/data`.
3. The serverless function:
   - Authenticates with Google using a service-account JWT.
   - Reads the **Income Summary** tab (monthly P&L) and the **Transactions Database** tab (line-level data).
   - Transforms everything into a single JSON payload shaped for the dashboard.
   - Caches the result for **5 minutes** at the edge and in memory.
4. The dashboard hydrates all charts, KPIs, MoM tables, insights, and the dynamic Expense Category table from that payload.

## Data source

Spreadsheet: [Hiry Agency AgenCFO Financial Management v4](https://docs.google.com/spreadsheets/d/13_ta2rPtKUNmVZwbZRWC3IbOwwipf89VIA3Q0oD1n5s)

Required tabs (auto-detected by name):
- **Income Summary** – wide-format monthly P&L (or any tab matching `/income\s*summary|p&l|profit.*loss/i`)
- **Transactions Database** – line-level transactions (any tab matching `/transaction/i`)

The dashboard shows the **trailing 13 months** ending at the latest month with a non-zero `Total Revenue`. To add a new month, add a column in the sheet — the dashboard picks it up on the next cache miss.

## Setup

### One-time: Google Cloud

1. Create a Google Cloud project.
2. Enable the **Google Sheets API**.
3. Create a **service account**: `hiryagency@hiry-agency.iam.gserviceaccount.com` (or your own).
4. Generate a JSON key for the service account → download.
5. Open the source spreadsheet → **Share** → add the service-account email with **Viewer** access.

### Vercel

1. Connect this repo to a new Vercel project.
2. Under **Project Settings → Environment Variables**, add:
   - Name: `GOOGLE_SERVICE_ACCOUNT_JSON`
   - Value: paste the **entire contents** of the service-account JSON file (including the outer `{}`)
   - Environments: **Production**, **Preview**, **Development**
3. Trigger a deploy (`git push` or the Vercel UI).

Vercel auto-installs dependencies from `package.json` and detects `api/data.js` as a serverless function. No extra config needed.

### Local dev

```bash
npm install
echo 'GOOGLE_SERVICE_ACCOUNT_JSON='"'"'<paste JSON here>'"'"'' > .env.local
npx vercel dev
```

Then open http://localhost:3000.

## Files

| Path | Purpose |
|---|---|
| `hiry-dashboard.html` | Single-page dashboard (UI + charts + logic) |
| `api/data.js` | Serverless function — reads sheet, returns JSON |
| `package.json` | Node deps (only `googleapis`) |
| `vercel.json` | Routing + function timeout config |
| `dashboard-formatting.md` | AgenCFO design system reference |

## Caching behavior

- **5-min edge cache** via `Cache-Control: s-maxage=300, stale-while-revalidate=60`.
- **In-memory cache** on each warm function instance for the same window.
- After 5 minutes, the next request triggers a fresh fetch from Sheets while serving the previous payload as stale-while-revalidate.

To force a refresh in the browser, hard-reload (`Cmd+Shift+R`). The cache also expires naturally after 5 minutes.

## Adding / changing data

| Change | What happens |
|---|---|
| Update a number in the sheet | Reflects in the dashboard within 5 min (or instantly on hard-reload after cache expires) |
| Add a new month column to Income Summary | Dashboard auto-detects and shifts the 13-month window forward |
| Add a new expense category | If it's in `COGS_CATEGORIES` or `OPEX_CATEGORIES` in `api/data.js`, it appears in the Expense Category table |
| Add new transactions | MoM tables, transaction tables, and the 90-day Active Clients metric update automatically |

## Troubleshooting

| Symptom | Fix |
|---|---|
| "DATA LOAD FAILED" overlay | Check `GOOGLE_SERVICE_ACCOUNT_JSON` is set in Vercel and the service account has Viewer access to the sheet |
| `403 permission` error | Re-share the spreadsheet with the service-account email |
| All zeros | The function couldn't find the Income Summary tab — check tab name matches `/income\s*summary|p&l|profit.*loss/i` |
| Months are wrong | Check the header row in Income Summary uses `Mmm YYYY` format (e.g. `Apr 2026`) |
