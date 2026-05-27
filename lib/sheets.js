// Shared helper: authenticate to Google Sheets with the service-account JWT.
// Used by /api/data, /api/approve, /api/note, /api/status, /api/category, /api/comment.

import { google } from 'googleapis';

export const SHEET_ID = '13_ta2rPtKUNmVZwbZRWC3IbOwwipf89VIA3Q0oD1n5s';

export async function getSheetsClient() {
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
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

export function colNumToLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ────────────────────────────────────────────────────────────
// Invoicing tab (merged: was Candidates Receivables + Clients Receivables)
// ────────────────────────────────────────────────────────────
//
// The Hiry sheet now has a single tab called "Invoicing" that carries every
// invoice line, distinguished by a `Service` column:
//   - "Placement"   → candidate-driven (Hiry placed a candidate into a job)
//   - "Recruitment" → client-driven (client engaged Hiry to recruit)
//
// Expected columns (matched case-insensitive by header text — order tolerant):
//   Service · Client Name · Candidate Name · Job Title · Date · Due Date
//   Currency · Invoice # · Deposit · Monthly Salary · Commission
//   · Invoice Amount · Approved · Sent · Status · Date Paid · Billing Address · Notes
//
// Falls back to legacy tab names (Clients Receivables / Candidates Receivables)
// only if the merged Invoicing tab can't be found — that way the dashboard
// keeps working through the migration window.

export async function findInvoicingTab(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const tabs = meta.data.sheets.map(s => s.properties.title);
  return tabs.find(t => /^invoicing$/i.test(t)) ||
         tabs.find(t => /^invoices?$/i.test(t)) ||
         tabs.find(t => /clients?\s*receivable/i.test(t)) ||
         tabs.find(t => /candidate.*receivable/i.test(t)) ||
         tabs.find(t => /^receivable/i.test(t)) ||
         null;
}

// Returns { headerRowIdx, cols } or null. Column indexes are 0-based.
export function findInvoicingHeader(rows) {
  // Match `Approved`, `Approved Julius`, `Approval`, `Approval Status`, `Is Approved`.
  const APPROVAL_RE = /^(approved(\s+\w+)?|approval(\s+status)?|is\s+approved)$/;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const row = (rows[i] || []).map(c => String(c || '').trim().toLowerCase());
    const hasClient = row.includes('client name') || row.includes('client');
    const hasCandidate = row.includes('candidate name') || row.includes('candidate');
    const hasAmount = row.some(c => /invoice\s*amount|final\s*amount|billed/.test(c));
    const hasApproved = row.some(c => APPROVAL_RE.test(c));
    if (hasClient && hasCandidate && (hasAmount || hasApproved)) {
      const idxOf = (...candidates) => {
        for (const cand of candidates) {
          const re = cand instanceof RegExp ? cand : new RegExp(`^${cand}$`);
          for (let c = 0; c < row.length; c++) if (re.test(row[c])) return c;
        }
        return -1;
      };
      // `status` must NOT pick up "approval status" — match exact "status" only.
      const cols = {
        service:        idxOf('service', 'service line'),
        clientName:     idxOf('client name', 'client'),
        candidateName:  idxOf('candidate name', 'candidate'),
        jobTitle:       idxOf('job title', 'role'),
        date:           idxOf('date', 'invoice date'),
        dueDate:        idxOf('due date'),
        currency:       idxOf('currency'),
        invoiceNum:     idxOf('invoice #', 'invoice number', 'invoice no'),
        deposit:        idxOf('deposit'),
        monthlySalary:  idxOf('monthly salary', 'placed salary', 'salary'),
        commission:     idxOf('commission', 'commission %'),
        invoiceAmount:  idxOf('invoice amount', 'final amount', 'amount'),
        approved:       idxOf(APPROVAL_RE),
        sent:           idxOf('sent'),
        status:         idxOf('status', 'invoice status', 'payment status'),
        datePaid:       idxOf('date paid', 'paid date'),
        billingAddress: idxOf('billing address', 'address'),
        notes:          idxOf('notes', 'note', 'comments')
      };
      return { headerRowIdx: i, cols };
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// Bookkeeping tab — Chart of Accounts (col B) + unclear-transaction queue (E:O)
// ────────────────────────────────────────────────────────────
//
// Column layout (spec'd in dashboard_buildout.md):
//   B    → CoA category per row (row 2+)
//   E:M  → bookkeeper-posted transaction context. E–L are matched by header
//          (Date / Vendor / Description / Amount). M is always bound to
//          `account` regardless of header — clients recognise spends by card/bank.
//          Anything else in E:L is surfaced in `raw` for the row-click popover.
//   N    → client-picked Category (data validation against col B)
//   O    → client free-text Comment
//
// Row is "awaiting clarification" while N and O are both empty; "clarified" once
// either is non-empty. Bookkeeper deletes the row when they action it.

export async function findBookkeepingTab(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const tabs = meta.data.sheets.map(s => s.properties.title);
  return tabs.find(t => /^bookkeeping$/i.test(t)) ||
         tabs.find(t => /book.?keeping/i.test(t)) ||
         null;
}

// Classify a header label into one of our known fields. Returns the canonical
// key ('date' | 'vendor' | 'description' | 'amount') or null if unrecognised.
function classifyBookkeepingHeader(label) {
  const s = String(label || '').trim().toLowerCase();
  if (!s) return null;
  if (/^date|posted|transaction\s*date/.test(s)) return 'date';
  if (/vendor|merchant|payee|name/.test(s)) return 'vendor';
  if (/desc|memo|detail/.test(s)) return 'description';
  if (/^amount|total/.test(s)) return 'amount';
  return null;
}

// Classify the E:O columns of the Bookkeeping tab by header text, with
// positional fallbacks. Column M (account), N (category), O (comment) are
// fixed by spec. E–L (date / vendor / description / amount + extras) are
// matched by header so the reader and the write endpoints stay in lockstep —
// otherwise the writers' row-verification compares the wrong cells and 409s.
//
// Returns { cols: { date, vendor, description, amount, account, category,
// comment }, rawCols: [{ colIdx, label }] } where rawCols are unclassified
// bookkeeper columns surfaced in the row-detail popover.
export function classifyBookkeepingColumns(headerRowRaw) {
  const headerRow = (headerRowRaw || []).map(c => String(c || '').trim());
  const cols = {};
  const rawCols = [];
  for (let c = 4; c <= 11; c++) {         // E=4 … L=11
    const label = headerRow[c] || '';
    const key = classifyBookkeepingHeader(label);
    if (key && cols[key] == null) cols[key] = c;
    else if (label) rawCols.push({ colIdx: c, label });
  }
  // Positional fallbacks for any header we couldn't classify
  if (cols.date == null)        cols.date = 4;        // E
  if (cols.vendor == null)      cols.vendor = 5;      // F
  if (cols.description == null) cols.description = 6; // G
  if (cols.amount == null)      cols.amount = 7;      // H
  // Fixed by spec
  cols.account  = 12; // M
  cols.category = 13; // N
  cols.comment  = 14; // O
  return { cols, rawCols };
}

// Parse the Bookkeeping tab rows into { coa, transactions }.
// `rows` should be the full grid (A1:O500-ish).
export function parseBookkeepingRows(rows) {
  const coa = [];
  const transactions = [];
  if (!rows || rows.length === 0) return { coa, transactions };

  // 1) Chart of Accounts from column B, row 2+
  const seenCoA = new Set();
  for (let i = 1; i < rows.length; i++) {
    const v = String((rows[i] || [])[1] || '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seenCoA.has(key)) continue;
    seenCoA.add(key);
    coa.push(v);
  }
  coa.sort((a, b) => a.localeCompare(b));

  // 2) Classify the E:O columns by header (shared with the write endpoints
  //    so reader + writer always agree on which column is which).
  const { cols: classified, rawCols } = classifyBookkeepingColumns(rows[0]);

  // 3) Transactions. Skip a row only if every E:O cell is empty.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    let anyContent = false;
    for (let c = 4; c <= 14; c++) {
      if (String(row[c] || '').trim() !== '') { anyContent = true; break; }
    }
    if (!anyContent) continue;

    const date        = String(row[classified.date] || '').trim();
    const vendor      = String(row[classified.vendor] || '').trim();
    const description = String(row[classified.description] || '').trim();
    const amountRaw   = String(row[classified.amount] || '').trim();
    const account     = String(row[12] || '').trim();   // M
    const category    = String(row[13] || '').trim();   // N
    const comment     = String(row[14] || '').trim();   // O

    // raw: any extra bookkeeper columns the dashboard didn't classify
    const raw = {};
    for (const { colIdx, label } of rawCols) {
      const v = String(row[colIdx] || '').trim();
      if (v) raw[label] = v;
    }

    transactions.push({
      rowNumber: i + 1,
      date,
      vendor,
      description,
      amountRaw,
      account,
      category,
      comment,
      raw,
      cleared: !!(category || comment)
    });
  }

  return { coa, transactions };
}

// ────────────────────────────────────────────────────────────
// Legacy helpers — kept so older code paths keep compiling. The merged
// Invoicing reader is preferred everywhere new.
// ────────────────────────────────────────────────────────────

export async function findReceivablesTab(sheets) {
  // Legacy candidate-side tab finder. Resolves to the merged Invoicing tab now.
  return findInvoicingTab(sheets);
}

export async function findClientsReceivablesTab(sheets) {
  // Legacy client-side tab finder. Resolves to the merged Invoicing tab now.
  return findInvoicingTab(sheets);
}

// Legacy header parsers — delegate to findInvoicingHeader so the candidate/client
// distinction collapses cleanly. Returns the same shape callers already expect.
export function findReceivablesHeader(rows) {
  const found = findInvoicingHeader(rows);
  if (!found) return null;
  return {
    headerRowIdx: found.headerRowIdx,
    cols: {
      ...found.cols,
      // candidate-tab legacy fields
      invoiceDate: found.cols.date,
      billed: found.cols.monthlySalary,  // candidate tab "billed" was monthly value
      monthCols: []
    }
  };
}

export function findClientsReceivablesHeader(rows) {
  return findInvoicingHeader(rows);
}
