// POST /api/status
// Updates the Status cell for a specific Invoicing row.
//
// Body:
//   { rowNumber: 17, status: "Ready",
//     verify: { candidate, client } }
//
// Allowed statuses (case-insensitive): In Progress, AgenCFO Review,
// Client Review, Ready, Unpaid, Partially Paid, Fully Paid. Anything else
// is written through as-is so the sheet stays the source of truth.

import {
  SHEET_ID,
  getSheetsClient,
  findInvoicingTabForSource,
  findInvoicingHeader,
  colNumToLetter
} from '../lib/sheets.js';

const ALLOWED = [
  'In Progress', 'AgenCFO Review', 'Client Review', 'Ready',
  'Unpaid', 'Partially Paid', 'Fully Paid', 'Paid', 'Open', 'Sent', 'Overdue'
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed; use POST' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }
  if (!body) body = {};

  const rowNumber = parseInt(body.rowNumber, 10);
  if (!rowNumber || rowNumber < 2) {
    return res.status(400).json({ error: 'rowNumber required and must be >= 2' });
  }
  const statusRaw = body.status != null ? String(body.status).trim() : '';
  if (!statusRaw) return res.status(400).json({ error: 'status required' });
  if (statusRaw.length > 100) return res.status(400).json({ error: 'status too long' });

  // Canonicalise to the allowed casing if it matches; else pass through.
  const canonical = ALLOWED.find(s => s.toLowerCase() === statusRaw.toLowerCase()) || statusRaw;

  const source = (body.source === 'candidate' || body.source === 'client') ? body.source : null;
  const verify = body.verify || {};

  try {
    const sheets = await getSheetsClient();
    const tab = await findInvoicingTabForSource(sheets, source);
    if (!tab) return res.status(500).json({ error: `Invoicing tab not found for source "${source || '(none)'}"` });

    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${tab}'!A1:AZ${rowNumber}`,
      valueRenderOption: 'FORMATTED_VALUE'
    });
    const rows = readRes.data.values || [];
    const found = findInvoicingHeader(rows);
    if (!found) return res.status(500).json({ error: 'Could not parse Invoicing header row' });
    const { cols } = found;
    if (cols.status < 0) return res.status(500).json({ error: 'No "Status" column found in Invoicing tab' });

    const targetRow = rows[rowNumber - 1] || [];
    const actualCandidate = cols.candidateName >= 0 ? String(targetRow[cols.candidateName] || '').trim() : '';
    const actualClient    = cols.clientName    >= 0 ? String(targetRow[cols.clientName] || '').trim()    : '';
    if (verify.candidate && verify.candidate !== actualCandidate) {
      return res.status(409).json({ error: 'Row verification failed (candidate mismatch).', expected: verify.candidate, actual: actualCandidate });
    }
    if (verify.client && verify.client !== actualClient) {
      return res.status(409).json({ error: 'Row verification failed (client mismatch).', expected: verify.client, actual: actualClient });
    }

    const colLetter = colNumToLetter(cols.status + 1);
    const writeRange = `'${tab}'!${colLetter}${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: writeRange,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[canonical]] }
    });

    return res.status(200).json({
      ok: true,
      rowNumber,
      status: canonical,
      cellWritten: writeRange,
      savedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[api/status] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
