// Serverless function: reads live data from the Hiry Agency Google Sheet
// and returns a JSON payload shaped for the dashboard.
//
// Auth: uses a Google service-account JSON stored in the
// GOOGLE_SERVICE_ACCOUNT_JSON env var (the whole JSON, stringified).
//
// Caching: 5-minute edge cache via Cache-Control headers + in-memory cache
// per warm Lambda instance.

import { google } from 'googleapis';

const SHEET_ID = '13_ta2rPtKUNmVZwbZRWC3IbOwwipf89VIA3Q0oD1n5s';
const CACHE_TTL_SECONDS = 300; // 5 minutes
const TRAILING_MONTHS = 13;    // dashboard shows last 13 months

// ── In-memory cache (warm instance) ─────────────────────────────
let memCache = null;
let memCacheAt = 0;

// ── Number / string helpers ─────────────────────────────────────
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_FULL  = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function num(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim();
  if (!s || s === '-' || s === '—' || s.startsWith('#')) return 0;
  const isParen = s.startsWith('(') && s.endsWith(')');
  let cleaned = s.replace(/\$/g, '').replace(/,/g, '').replace(/\s/g, '').replace(/[()]/g, '');
  const hadPct = cleaned.endsWith('%');
  if (hadPct) cleaned = cleaned.slice(0, -1);
  const n = parseFloat(cleaned);
  if (isNaN(n)) return 0;
  return isParen ? -n : n;
}

function rowByLabel(rows, label) {
  const target = label.toLowerCase().trim();
  return rows.find(r => r && r[0] !== undefined && String(r[0]).toLowerCase().trim() === target);
}

function parseDateMDY(s) {
  if (!s) return null;
  const parts = String(s).trim().split('/');
  if (parts.length !== 3) return null;
  const mm = parseInt(parts[0], 10);
  const dd = parseInt(parts[1], 10);
  const yyyy = parseInt(parts[2], 10);
  if (!mm || !dd || !yyyy) return null;
  return new Date(yyyy, mm - 1, dd);
}

function monthShortFromDate(dt) {
  return `${MONTH_SHORT[dt.getMonth()]} ${String(dt.getFullYear()).slice(2)}`;
}

function lastDayOfMonth(monthShort) {
  // "Apr 26" → Date(2026, 3, 30)
  const [mon, yr] = monthShort.split(' ');
  const monIdx = MONTH_SHORT.indexOf(mon);
  const year = 2000 + parseInt(yr, 10);
  return new Date(year, monIdx + 1, 0);
}

// ── Sheet read ──────────────────────────────────────────────────
async function authClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message);
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('Service account JSON is missing client_email or private_key');
  }
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  await auth.authorize();
  return auth;
}

async function fetchSheetData() {
  const auth = await authClient();
  const sheets = google.sheets({ version: 'v4', auth });

  // Discover tab names
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const tabs = meta.data.sheets.map(s => s.properties.title);

  // ── Auto-detect P&L tab by structure (resilient to renames) ─────
  // We're looking for a tab that has:
  //   (a) a row with month headers (Mmm YYYY) in the first ~40 rows
  //   (b) a row whose column A is "Total Revenue" or "TOTAL COST OF SALES" or "OPERATING INCOME"
  // We prioritize likely candidate names but fall back to scanning all tabs.
  const PL_CANDIDATES = [
    /income\s*summary/i, /^p\s*&\s*l$/i, /profit.*loss/i,
    /^finance\s*model$/i, /^finance\s*model2$/i,
    /scorecard/i, /profit.*matrix/i, /^metrics$/i, /^budget$/i
  ];
  const TXN_CANDIDATES = [/transaction.*database/i, /^transactions$/i, /transaction/i];

  // Build prioritized scan order: candidate-matching tabs first, then everything else
  function orderByCandidates(tabList, patterns) {
    const matched = [];
    const seen = new Set();
    for (const pat of patterns) {
      for (const t of tabList) {
        if (!seen.has(t) && pat.test(t)) {
          matched.push(t);
          seen.add(t);
        }
      }
    }
    for (const t of tabList) {
      if (!seen.has(t)) matched.push(t);
    }
    return matched;
  }
  const plScanOrder = orderByCandidates(tabs, PL_CANDIDATES);
  const txnScanOrder = orderByCandidates(tabs, TXN_CANDIDATES);

  // Helper: scan one tab and return { rows, headerRowIdx, monthCols } if it looks like a P&L
  async function tryReadPLTab(tabName) {
    let res;
    try {
      res = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `'${tabName}'!A1:Z500`,
        valueRenderOption: 'UNFORMATTED_VALUE'
      });
    } catch (e) {
      return null;
    }
    const rows = res.data.values || [];
    if (rows.length < 5) return null;

    // Find header row with month columns
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const row = rows[i] || [];
      const monthHits = row.filter(c => /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/.test(String(c || '').trim())).length;
      if (monthHits >= 6) { headerIdx = i; break; }
    }
    if (headerIdx < 0) return null;

    // Confirm P&L structure: must have at least one of the canonical labels in column A
    const canonicalLabels = ['total revenue', 'total cost of sales', 'operating income', 'total operating expenses', 'gross profit'];
    const hasPLLabel = rows.some(r => r && canonicalLabels.includes(String(r[0] || '').toLowerCase().trim()));
    if (!hasPLLabel) return null;

    return { tabName, rows, headerRowIdx: headerIdx };
  }

  // Scan tabs in priority order, return first match
  let incomeData = null;
  for (const t of plScanOrder) {
    incomeData = await tryReadPLTab(t);
    if (incomeData) break;
  }
  if (!incomeData) {
    throw new Error(`Could not auto-detect P&L tab. Scanned ${plScanOrder.length} tabs. Available: ${tabs.join(', ')}`);
  }
  const incomeTab    = incomeData.tabName;
  const incomeRows   = incomeData.rows;
  const headerRowIdx = incomeData.headerRowIdx;

  // Find Transactions tab (still by name match — easier since "Transactions Database" is distinctive)
  const txnTab = txnScanOrder.find(t => TXN_CANDIDATES.some(pat => pat.test(t)));

  const headerRow = incomeRows[headerRowIdx];
  const monthCols = []; // { colIdx, shortLabel, fullLabel }
  for (let c = 0; c < headerRow.length; c++) {
    const v = String(headerRow[c] || '').trim();
    const m = v.match(/^([A-Z][a-z]{2})\s+(\d{4})$/);
    if (m) {
      const monShort = m[1];
      const fullYear = m[2];
      const yrShort = fullYear.slice(2);
      const monFullIdx = MONTH_SHORT.indexOf(monShort);
      monthCols.push({
        colIdx: c,
        shortLabel: `${monShort} ${yrShort}`,
        fullLabel: `${MONTH_FULL[monFullIdx]} ${fullYear}`
      });
    }
  }
  if (monthCols.length === 0) throw new Error('No month columns parsed from header row');

  // Helper: pull a row by label, mapped to monthCols
  function getMonthlyRow(label) {
    const row = rowByLabel(incomeRows, label);
    if (!row) return new Array(monthCols.length).fill(0);
    return monthCols.map(mc => num(row[mc.colIdx]));
  }

  // Pull all canonical rows from Income Summary
  const allTotalRev  = getMonthlyRow('Total Revenue');

  // Determine trim window: last N months ending at the latest month with data
  let lastNonZero = -1;
  for (let i = allTotalRev.length - 1; i >= 0; i--) {
    if (allTotalRev[i] !== 0) { lastNonZero = i; break; }
  }
  if (lastNonZero < 0) lastNonZero = allTotalRev.length - 1;
  const endCol = lastNonZero + 1;
  const startCol = Math.max(0, endCol - TRAILING_MONTHS);
  const window = (arr) => arr.slice(startCol, endCol);

  const months = monthCols.slice(startCol, endCol).map(m => m.shortLabel);
  const PERIOD_LABELS = monthCols.slice(startCol, endCol).map(m => m.fullLabel);

  const totalRev     = window(allTotalRev);
  const clientRev    = window(getMonthlyRow('Client Revenue'));
  const candidateRev = window(getMonthlyRow('Candidate Revenue'));

  // COGS breakdown
  const cogsTalent = window(getMonthlyRow('Talent Acquisition'));
  const cogsCSM    = window(getMonthlyRow('Customer Success Manager'));
  const cogsInt    = window(getMonthlyRow('Interviewers & Talent Partners'));
  const cogsFreel  = window(getMonthlyRow('Freelancers (COGS)'));
  const cogsRef    = window(getMonthlyRow('Referral Fee Expense'));
  const cogsAdsJob = window(getMonthlyRow('Ads Spend Job Postings'));
  const cogs       = window(getMonthlyRow('TOTAL COST OF SALES'));

  // OpEx breakdown
  const opexSoftware  = window(getMonthlyRow('Software & Subscriptions'));
  const opexRecruit   = window(getMonthlyRow('Software & Subscriptions - Recruitment'));
  const opexStripe    = window(getMonthlyRow('Stripe Fees'));
  const opexGMA       = window(getMonthlyRow('Google & Meta Ads'));
  const opexOtherAds  = window(getMonthlyRow('Other Ads & Marketing'));
  const opexTravelRaw = window(getMonthlyRow('Travel'));
  const opexHotel     = window(getMonthlyRow('Hotel & Lodging'));
  const opexMeals     = window(getMonthlyRow('Meals & Entertainment'));
  const opex          = window(getMonthlyRow('TOTAL OPERATING EXPENSES'));

  // Aggregate ads = Google&Meta + Other Ads
  const opexAds    = opexGMA.map((v, i) => v + opexOtherAds[i]);
  // Aggregate travel = Travel + Hotel + Meals
  const opexTravel = opexTravelRaw.map((v, i) => v + opexHotel[i] + opexMeals[i]);
  // Other = OpEx minus all known buckets
  const opexOther  = opex.map((v, i) =>
    Math.max(0, v - opexSoftware[i] - opexRecruit[i] - opexStripe[i] - opexAds[i] - opexTravel[i])
  );

  // Derived
  const operatingInc = window(getMonthlyRow('OPERATING INCOME'));
  const opMarginRaw  = window(getMonthlyRow('OPERATING MARGIN'));
  // Sheet stores margins as decimal (0.4223) — convert to percent for the dashboard
  const opMargin = opMarginRaw.map(v => (v !== 0 && Math.abs(v) <= 1.5) ? +(v * 100).toFixed(2) : +v.toFixed(2));
  const grossMargin = totalRev.map((r, i) =>
    r > 0 ? +(((r - cogs[i]) / r) * 100).toFixed(1) : 0
  );

  // EXP_BY_CAT_PL — for the dynamic Expense Category table
  const COGS_CATEGORIES = [
    'Talent Acquisition','Customer Success Manager','Interviewers & Talent Partners',
    'Freelancers (COGS)','Ads Spend Job Postings','Referral Fee Expense'
  ];
  const OPEX_CATEGORIES = [
    'Software & Subscriptions - Recruitment','Software & Subscriptions','Stripe Fees',
    'Travel','Meals & Entertainment','Hotel & Lodging','Google & Meta Ads','Other Ads & Marketing',
    'Finance & Accounting','Coaching','Office & Admin','Bank & Transaction Fees','Freelancers (OpEx)',
    'Office Equipment','Ecom Brand Expense','Moving Payment','Legal Fees','Wise Fees',
    'Taxi & Share Rides','Telephone & Internet','Commission Paid','IT Costs','Rent','Mentoring & Coaches'
  ];
  const EXP_BY_CAT_PL = [];
  for (const cat of COGS_CATEGORIES) {
    const monthsArr = window(getMonthlyRow(cat));
    if (monthsArr.some(v => Math.abs(v) > 0.5)) EXP_BY_CAT_PL.push({ cat, grp: 'COGS', months: monthsArr });
  }
  for (const cat of OPEX_CATEGORIES) {
    const monthsArr = window(getMonthlyRow(cat));
    if (monthsArr.some(v => Math.abs(v) > 0.5)) EXP_BY_CAT_PL.push({ cat, grp: 'OpEx', months: monthsArr });
  }

  // ── Transactions tab: MOM_DATA + activeClients90d + transaction lists ──
  let MOM_DATA = { months, revenue: [], expenses: [] };
  let activeClients90d = new Array(months.length).fill(0);
  let REV_TXNS = [];
  let EXP_TXNS = [];

  if (txnTab) {
    try {
      const txnRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `'${txnTab}'!A1:Z50000`,
        valueRenderOption: 'UNFORMATTED_VALUE'
      });
      const txnRows = txnRes.data.values || [];
      const result = processTransactions(txnRows, months);
      MOM_DATA = result.mom;
      activeClients90d = result.active;
      REV_TXNS = result.revTxnList;
      EXP_TXNS = result.expTxnList;
    } catch (e) {
      console.error('[data.js] Failed to read transactions tab:', e.message);
    }
  }

  return {
    months,
    PERIOD_LABELS,
    totalRev,
    clientRev,
    candidateRev,
    cogs,
    opex,
    cogsTalent, cogsCSM, cogsInt, cogsFreel, cogsRef, cogsAdsJob,
    opexSoftware, opexRecruit, opexStripe, opexAds, opexTravel, opexOther,
    operatingInc,
    grossMargin,
    opMargin,
    EXP_BY_CAT_PL,
    MOM_DATA,
    activeClients90d,
    REV_TXNS,
    EXP_TXNS,
    _meta: {
      fetchedAt: new Date().toISOString(),
      incomeTab,
      txnTab: txnTab || null,
      monthsLoaded: months.length,
      window: `${months[0]} → ${months[months.length - 1]}`
    }
  };
}

// ── Transaction processing ──────────────────────────────────────
function processTransactions(rows, monthsWindow) {
  // Locate header row (look in first 10 rows for the columns we need)
  let headerIdx = -1;
  let cols = {};
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = (rows[i] || []).map(c => String(c || '').trim());
    const dateIdx = row.indexOf('Transaction date');
    if (dateIdx >= 0 && row.includes('Amount')) {
      headerIdx = i;
      cols = {
        date:     dateIdx,
        name:     row.indexOf('Name'),
        amount:   row.indexOf('Amount'),
        category: row.indexOf('Category'),
        keep:     row.indexOf('Keep?'),
        type:     row.indexOf('Final Type')
      };
      break;
    }
  }
  if (headerIdx < 0) {
    return { mom: { months: monthsWindow, revenue: [], expenses: [] }, active: new Array(monthsWindow.length).fill(0) };
  }

  // Map "Mmm YY" → window index
  const monthIdxMap = {};
  monthsWindow.forEach((m, i) => { monthIdxMap[m] = i; });

  // Collect transactions in window
  const allClientRevTxns = []; // for 90d calculation
  const revAgg = new Map();    // name → { name, type, total, months[] }
  const expAgg = new Map();    // `${vendor}||${category}` → { vendor, category, total, months[] }
  const revTxnList = [];       // [dateStr, name, category, amount] — for Revenue Transactions table
  const expTxnList = [];       // [dateStr, vendor, category, amount] — for Expense Transactions table

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    if (String(row[cols.keep] || '').trim() !== 'Yes') continue;

    const type   = String(row[cols.type] || '').trim();
    const dateRaw = row[cols.date];
    const dt = (dateRaw instanceof Date) ? dateRaw : parseDateMDY(dateRaw);
    if (!dt) continue;
    const name = String(row[cols.name] || '').trim();
    if (!name) continue;
    const cat  = String(row[cols.category] || '').trim();
    const amt  = num(row[cols.amount]);
    if (amt === 0) continue;

    const monShort = monthShortFromDate(dt);
    const mIdx = monthIdxMap[monShort];

    const dateStr = dt.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });

    if (type === 'Revenue') {
      // For 90d active clients
      if (cat === 'Client Revenue' && amt > 0) {
        allClientRevTxns.push({ name, dt });
      }
      if (mIdx === undefined) continue;
      revTxnList.push([dateStr, name, cat || 'Revenue', amt]);
      if (!revAgg.has(name)) {
        revAgg.set(name, { name, type: cat || 'Revenue', total: 0, months: new Array(monthsWindow.length).fill(0) });
      }
      const entry = revAgg.get(name);
      entry.months[mIdx] += amt;
      entry.total += amt;
    } else if (type === 'Expense') {
      if (mIdx === undefined) continue;
      const absAmt = Math.abs(amt);
      expTxnList.push([dateStr, name, cat || '—', absAmt]);
      const k = `${name}||${cat}`;
      if (!expAgg.has(k)) {
        expAgg.set(k, { vendor: name, category: cat || '—', total: 0, months: new Array(monthsWindow.length).fill(0) });
      }
      const entry = expAgg.get(k);
      entry.months[mIdx] += absAmt;
      entry.total += absAmt;
    }
  }

  // Sort transaction lists chronologically (newest first)
  function parseTxnDate(s) { return new Date(s); }
  revTxnList.sort((a, b) => parseTxnDate(b[0]) - parseTxnDate(a[0]));
  expTxnList.sort((a, b) => parseTxnDate(b[0]) - parseTxnDate(a[0]));

  // Sort + compute first/last appearance
  const revenue = Array.from(revAgg.values()).sort((a, b) => b.total - a.total);
  revenue.forEach(r => {
    r.first = r.months.findIndex(v => Math.abs(v) > 0);
    r.last = -1;
    for (let i = r.months.length - 1; i >= 0; i--) {
      if (Math.abs(r.months[i]) > 0) { r.last = i; break; }
    }
    // Round
    r.months = r.months.map(v => Math.round(v));
    r.total = Math.round(r.total);
  });

  const expenses = Array.from(expAgg.values()).sort((a, b) => b.total - a.total);
  expenses.forEach(e => {
    e.months = e.months.map(v => Math.round(v));
    e.total = Math.round(e.total);
  });

  // 90-day active clients per month
  const active = monthsWindow.map(m => {
    const end = lastDayOfMonth(m);
    const start = new Date(end);
    start.setDate(start.getDate() - 90);
    const set = new Set();
    for (const t of allClientRevTxns) {
      if (t.dt >= start && t.dt <= end) set.add(t.name);
    }
    return set.size;
  });

  return {
    mom: { months: monthsWindow, revenue, expenses },
    active,
    revTxnList,
    expTxnList
  };
}

// ── Vercel handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    const now = Date.now();
    if (memCache && (now - memCacheAt) < CACHE_TTL_SECONDS * 1000) {
      res.setHeader('Cache-Control', `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=60`);
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(memCache);
    }

    const data = await fetchSheetData();
    memCache = data;
    memCacheAt = now;

    res.setHeader('Cache-Control', `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=60`);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);
  } catch (error) {
    console.error('[api/data] Error:', error);
    return res.status(500).json({
      error: error.message,
      hint: error.message.includes('GOOGLE_SERVICE_ACCOUNT_JSON')
        ? 'Set GOOGLE_SERVICE_ACCOUNT_JSON env var in Vercel with the full service account JSON.'
        : error.message.includes('permission') || error.message.includes('403')
          ? 'The service account does not have access to the spreadsheet. Share the sheet with the service account email.'
          : undefined
    });
  }
}
