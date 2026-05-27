// POST /api/comment
// Writes the client free-text Comment to Bookkeeping!O{row}.
//
// Body:
//   { rowNumber: 17, comment: "personal — please reclassify",
//     verify: { description, vendor } }
//
// Replace semantics (not append) — comments on transactions are short
// clarifications, not running logs (see dashboard_buildout.md Anti-pattern).
// Empty string clears the cell.

import {
  SHEET_ID,
  getSheetsClient,
  findBookkeepingTab,
  classifyBookkeepingColumns
} from '../lib/sheets.js';

const COMMENT_COL = 'O'; // fixed by spec — see dashboard_buildout.md §"Two-way sync"

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
  const comment = body.comment != null ? String(body.comment) : '';
  if (comment.length > 1000) return res.status(400).json({ error: 'comment exceeds 1000 chars' });
  const verify = body.verify || {};

  try {
    const sheets = await getSheetsClient();
    const tab = await findBookkeepingTab(sheets);
    if (!tab) return res.status(500).json({ error: 'Bookkeeping tab not found' });

    // Read header (row 1) + target row, classify columns by header — same as
    // the reader — so verification checks the right cells.
    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${tab}'!A1:O${rowNumber}`,
      valueRenderOption: 'FORMATTED_VALUE'
    });
    const allRows = readRes.data.values || [];
    const { cols } = classifyBookkeepingColumns(allRows[0]);
    const targetRow = allRows[rowNumber - 1] || [];
    const actualVendor      = String(targetRow[cols.vendor] || '').trim();
    const actualDescription = String(targetRow[cols.description] || '').trim();
    if (verify.vendor && verify.vendor !== actualVendor) {
      return res.status(409).json({ error: 'Row verification failed (vendor mismatch).', expected: verify.vendor, actual: actualVendor });
    }
    if (verify.description && verify.description !== actualDescription) {
      return res.status(409).json({ error: 'Row verification failed (description mismatch).', expected: verify.description, actual: actualDescription });
    }

    const writeRange = `'${tab}'!${COMMENT_COL}${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: writeRange,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[comment]] }
    });

    return res.status(200).json({
      ok: true,
      rowNumber,
      comment,
      cellWritten: writeRange,
      savedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[api/comment] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
