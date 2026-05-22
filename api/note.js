// POST /api/note
// Updates the notes cell for a specific receivables row.
//
// Body:
//   { rowNumber: 17, note: "Awaiting client confirmation",
//     verify: { candidate, client } }

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
  const note = body.note != null ? String(body.note) : '';
  if (note.length > 1000) {
    return res.status(400).json({ error: 'note exceeds 1000 chars' });
  }
  const source = (body.source === 'client') ? 'client' : 'candidate';
  const verify = body.verify || {};

  try {
    const sheets = await getSheetsClient();
    const tab = source === 'client'
      ? await findClientsReceivablesTab(sheets)
      : await findReceivablesTab(sheets);
    if (!tab) return res.status(500).json({ error: `${source} receivables tab not found` });

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
    if (cols.notes < 0) return res.status(500).json({ error: 'No "notes" column found' });

    const targetRow = rows[rowNumber - 1] || [];
    const actualCandidate = String(targetRow[cols.candidateName] || '').trim();
    const actualClient = String(targetRow[cols.clientName] || '').trim();
    if (verify.candidate && verify.candidate !== actualCandidate) {
      return res.status(409).json({ error: 'Row verification failed (candidate mismatch).', expected: verify.candidate, actual: actualCandidate });
    }
    if (verify.client && verify.client !== actualClient) {
      return res.status(409).json({ error: 'Row verification failed (client mismatch).', expected: verify.client, actual: actualClient });
    }

    const colLetter = colNumToLetter(cols.notes + 1);
    const writeRange = `'${tab}'!${colLetter}${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: writeRange,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[note]] }
    });

    return res.status(200).json({
      ok: true,
      rowNumber,
      note,
      cellWritten: writeRange,
      savedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[api/note] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
