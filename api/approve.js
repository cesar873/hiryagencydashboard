// POST /api/approve
// Client-side "Approve" action. With the Approval Status column retired,
// approval is now a STATUS TRANSITION: writes "AgenCFO Review" to the Status
// cell of the target row. The row will move from "Awaiting Your Review" to
// "Scheduled" on the next dashboard read.
//
// Body:
//   { rowNumber: 17, verify: { candidate, client } }
//
// Re-reads the target row and compares verify keys before writing — protects
// against writes to the wrong row if the sheet was edited between read + write.

import {
  SHEET_ID,
  getSheetsClient,
  findInvoicingTabForSource,
  findInvoicingHeader,
  colNumToLetter
} from '../lib/sheets.js';

// The status value to write when the client clicks Approve. Mirrors the
// allowed list in api/status.js — exact casing matters because data
// validation on the Status column is keyed to this exact string.
const APPROVED_STATUS = 'AgenCFO Review';

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
  const source = (body.source === 'candidate' || body.source === 'client') ? body.source : null;
  const verify = body.verify || {};

  try {
    const sheets = await getSheetsClient();

    const tab = await findInvoicingTabForSource(sheets, source);
    if (!tab) return res.status(500).json({ error: `Invoicing tab not found for source "${source || '(none)'}"` });

    const range = `'${tab}'!A1:AZ${rowNumber}`;
    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
      valueRenderOption: 'FORMATTED_VALUE'
    });
    const rows = readRes.data.values || [];
    const found = findInvoicingHeader(rows);
    if (!found) return res.status(500).json({ error: 'Could not parse Invoicing header row' });

    const { cols } = found;
    if (cols.status < 0) {
      return res.status(500).json({ error: 'No "Status" column found in Invoicing tab — Approve needs Status to transition into.' });
    }

    const targetRow = rows[rowNumber - 1] || [];
    const actualCandidate = cols.candidateName >= 0 ? String(targetRow[cols.candidateName] || '').trim() : '';
    const actualClient    = cols.clientName    >= 0 ? String(targetRow[cols.clientName] || '').trim()    : '';
    if (verify.candidate && verify.candidate !== actualCandidate) {
      return res.status(409).json({
        error: 'Row verification failed (candidate mismatch). Refresh and try again.',
        expected: verify.candidate,
        actual: actualCandidate
      });
    }
    if (verify.client && verify.client !== actualClient) {
      return res.status(409).json({
        error: 'Row verification failed (client mismatch). Refresh and try again.',
        expected: verify.client,
        actual: actualClient
      });
    }

    // Sanity guard: only transition rows that are actually awaiting client
    // approval. If someone hits this endpoint for a row that's already past
    // Client Review (e.g. already sent or paid), refuse — saves us from
    // accidentally regressing a row's lifecycle.
    const currentStatus = String(targetRow[cols.status] || '').trim();
    const csLower = currentStatus.toLowerCase();
    if (csLower && csLower !== 'client review') {
      return res.status(409).json({
        error: `Row is not in Client Review (current status: "${currentStatus}"). Approve only applies to rows awaiting client approval.`,
        currentStatus
      });
    }

    const colLetter = colNumToLetter(cols.status + 1);
    const writeRange = `'${tab}'!${colLetter}${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: writeRange,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[APPROVED_STATUS]] }
    });

    return res.status(200).json({
      ok: true,
      rowNumber,
      previousStatus: currentStatus || '(blank)',
      newStatus: APPROVED_STATUS,
      approvedAt: new Date().toISOString(),
      candidate: actualCandidate,
      client: actualClient,
      cellWritten: writeRange
    });
  } catch (e) {
    console.error('[api/approve] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
