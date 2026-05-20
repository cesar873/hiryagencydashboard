// Shared helper: authenticate to Google Sheets with the service-account JWT.
// Used by /api/data, /api/approve, /api/note.

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

// Helpers used by write endpoints
export function colNumToLetter(n) {
  // 1 → A, 26 → Z, 27 → AA
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Find the Receivables tab name (case-insensitive, several aliases)
export async function findReceivablesTab(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const tabs = meta.data.sheets.map(s => s.properties.title);
  return tabs.find(t => /^receivable/i.test(t)) ||
         tabs.find(t => /invoice/i.test(t) && !/database/i.test(t));
}

// Standard receivables column layout. Indexes are 0-based within the row.
// Returns { headerRowIdx, cols: { invoiceDate, invoiceNum, candidateName, clientName, notes, currency, billed, commission, approved, sent, monthCols: [{label, colIdx}] } }
export function findReceivablesHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const row = (rows[i] || []).map(c => String(c || '').trim().toLowerCase());
    if (row.includes('candidate name') && row.includes('client name') && row.includes('billed')) {
      const orig = rows[i].map(c => String(c || '').trim());
      const idx = (label) => row.indexOf(label.toLowerCase());
      const cols = {
        invoiceDate: idx('invoice date'),
        invoiceNum:  idx('invoice #'),
        candidateName: idx('candidate name'),
        clientName: idx('client name'),
        notes: idx('notes'),
        currency: idx('currency'),
        billed: idx('billed'),
        commission: idx('commission'),
        approved: idx('approved'),
        sent: idx('sent'),
        monthCols: []
      };
      // Month columns appear after Sent
      const monthRegex = /^([A-Z][a-z]{2,8})\s+(\d{4})$/;
      for (let c = (cols.sent >= 0 ? cols.sent + 1 : 0); c < orig.length; c++) {
        const m = orig[c].match(monthRegex);
        if (m) cols.monthCols.push({ label: orig[c], colIdx: c });
      }
      return { headerRowIdx: i, cols };
    }
  }
  return null;
}
