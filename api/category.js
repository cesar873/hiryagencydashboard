// POST /api/category
// Writes the client-picked Category to Bookkeeping!N{row}.
//
// Body:
//   { rowNumber: 17, category: "Software & Subscriptions",
//     verify: { description, vendor } }
//
// Empty string clears the cell (row goes back to "Awaiting clarification"
// unless Comment is set). Category is expected to be one of the Chart of
// Accounts entries in Bookkeeping!B, but the server doesn't enforce that —
// Sheets-side data validation does, and any reject lands as a 400 here.

import {
  SHEET_ID,
  getSheetsClient,
  findBookkeepingTab,
  classifyBookkeepingColumns
} from '../lib/sheets.js';

const CATEGORY_COL = 'N'; // fixed by spec — see dashboard_buildout.md §"Two-way sync"

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
  const category = body.category != null ? String(body.category).trim() : '';
  if (category.length > 200) return res.status(400).json({ error: 'category too long' });
  const verify = body.verify || {};

  try {
    const sheets = await getSheetsClient();
    const tab = await findBookkeepingTab(sheets);
    if (!tab) return res.status(500).json({ error: 'Bookkeeping tab not found' });

    // Read header (row 1) + the target row in one call, then classify columns
    // by header — same logic the reader uses — so verification compares the
    // RIGHT cells regardless of where vendor/description actually sit.
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

    const writeRange = `'${tab}'!${CATEGORY_COL}${rowNumber}`;
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: writeRange,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[category]] }
      });
    } catch (e) {
      // Most likely cause: data validation on N rejected the value.
      return res.status(400).json({
        error: 'Sheets rejected the category. It must match one of the Chart of Accounts entries in column B.',
        detail: e.message
      });
    }

    return res.status(200).json({
      ok: true,
      rowNumber,
      category,
      cellWritten: writeRange,
      savedAt: new Date().toISOString(),
      context: {
        date: String(targetRow[cols.date] || '').trim(),
        vendor: actualVendor,
        description: actualDescription,
        amount: String(targetRow[cols.amount] || '').trim()
      }
    });
  } catch (e) {
    console.error('[api/category] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
