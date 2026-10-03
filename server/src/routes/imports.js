/**
 * Uploading a club's own tee sheet.
 *
 * Two steps on purpose. `POST /preview` reads the file and says what it found
 * — how it read the dates, which columns it could not place, which rows it
 * would refuse and which are already here — and writes nothing. `POST /commit`
 * takes that back and inserts.
 *
 * The split exists because the failure that matters is silent: a sheet whose
 * 03/04 means 4 March imports perfectly and is wrong in every row. Somebody has
 * to look at the dates before they land.
 *
 * Everything written this way is marked `source = 'imported'`, which keeps it
 * out of the conversion funnel — those bookings were made in the club's own
 * system and were never a TeeMail enquiry.
 */
import { Router } from 'express';
import { pool, query } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { serialiseBooking } from '../lib/bookings-domain.js';
import { BOOKING_SELECT } from '../lib/schema.js';
import { markDuplicates, mintBatchId, mintImportedBookingId, parseTeeSheet } from '../lib/import-domain.js';
import { SheetTooLargeError, checkRowCount, readXlsxRows } from '../lib/sheet-reader.js';

const router = Router();
router.use(requireAuth);

/** One upload never writes more than this, so a stray file cannot fill a table. */
const MAX_ROWS = 5000;

router.get('/config', async (req, res, next) => {
  try {
    res.json({
      maxRows: MAX_ROWS,
      batches: await loadBatches(req.user.customerId),
    });
  } catch (err) {
    next(err);
  }
});

/** Read the file and report. Writes nothing. */
router.post('/preview', async (req, res, next) => {
  try {
    const rows = await readRows(req.body);
    if (rows.error) return res.status(400).json({ error: rows.error });

    const parsed = parseTeeSheet(rows.rows, { dayFirst: req.body?.dayFirst !== false });
    if (!parsed.ok) return res.status(400).json({ error: parsed.error, headers: parsed.headers });

    const existing = await loadComparableBookings(parsed.bookings, req.user.customerId);
    const { fresh, duplicates } = markDuplicates(parsed.bookings, existing);

    res.json({
      ...parsed,
      fresh: fresh.length,
      duplicates: duplicates.length,
      duplicateSample: duplicates.slice(0, 5),
      tooMany: fresh.length > MAX_ROWS ? MAX_ROWS : null,
    });
  } catch (err) {
    next(err);
  }
});

/** Write the rows the preview showed. */
router.post('/commit', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const rows = await readRows(req.body);
    if (rows.error) return res.status(400).json({ error: rows.error });

    const parsed = parseTeeSheet(rows.rows, { dayFirst: req.body?.dayFirst !== false });
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const existing = await loadComparableBookings(parsed.bookings, req.user.customerId);
    const { fresh, duplicates } = markDuplicates(parsed.bookings, existing);
    if (!fresh.length) {
      return res.status(409).json({
        error: duplicates.length
          ? `Every row in that file is already here (${duplicates.length} duplicate${duplicates.length === 1 ? '' : 's'})`
          : 'That file has no rows this dashboard can use',
      });
    }

    const batchId = mintBatchId();
    const wanted = fresh.slice(0, MAX_ROWS);

    // One transaction: a half-written batch would be neither importable again
    // (the rows exist) nor usable (the rest are missing).
    await client.query('BEGIN');
    let inserted = 0;

    for (const booking of wanted) {
      const bookingId = booking.bookingId || mintImportedBookingId();
      const note = [`Imported from the club tee sheet (${batchId}).`, booking.notes].filter(Boolean).join(' ');

      const { rowCount } = await client.query(
        `INSERT INTO public.bookings
           (booking_id, guest_email, guest_name, contact_phone, date, tee_time, players,
            total, status, note, club, golf_courses, source, import_batch, imported_at, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'imported',$13,NOW(),NOW())
         ON CONFLICT (booking_id) DO NOTHING`,
        [
          bookingId,
          booking.guestEmail,
          booking.guestName,
          booking.contactPhone,
          booking.date,
          booking.teeTime ?? 'Not Specified',
          booking.players,
          booking.total,
          booking.status,
          note,
          req.user.customerId,
          booking.golfCourses,
          batchId,
        ],
      );
      inserted += rowCount;
    }

    await client.query('COMMIT');

    res.status(201).json({
      batchId,
      inserted,
      skippedDuplicates: duplicates.length,
      rejected: parsed.rejected.length,
      truncated: fresh.length > MAX_ROWS ? fresh.length - MAX_ROWS : 0,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

/**
 * Undo a whole upload.
 *
 * Only rows still untouched since the import go: anything somebody has since
 * worked on is theirs, not the importer's, and deleting it would throw away
 * work to tidy up a mistake.
 */
// Undoing an upload deletes bookings in bulk, so only an administrator may.
router.delete('/:batchId', requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await query(
      `DELETE FROM public.bookings
        WHERE import_batch = $1 AND club = $2 AND source = 'imported' AND updated_at IS NULL`,
      [req.params.batchId, req.user.customerId],
    );

    const { rows: left } = await query(
      'SELECT COUNT(*)::int AS count FROM public.bookings WHERE import_batch = $1 AND club = $2',
      [req.params.batchId, req.user.customerId],
    );

    res.json({
      deleted: rowCount,
      kept: left[0].count,
      message: left[0].count
        ? `${rowCount} removed; ${left[0].count} kept because somebody has edited them since`
        : `${rowCount} removed`,
    });
  } catch (err) {
    next(err);
  }
});

/* ---------- helpers ---------- */

/**
 * The file, as rows of cells.
 *
 * The browser sends the file base64-encoded in JSON rather than as a multipart
 * upload: it saves a dependency, and a tee sheet is a few hundred kilobytes.
 */
async function readRows(body) {
  const name = String(body?.filename ?? '').toLowerCase();
  const content = String(body?.content ?? '');
  if (!content) return { error: 'No file was uploaded' };

  const buffer = Buffer.from(content, 'base64');
  if (buffer.length > 8 * 1024 * 1024) return { error: 'That file is larger than 8MB' };

  try {
    if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
      try {
        const rows = await readXlsxRows(buffer);
        return rows.length ? { rows } : { error: 'That workbook has no rows on its first sheet' };
      } catch (err) {
        if (err instanceof SheetTooLargeError) throw err;
        return { error: 'That file could not be read as a spreadsheet' };
      }
    }
    return { rows: checkRowCount(parseCsv(buffer.toString('utf8'))) };
  } catch (err) {
    if (err instanceof SheetTooLargeError) return { error: err.message };
    throw err;
  }
}

/**
 * CSV, including quoted fields with commas and newlines in them — which club
 * exports are full of, because notes fields are free text.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const body = text.replace(/^\uFEFF/, ''); // Excel writes a byte-order mark

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];

    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((line) => line.length);
}

/** Only bookings that could collide: this club's, on the dates in the file. */
async function loadComparableBookings(parsed, club) {
  const dates = parsed
    .map((booking) => booking.date)
    .filter(Boolean)
    .sort();
  if (!dates.length) return [];

  const { rows } = await query(
    `SELECT ${BOOKING_SELECT} FROM public.bookings
      WHERE club = $1 AND date BETWEEN $2::date AND $3::date`,
    [club, dates[0], dates.at(-1)],
  );
  return rows.map(serialiseBooking);
}

async function loadBatches(club) {
  const { rows } = await query(
    `SELECT import_batch AS "batchId", COUNT(*)::int AS bookings,
            MIN(date) AS "firstDate", MAX(date) AS "lastDate", MAX(imported_at) AS "importedAt"
       FROM public.bookings
      WHERE club = $1 AND import_batch IS NOT NULL
      GROUP BY import_batch ORDER BY MAX(imported_at) DESC LIMIT 20`,
    [club],
  );
  return rows.map((row) => ({
    ...row,
    firstDate: row.firstDate ? new Date(row.firstDate).toISOString().slice(0, 10) : null,
    lastDate: row.lastDate ? new Date(row.lastDate).toISOString().slice(0, 10) : null,
    importedAt: row.importedAt ? new Date(row.importedAt).toISOString() : null,
  }));
}

export default router;
