// Serverless function: reads live data from the Hiry Agency Google Sheet
// and returns a JSON payload shaped for the dashboard.
//
// Auth: uses a Google service-account JSON stored in the
// GOOGLE_SERVICE_ACCOUNT_JSON env var (the whole JSON, stringified).
//
// Caching: 5-minute edge cache via Cache-Control headers + in-memory cache
// per warm Lambda instance.

import { google } from 'googleapis';
import {
  SHEET_ID,
  getSheetsClient,
  findInvoicingHeader,
  matchInvoicingCandidateTab, matchInvoicingClientTab, matchAnyInvoicingTab,
  findBookkeepingTab, parseBookkeepingRows
} from '../lib/sheets.js';
const CACHE_TTL_SECONDS = 300; // 5 minutes
const TRAILING_MONTHS = 13;    // dashboard shows last 13 months

// ── In-memory cache (warm instance) ─────────────────────────────
let memCache = null;
let memCacheAt = 0;
let cachedPLTab = null; // remember which tab is the P&L between invocations

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

// Parse any cell that represents a month → { monShort: "Apr", year4: 2026 } or null
function parseMonthCellGeneric(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-\/.,]+(\d{2,4})$/i);
  if (m) {
    const monShort = m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase();
    const yr = parseInt(m[2], 10);
    return { monShort, year4: yr < 100 ? 2000 + yr : yr };
  }
  m = s.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i);
  if (m) {
    const fullName = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    const idx = MONTH_FULL.indexOf(fullName);
    if (idx >= 0) return { monShort: MONTH_SHORT[idx], year4: parseInt(m[2], 10) };
  }
  m = s.match(/^(\d{4})[\-\/](\d{1,2})$/);
  if (m) {
    const monIdx = parseInt(m[2], 10) - 1;
    if (monIdx >= 0 && monIdx < 12) return { monShort: MONTH_SHORT[monIdx], year4: parseInt(m[1], 10) };
  }
  m = s.match(/^(\d{1,2})\/\d{1,2}\/(\d{4})$/);
  if (m) {
    const monIdx = parseInt(m[1], 10) - 1;
    if (monIdx >= 0 && monIdx < 12) return { monShort: MONTH_SHORT[monIdx], year4: parseInt(m[2], 10) };
  }
  return null;
}
function monthShort(parsed) {
  return `${parsed.monShort} ${String(parsed.year4).slice(2)}`;
}

// ── Budget tab reader (long-format) ─────────────────────────────
async function fetchBudgetData(sheets, sheetId, tabs) {
  const budgetTab = tabs.find(t => /^budget$/i.test(t));
  if (!budgetTab) return { tab: null, months: [], byMonth: {}, meta: { error: 'No Budget tab found' } };

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${budgetTab}'!A1:G10000`,
      valueRenderOption: 'FORMATTED_VALUE'
    });
  } catch (e) {
    return { tab: budgetTab, months: [], byMonth: {}, meta: { error: 'Budget read failed: ' + e.message } };
  }
  const rows = res.data.values || [];

  // Find header row
  let headerIdx = -1;
  let cols = {};
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = (rows[i] || []).map(c => String(c || '').trim());
    if (row.includes('Month') && row.includes('Category') && row.includes('Budget')) {
      headerIdx = i;
      cols = {
        month:    row.indexOf('Month'),
        category: row.indexOf('Category'),
        group:    row.indexOf('Group'),
        budget:   row.indexOf('Budget'),
        actual:   row.indexOf('Actual')
      };
      break;
    }
  }
  if (headerIdx < 0) {
    return { tab: budgetTab, months: [], byMonth: {}, meta: { error: 'Header row (Month/Category/Group/Budget) not found' } };
  }

  // Aggregate group totals separately — rows like "Total Revenue", "Total Cost of Sales", "Total Operating Expenses", "Net Income"
  const TOTAL_LABELS = new Set([
    'total revenue', 'total cost of sales', 'total operating expenses',
    'total expenses', 'total business expenses', 'operating income', 'net income',
    'gross profit', 'gross margin', 'operating margin', 'net profit margin'
  ]);

  const byMonth = {}; // monthShort → { items:[{cat, grp, budget, actual}], totals: {...} }
  const monthSet = new Set();

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const monthRaw = String(row[cols.month] || '').trim();
    const cat = String(row[cols.category] || '').trim();
    const grp = String(row[cols.group] || '').trim();
    if (!monthRaw || !cat) continue;
    const parsed = parseMonthCellGeneric(monthRaw);
    if (!parsed) continue;
    const mShort = monthShort(parsed);
    monthSet.add(mShort);

    const budget = num(row[cols.budget]);
    const actual = cols.actual >= 0 ? num(row[cols.actual]) : 0;

    if (!byMonth[mShort]) {
      byMonth[mShort] = { items: [], totals: {} };
    }
    const entry = { cat, grp, budget, actual };
    const catLower = cat.toLowerCase();
    if (TOTAL_LABELS.has(catLower)) {
      byMonth[mShort].totals[catLower] = { budget, actual };
    } else {
      byMonth[mShort].items.push(entry);
    }
  }

  // Sort months chronologically using same ordering rule as elsewhere
  const monthsSorted = Array.from(monthSet).sort((a, b) => {
    const pa = parseMonthCellGeneric(a);
    const pb = parseMonthCellGeneric(b);
    return (pa.year4 * 12 + MONTH_SHORT.indexOf(pa.monShort)) - (pb.year4 * 12 + MONTH_SHORT.indexOf(pb.monShort));
  });

  // Meta counts (use first month to count typical items)
  let revCount = 0, cogsCount = 0, opexCount = 0;
  if (monthsSorted.length > 0) {
    const sample = byMonth[monthsSorted[0]].items;
    for (const it of sample) {
      if (/revenue/i.test(it.grp)) revCount++;
      else if (/cogs/i.test(it.grp)) cogsCount++;
      else if (/expense|opex/i.test(it.grp)) opexCount++;
    }
  }

  return {
    tab: budgetTab,
    months: monthsSorted,
    byMonth,
    meta: {
      monthsCount: monthsSorted.length,
      revenueLineItems: revCount,
      cogsLineItems: cogsCount,
      opexLineItems: opexCount
    }
  };
}

// ── Invoicing tab reader ────────────────────────────────────────
// Reads one Invoicing tab. `tab` is the sheet/tab name; `forcedSource` is
// 'candidate' | 'client' when reading a split tab (the row's source then
// comes from the tab, not the Service column). Pass null for a merged tab —
// source is derived from the Service column in that case.
async function fetchInvoicingData(sheets, tab, forcedSource) {
  if (!tab) return { tab: null, invoices: [], meta: { error: 'No Invoicing tab found' } };

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${tab}'!A1:AZ500`,
      valueRenderOption: 'FORMATTED_VALUE'
    });
  } catch (e) {
    return { tab, invoices: [], meta: { error: 'Invoicing read failed: ' + e.message } };
  }
  const rows = res.data.values || [];
  const found = findInvoicingHeader(rows);
  if (!found) {
    return { tab, invoices: [], meta: { error: 'Invoicing header not detected (need Client Name + Candidate Name + Invoice Amount column)' } };
  }
  const { headerRowIdx, cols } = found;

  // Truthy values that count as "yes / approved / checked" in the sheet.
  // Covers checkbox columns (Sheets returns "TRUE"/"FALSE"), enum-style cells
  // ("Approved" / "Pending"), and shorthand glyphs.
  const TRUTHY = new Set([
    'true','yes','y','1','checked','x','✓','✔','✔️','approved','done','complete','ok'
  ]);
  function parseBool(v) {
    if (v == null) return false;
    const s = String(v).trim().toLowerCase();
    if (!s) return false;
    return TRUTHY.has(s);
  }

  // Normalise the Service column to canonical "Placement" | "Recruitment".
  function normaliseService(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    if (/^placement|placed|candidate/.test(s)) return 'Placement';
    if (/^recruit|client|search/.test(s))      return 'Recruitment';
    // Unknown value — pass through so the UI can show what the sheet has
    return String(raw).trim();
  }

  // Lifecycle derivation. STATUS is the SINGLE source of truth now that the
  // Approval Status column has been retired. The mapping:
  //   Client Review        → pipeline, AWAITING client approval (approved:false)
  //   AgenCFO Review       → pipeline, SCHEDULED (client approved, AgenCFO actioning)
  //   Ready / In Progress  → pipeline, SCHEDULED
  //   (empty)              → pipeline, SCHEDULED (treat as a draft, not awaiting)
  //   Open / Sent / Unpaid → sent (outstanding)
  //   Paid / Fully Paid    → paid
  //   Overdue              → overdue
  //
  // `approved` here means "client has approved" — the only thing that gates
  // the Awaiting Your Review vs Scheduled split. Clicking Approve on a row
  // transitions Status from "Client Review" → "AgenCFO Review" (see
  // api/approve.js), which flips `approved` to true via this derivation.
  function deriveLifecycle({ statusRaw, datePaid }) {
    const s = (statusRaw || '').toLowerCase().trim();

    if (s === 'paid' || s === 'fully paid' || s === 'collected' || datePaid) {
      return { sentState: 'paid', approved: true, sent: true };
    }
    if (s === 'overdue' || s === 'late' || s === 'past due') {
      return { sentState: 'overdue', approved: true, sent: true };
    }
    if (s === 'open' || s === 'sent' || s === 'unpaid' || s === 'partially paid' || s === 'awaiting payment') {
      return { sentState: 'sent', approved: true, sent: true };
    }
    if (s === 'client review') {
      return { sentState: 'pipeline', approved: false, sent: false };
    }
    // Everything else pre-send (AgenCFO Review, Ready, In Progress, Draft,
    // empty, or any unknown value) → Scheduled. The client has either
    // already signed off (AgenCFO Review / Ready) or the row isn't asking
    // for their action yet (drafts).
    return { sentState: 'pipeline', approved: true, sent: false };
  }

  const invoices = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const client = cols.clientName >= 0 ? String(row[cols.clientName] || '').trim() : '';
    const candidate = cols.candidateName >= 0 ? String(row[cols.candidateName] || '').trim() : '';
    const invDate = cols.date >= 0 ? String(row[cols.date] || '').trim() : '';
    if (!client && !candidate && !invDate) continue; // skip blank rows

    const service = cols.service >= 0 ? normaliseService(row[cols.service]) : '';
    const statusRaw = cols.status >= 0 ? String(row[cols.status] || '').trim() : '';
    const datePaid = cols.datePaid >= 0 ? String(row[cols.datePaid] || '').trim() : '';
    const lifecycle = deriveLifecycle({ statusRaw, datePaid });
    const approved = lifecycle.approved;
    const sent = lifecycle.sent;
    const sentState = lifecycle.sentState;

    const placedSalary = cols.monthlySalary >= 0 ? num(row[cols.monthlySalary]) : 0;
    const finalAmountNative = cols.invoiceAmount    >= 0 ? num(row[cols.invoiceAmount])    : 0;
    const finalAmountUSD    = cols.invoiceAmountUSD >= 0 ? num(row[cols.invoiceAmountUSD]) : 0;
    // Prefer the USD column when it has a value (so mixed-currency rows
    // aggregate correctly), but fall back to the native Invoice Amount when
    // the USD cell is blank/zero. Draft + pipeline rows usually have no USD
    // conversion typed in yet — without this fallback they'd all count as $0,
    // which is what zeroed out the Pipeline KPI despite 38 drafts.
    const finalAmount = finalAmountUSD > 0 ? finalAmountUSD : finalAmountNative;
    const commissionStr = cols.commission >= 0 ? String(row[cols.commission] || '').trim() : '';
    const commissionPct = num(commissionStr);
    const deposit = cols.deposit >= 0 ? num(row[cols.deposit]) : 0;

    invoices.push({
      rowNumber: i + 1,
      // Identity
      service,                          // "Placement" | "Recruitment"
      client,
      candidate,
      jobTitle: cols.jobTitle >= 0 ? String(row[cols.jobTitle] || '').trim() : '',
      // Money
      placedSalary,
      commission: commissionStr,
      commissionPct,
      deposit,
      finalAmount,                      // USD if the sheet has an Amount USD column, else native
      finalAmountNative,                // native-currency invoice amount (for reference)
      finalAmountUSD,                   // raw USD column value (0 if no column / unfilled)
      amount: finalAmount,              // alias kept for legacy code paths
      currency: cols.currency >= 0 ? (String(row[cols.currency] || '').trim() || 'USD') : 'USD',
      // Lifecycle
      approved,
      sent,
      statusRaw,                        // exactly what the sheet has — for the Status popover
      sentState,
      // Dates
      invoiceDate: invDate,
      dueDate: cols.dueDate >= 0 ? String(row[cols.dueDate] || '').trim() : '',
      datePaid,
      // Detail / breakdown
      invoiceNum: cols.invoiceNum >= 0 ? String(row[cols.invoiceNum] || '').trim() : '',
      billingAddress: cols.billingAddress >= 0 ? String(row[cols.billingAddress] || '').trim() : '',
      notes: cols.notes >= 0 ? String(row[cols.notes] || '').trim() : '',
      // `source` decides which tab a write goes back to. When reading a split
      // tab it's forced from the tab; for a merged tab it's derived from Service.
      source: forcedSource || (service === 'Placement' ? 'candidate' : 'client'),
      billed: placedSalary,
      months: {}
    });
  }

  // Compact debug snapshot — surfaces what we actually detected in the sheet,
  // so we can diagnose "everything shows as Awaiting Review" type bugs
  // without round-tripping through the UI. Lives at _meta.invoicing.debug.
  const headerNames = (rows[headerRowIdx] || []).map(c => String(c || '').trim());
  const colNames = Object.fromEntries(
    Object.entries(cols).map(([k, idx]) => [k, (idx != null && idx >= 0) ? (headerNames[idx] || `(col ${idx})`) : null])
  );
  const sample = invoices.slice(0, 3).map(inv => ({
    rowNumber: inv.rowNumber, client: inv.client, candidate: inv.candidate,
    service: inv.service, statusRaw: inv.statusRaw, approved: inv.approved,
    sent: inv.sent, sentState: inv.sentState, finalAmount: inv.finalAmount
  }));

  return {
    tab,
    invoices,
    cols,
    headerRowIdx,
    meta: {
      total: invoices.length,
      pipeline: invoices.filter(x => x.sentState === 'pipeline').length,
      sent: invoices.filter(x => x.sentState === 'sent').length,
      paid: invoices.filter(x => x.sentState === 'paid').length,
      overdue: invoices.filter(x => x.sentState === 'overdue').length,
      placement: invoices.filter(x => x.service === 'Placement').length,
      recruitment: invoices.filter(x => x.service === 'Recruitment').length,
      debug: { headerRowIdx, colNames, sample }
    }
  };
}

// ── Bookkeeping tab reader (CoA + unclear-transaction queue) ─────
async function fetchBookkeepingData(sheets) {
  const tab = await findBookkeepingTab(sheets);
  if (!tab) {
    return {
      tab: null,
      coa: [],
      transactions: [],
      meta: { error: 'No Bookkeeping tab found', awaitingCount: 0, clarifiedCount: 0 }
    };
  }
  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${tab}'!A1:O500`,
      valueRenderOption: 'FORMATTED_VALUE'
    });
  } catch (e) {
    return {
      tab,
      coa: [],
      transactions: [],
      meta: { error: 'Bookkeeping read failed: ' + e.message, awaitingCount: 0, clarifiedCount: 0 }
    };
  }
  const rows = res.data.values || [];
  const { coa, transactions } = parseBookkeepingRows(rows);
  const awaitingCount = transactions.filter(t => !t.cleared).length;
  const clarifiedCount = transactions.length - awaitingCount;
  return {
    tab,
    coa,
    transactions,
    meta: {
      total: transactions.length,
      awaitingCount,
      clarifiedCount,
      coaCount: coa.length
    }
  };
}

// ── Sheet read ──────────────────────────────────────────────────
async function fetchSheetData() {
  const sheets = await getSheetsClient();

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
  // Build prioritized candidate list, limited to top 5 to stay under rate limits
  const plScanOrder = orderByCandidates(tabs, PL_CANDIDATES);
  const txnScanOrder = orderByCandidates(tabs, TXN_CANDIDATES);

  // Recognize cells like "Apr 2026", "April 2026", "Apr-26", "4/1/2026", etc.
  function looksLikeMonth(s) {
    if (!s) return false;
    const v = String(s).trim();
    if (!v) return false;
    // "Apr 2026" / "Apr 26"
    if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-\/.,]+\d{2,4}$/i.test(v)) return true;
    // "January 2026"
    if (/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i.test(v)) return true;
    // ISO-ish "2026-04" or "2026/04"
    if (/^\d{4}[\-\/]\d{1,2}$/.test(v)) return true;
    // M/D/YYYY (in case it's stored as date)
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v)) return true;
    return false;
  }

  // Helper to evaluate whether a sheet of rows looks like a P&L
  function evalPLRows(rows) {
    if (!rows || rows.length < 5) return -1;
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const row = rows[i] || [];
      const monthHits = row.filter(c => looksLikeMonth(c)).length;
      if (monthHits >= 6) { headerIdx = i; break; }
    }
    if (headerIdx < 0) return -1;
    const canonicalLabels = ['total revenue', 'total cost of sales', 'operating income', 'total operating expenses', 'gross profit', 'cost of sales', 'operating margin'];
    const hasPLLabel = rows.some(r => r && canonicalLabels.includes(String(r[0] || '').toLowerCase().trim()));
    return hasPLLabel ? headerIdx : -1;
  }

  // Determine which tab is the P&L — using single batchGet to avoid rate limits
  let incomeTab = null;
  let incomeRows = null;
  let headerRowIdx = -1;

  // 1) Try the cached tab first (1 read) if it's still in the spreadsheet
  if (cachedPLTab && tabs.includes(cachedPLTab)) {
    try {
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `'${cachedPLTab}'!A1:Z500`,
        valueRenderOption: 'FORMATTED_VALUE'
      });
      const rows = r.data.values || [];
      const hi = evalPLRows(rows);
      if (hi >= 0) {
        incomeTab = cachedPLTab;
        incomeRows = rows;
        headerRowIdx = hi;
      } else {
        cachedPLTab = null; // invalidate stale cache
      }
    } catch (e) {
      cachedPLTab = null;
    }
  }

  // 2) Fallback: batchGet the top 5 candidates in ONE API call
  if (!incomeTab) {
    const candidates = plScanOrder.slice(0, 5);
    const ranges = candidates.map(t => `'${t}'!A1:Z120`);
    let batchRes;
    try {
      batchRes = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: SHEET_ID,
        ranges,
        valueRenderOption: 'FORMATTED_VALUE'
      });
    } catch (e) {
      throw new Error(`Sheet read failed during P&L tab detection: ${e.message}`);
    }
    const ranges_out = batchRes.data.valueRanges || [];
    for (let i = 0; i < ranges_out.length; i++) {
      const rows = ranges_out[i].values || [];
      const hi = evalPLRows(rows);
      if (hi >= 0) {
        incomeTab = candidates[i];
        // If this tab's rows extend beyond 120, fetch the full range; otherwise reuse
        const needsFullRead = rows.length >= 119; // heuristic: if we hit the limit, refetch
        if (needsFullRead) {
          const fullRes = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `'${incomeTab}'!A1:Z500`,
            valueRenderOption: 'FORMATTED_VALUE'
          });
          incomeRows = fullRes.data.values || [];
          headerRowIdx = evalPLRows(incomeRows);
        } else {
          incomeRows = rows;
          headerRowIdx = hi;
        }
        cachedPLTab = incomeTab; // remember for next invocation
        break;
      }
    }
  }

  if (!incomeTab) {
    throw new Error(`Could not auto-detect P&L tab among top candidates: ${plScanOrder.slice(0, 5).join(', ')}. All available tabs: ${tabs.join(', ')}`);
  }

  // Find Transactions tab (name match — "Transactions Database" is distinctive)
  const txnTab = txnScanOrder.find(t => TXN_CANDIDATES.some(pat => pat.test(t)));

  const headerRow = incomeRows[headerRowIdx];
  const monthCols = []; // { colIdx, shortLabel, fullLabel }

  // Parse any cell that represents a month → returns { monShort: "Apr", year4: 2026 } or null
  function parseMonthCell(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    // Try short month "Apr 2026" or "Apr 26"
    let m = s.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-\/.,]+(\d{2,4})$/i);
    if (m) {
      const monShort = m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase();
      const yr = parseInt(m[2], 10);
      const year4 = yr < 100 ? 2000 + yr : yr;
      return { monShort, year4 };
    }
    // Full month "January 2026"
    m = s.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i);
    if (m) {
      const fullName = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      const idx = MONTH_FULL.indexOf(fullName);
      if (idx >= 0) return { monShort: MONTH_SHORT[idx], year4: parseInt(m[2], 10) };
    }
    // ISO "2026-04"
    m = s.match(/^(\d{4})[\-\/](\d{1,2})$/);
    if (m) {
      const monIdx = parseInt(m[2], 10) - 1;
      if (monIdx >= 0 && monIdx < 12) return { monShort: MONTH_SHORT[monIdx], year4: parseInt(m[1], 10) };
    }
    // Date string "4/1/2026"
    m = s.match(/^(\d{1,2})\/\d{1,2}\/(\d{4})$/);
    if (m) {
      const monIdx = parseInt(m[1], 10) - 1;
      if (monIdx >= 0 && monIdx < 12) return { monShort: MONTH_SHORT[monIdx], year4: parseInt(m[2], 10) };
    }
    return null;
  }

  for (let c = 0; c < headerRow.length; c++) {
    const parsed = parseMonthCell(headerRow[c]);
    if (parsed) {
      const yrShort = String(parsed.year4).slice(2);
      const monFullIdx = MONTH_SHORT.indexOf(parsed.monShort);
      monthCols.push({
        colIdx: c,
        shortLabel: `${parsed.monShort} ${yrShort}`,
        fullLabel: `${MONTH_FULL[monFullIdx]} ${parsed.year4}`
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

  // Detect Actuals vs Forecast per month from the "Status" row
  function detectStatusRow() {
    // Scan rows near the header row (a few rows above or below) for a row labeled "Status"
    const scanStart = Math.max(0, headerRowIdx - 2);
    const scanEnd = Math.min(incomeRows.length, headerRowIdx + 4);
    for (let i = scanStart; i < scanEnd; i++) {
      const r = incomeRows[i] || [];
      const label = String(r[0] || '').toLowerCase().trim();
      if (label === 'status') return r;
    }
    return null;
  }
  const statusRow = detectStatusRow();
  const allIsForecast = monthCols.map(mc => {
    if (!statusRow) return false;
    const v = String(statusRow[mc.colIdx] || '').toLowerCase().trim();
    return v === 'forecast' || v === 'projection' || v === 'projected' || v.startsWith('budget');
  });

  // Pull all canonical rows from Income Summary
  const allTotalRev  = getMonthlyRow('Total Revenue');

  // Determine trim window: last N months ending at the latest month with data
  let lastNonZero = -1;
  for (let i = allTotalRev.length - 1; i >= 0; i--) {
    if (allTotalRev[i] !== 0) { lastNonZero = i; break; }
  }
  if (lastNonZero < 0) lastNonZero = allTotalRev.length - 1;
  // Include a lookahead window past the last actual month so future months
  // (e.g. June 2026 when actuals only run through April) stay selectable in
  // the global Period dropdown — needed for the Payments tab's "Collected ·
  // {month}" KPI, which targets the selected month. Capped at the actual
  // number of P&L columns in the sheet.
  const FUTURE_LOOKAHEAD = 6;
  const endCol = Math.min(allTotalRev.length, lastNonZero + 1 + FUTURE_LOOKAHEAD);
  const startCol = Math.max(0, endCol - TRAILING_MONTHS);
  const window = (arr) => arr.slice(startCol, endCol);

  const months = monthCols.slice(startCol, endCol).map(m => m.shortLabel);
  const PERIOD_LABELS = monthCols.slice(startCol, endCol).map(m => m.fullLabel);
  const isForecast = allIsForecast.slice(startCol, endCol);

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
  let txnDebug = { rowsRead: 0, headerFound: false, txnsKept: 0, error: null };

  if (txnTab) {
    try {
      const txnRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `'${txnTab}'!A1:Z50000`,
        valueRenderOption: 'FORMATTED_VALUE'
      });
      const txnRows = txnRes.data.values || [];
      txnDebug.rowsRead = txnRows.length;
      const result = processTransactions(txnRows, months);
      txnDebug.headerFound = result.headerFound;
      txnDebug.txnsKept = (result.revTxnList || []).length + (result.expTxnList || []).length;
      MOM_DATA = result.mom;
      activeClients90d = result.active;
      REV_TXNS = result.revTxnList;
      EXP_TXNS = result.expTxnList;
    } catch (e) {
      console.error('[data.js] Failed to read transactions tab:', e.message);
      txnDebug.error = e.message;
    }
  } else {
    txnDebug.error = 'No transactions tab found in the spreadsheet';
  }

  // ── Budget tab read ──────────────────────────────────────────
  const budget = await fetchBudgetData(sheets, SHEET_ID, tabs);

  // ── Invoicing + Bookkeeping tab read (Payments tab data) ─────
  // Invoicing is split into two tabs — read both and merge. Each invoice
  // carries source = 'candidate' | 'client' (from its tab) so writes route
  // back correctly. Falls back to a single merged "Invoicing" tab if the
  // split tabs aren't present.
  const candidateTabName = matchInvoicingCandidateTab(tabs);
  const clientTabName     = matchInvoicingClientTab(tabs);

  let invoicingResults = [];
  if (candidateTabName || clientTabName) {
    if (candidateTabName) invoicingResults.push(await fetchInvoicingData(sheets, candidateTabName, 'candidate'));
    if (clientTabName)    invoicingResults.push(await fetchInvoicingData(sheets, clientTabName, 'client'));
  } else {
    // Fallback: single merged tab, source derived from the Service column.
    invoicingResults.push(await fetchInvoicingData(sheets, matchAnyInvoicingTab(tabs), null));
  }

  const mergedInvoices = invoicingResults.flatMap(r => r.invoices || []);
  const bookkeeping = await fetchBookkeepingData(sheets);

  // `receivables` shape is preserved for backwards-compat with the existing
  // frontend globals (RECEIVABLES.invoices etc.). The Payments tab reads this
  // same object — it carries service, placedSalary, finalAmount, statusRaw,
  // and source alongside the legacy aliases.
  const receivables = {
    invoices: mergedInvoices,
    tabs: invoicingResults.map(r => r.tab).filter(Boolean),
    meta: {
      total: mergedInvoices.length,
      pipeline: mergedInvoices.filter(x => x.sentState === 'pipeline').length,
      sent: mergedInvoices.filter(x => x.sentState === 'sent').length,
      paid: mergedInvoices.filter(x => x.sentState === 'paid').length,
      overdue: mergedInvoices.filter(x => x.sentState === 'overdue').length,
      candidate: mergedInvoices.filter(x => x.source === 'candidate').length,
      client: mergedInvoices.filter(x => x.source === 'client').length,
      sources: invoicingResults.map(r => ({ tab: r.tab, count: (r.invoices || []).length, error: r.meta && r.meta.error })),
      debug: invoicingResults.map(r => r.meta && r.meta.debug).filter(Boolean)
    }
  };

  return {
    months,
    PERIOD_LABELS,
    isForecast,
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
    budget,
    receivables,
    bookkeeping,
    _meta: {
      fetchedAt: new Date().toISOString(),
      incomeTab,
      txnTab: txnTab || null,
      monthsLoaded: months.length,
      window: `${months[0]} → ${months[months.length - 1]}`,
      forecastMonths: months.filter((_, i) => isForecast[i]),
      txnDebug,
      revenueEntities: MOM_DATA.revenue.length,
      expenseEntities: MOM_DATA.expenses.length,
      budget: budget.meta,
      receivables: receivables.meta,
      bookkeeping: bookkeeping.meta,
      invoicingTabs: receivables.tabs,
      bookkeepingTab: bookkeeping.tab
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
    return {
      mom: { months: monthsWindow, revenue: [], expenses: [] },
      active: new Array(monthsWindow.length).fill(0),
      revTxnList: [],
      expTxnList: [],
      headerFound: false
    };
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
    expTxnList,
    headerFound: true
  };
}

// ── Vercel handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    const now = Date.now();
    const forceRefresh = req.query && (req.query.refresh === '1' || req.query.fresh === '1');

    if (!forceRefresh && memCache && (now - memCacheAt) < CACHE_TTL_SECONDS * 1000) {
      res.setHeader('Cache-Control', `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=60`);
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(memCache);
    }

    const data = await fetchSheetData();
    memCache = data;
    memCacheAt = now;

    if (forceRefresh) {
      // Don't let edge cache serve this; signal it's fresh
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('X-Cache', 'BYPASS');
    } else {
      res.setHeader('Cache-Control', `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=60`);
      res.setHeader('X-Cache', 'MISS');
    }
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
