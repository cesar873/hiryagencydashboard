// POST /api/approve
// Sets the Approved cell to TRUE for a specific receivables row.
//
// Body:
//   { rowNumber: 17, verify: { candidate, client, billed } }
//
// The endpoint re-reads the target row and compares the verification keys
// before writing — protects against writes to the wrong row if the sheet
// was edited between read and write.

import {
  SHEET_ID,
  getSheetsClient,
  findReceivablesTab,
  findReceivablesHeader,
  findClientsReceivablesTab,
  findClientsReceivablesHeader,
  colNumToLetter
} from '../lib/sheets.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed; use POST' });
  }

  // Parse body — Vercel parses JSON automatically when content-type is set, but be defensive
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
  const source = (body.source === 'client') ? 'client' : 'candidate'; // default = candidate
  const verify = body.verify || {};

  try {
    const sheets = await getSheetsClient();

    // Locate the right receivables tab + header parser based on source
    const tab = source === 'client'
      ? await findClientsReceivablesTab(sheets)
      : await findReceivablesTab(sheets);
    if (!tab) return res.status(500).json({ error: `${source} receivables tab not found in spreadsheet` });

    const range = `'${tab}'!A1:AZ${rowNumber}`;
    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
      valueRenderOption: 'FORMATTED_VALUE'
    });
    const rows = readRes.data.values || [];
    const found = source === 'client'
      ? findClientsReceivablesHeader(rows)
      : findReceivablesHeader(rows);
    if (!found) return res.status(500).json({ error: `Could not parse ${source} receivables header row` });

    const { cols } = found;
    if (cols.approved < 0) {
      return res.status(500).json({ error: `No "Approved" column found in ${source} receivables tab` });
    }

    // Verify the row contents match what the client saw
    const targetRow = rows[rowNumber - 1] || [];
    const actualCandidate = String(targetRow[cols.candidateName] || '').trim();
    const actualClient = String(targetRow[cols.clientName] || '').trim();
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

    // Write TRUE to the Approved cell
    const colLetter = colNumToLetter(cols.approved + 1); // 0-idx → 1-idx
    const writeRange = `'${tab}'!${colLetter}${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: writeRange,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['TRUE']] }
    });

    return res.status(200).json({
      ok: true,
      rowNumber,
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
