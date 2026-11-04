import { Router } from 'express';
import ExcelJS from 'exceljs';
import { query } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { csvLine, defuseRow } from '../lib/csv.js';
import { ALLOWED_STATUSES, normaliseStatus, extractTeeTimeFromNote, serialiseBooking } from '../lib/bookings-domain.js';
import { BOOKING_SELECT, OPERATOR_SELECT, buildAuditSet } from '../lib/schema.js';
import {
  PAYMENT_STATUSES,
  attachOperators,
  buildOperatorIndex,
  identify,
  normalisePaymentStatus,
  paymentState,
  serialiseOperator,
  paymentTracking,
} from '../lib/operators-domain.js';
import { CLOCK_STARTING_PAYMENTS, todayInClubZone } from '../lib/email-domain.js';
import { syncIfStale } from '../lib/payment-sync.js';
import {
  NEW_BOOKING_SOURCES,
  columnFor,
  mintDeskReference,
  validateBookingEdit,
  validateNewBooking,
} from '../lib/booking-edit-domain.js';
import { BRAND } from '../lib/brand.js';
import { handoverBookedCustomer } from '../lib/booked-webhook-outbox.js';

const router = Router();
router.use(requireAuth);

async function loadBookings(club) {
  const { rows } = await query(
    `SELECT ${BOOKING_SELECT}
       FROM public.bookings
      WHERE club = $1
      ORDER BY timestamp DESC`,
    [club],
  );
  return rows.map(serialiseBooking);
}

/** One-column update, stamped with who made it. */
async function updateBookingField({ column, value, bookingId, club, username }) {
  const audit = buildAuditSet(3, username);

  const { rows } = await query(
    `UPDATE public.bookings
        SET "${column}" = $1, ${audit.clauses.join(', ')}
      WHERE booking_id = $2 AND club = $${3 + audit.values.length}
    RETURNING ${BOOKING_SELECT}`,
    [value, bookingId, ...audit.values, club],
  );

  return rows[0] ? serialiseBooking(rows[0]) : null;
}

/** The operators this club trades with. */
async function loadOperators(club) {
  const { rows } = await query(`SELECT ${OPERATOR_SELECT} FROM public.tour_operators WHERE club = $1`, [club]);
  return rows.map(serialiseOperator);
}

/**
 * One booking with its account and payment state, as the list serves it.
 *
 * Re-identified rather than read off tour_operator_id: most trade bookings
 * are matched on their sending domain and were never assigned an id, and a
 * row that came back from a save without its account would show the drawer
 * the wrong terms — and so the wrong due date.
 */
export async function withAccount(booking, club) {
  const operators = await loadOperators(club);
  const { operator } = identify(booking, buildOperatorIndex(operators));
  return {
    ...booking,
    operatorId: operator?.id ?? null,
    operatorName: operator?.name ?? null,
    payment: paymentState(booking, operator, { today: todayInClubZone(), tracking: paymentTracking() }),
  };
}

/**
 * Every booking with the trade account it was identified as belonging to, and
 * what it owes under that account's terms.
 *
 * Both are derived on read rather than stored, so a change to an operator's
 * credit terms is reflected in every one of their bookings immediately, and a
 * booking whose due date has simply passed reads as overdue without anybody
 * having to run a nightly job to say so.
 */
async function loadBookingsWithAccounts(club) {
  const [bookings, operators] = await Promise.all([loadBookings(club), loadOperators(club)]);

  const today = todayInClubZone();
  const tracking = paymentTracking();
  const index = buildOperatorIndex(operators);
  const byId = new Map(operators.map((operator) => [operator.id, operator]));

  const enriched = attachOperators(bookings, index).map((booking) => ({
    ...booking,
    payment: paymentState(booking, byId.get(booking.operatorId) ?? null, { today, tracking }),
  }));

  return { bookings: enriched, operators, today };
}

router.get('/', async (req, res, next) => {
  try {
    // Pick up Stripe payments before listing, so a paid booking never shows as
    // Pending just because a webhook delivery did not arrive. Bounded, so a
    // slow Stripe never holds the list up for long.
    await Promise.race([
      syncIfStale({ reason: 'bookings list', maxAgeMs: 10_000 }),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]).catch(() => {});
    const { bookings, operators, today } = await loadBookingsWithAccounts(req.user.customerId);
    res.json({
      bookings,
      today,
      paymentStatuses: PAYMENT_STATUSES,
      operators: operators.map(({ id, name, contactEmail, onHold, active }) => ({
        id,
        name,
        contactEmail,
        onHold,
        active,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The payment side of one booking: what has been invoiced, what has been paid,
 * and any due dates that override the operator's standard terms.
 *
 * Every field is optional — the drawer sends only what changed — and `null`
 * clears an override so the account terms apply again.
 */
router.patch('/:bookingId/payment', async (req, res, next) => {
  const body = req.body ?? {};
  const updates = {};

  if (body.paymentStatus !== undefined) {
    if (!PAYMENT_STATUSES.includes(body.paymentStatus)) {
      return res.status(400).json({ error: `Unknown payment status: ${body.paymentStatus}` });
    }
    updates.payment_status = normalisePaymentStatus(body.paymentStatus);
  }

  if (body.amountPaid !== undefined) {
    const amount = Number(body.amountPaid);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'amountPaid must be zero or more' });
    }
    updates.amount_paid = amount;
  }

  if (body.invoiceNumber !== undefined) {
    updates.invoice_number = String(body.invoiceNumber).trim() || null;
  }

  for (const [field, column] of [
    ['invoicedAt', 'invoiced_at'],
    ['depositDueDate', 'deposit_due_date'],
    ['balanceDueDate', 'balance_due_date'],
  ]) {
    if (body[field] === undefined) continue;
    const value = body[field];
    if (value === null || value === '') {
      updates[column] = null;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      updates[column] = String(value);
    } else {
      return res.status(400).json({ error: `${field} must be a YYYY-MM-DD date or null` });
    }
  }

  const names = Object.keys(updates);
  if (!names.length) return res.status(400).json({ error: 'Nothing to update' });

  try {
    const audit = buildAuditSet(names.length + 1, req.user.username);
    const params = names.map((name) => updates[name]);
    const sets = names.map((name, index) => `"${name}" = $${index + 1}`);
    // Money received by hand starts the pre-play emails the same way a Stripe
    // payment does; a booking whose clock is already running keeps its start.
    if (CLOCK_STARTING_PAYMENTS.includes(updates.payment_status)) {
      sets.push('pre_play_clock_started_at = COALESCE(pre_play_clock_started_at, NOW())');
    }

    params.push(...audit.values);
    params.push(req.params.bookingId, req.user.customerId);

    const { rows } = await query(
      `UPDATE public.bookings
          SET ${[...sets, ...audit.clauses].join(', ')}
        WHERE booking_id = $${params.length - 1} AND club = $${params.length}
      RETURNING ${BOOKING_SELECT}`,
      params,
    );

    if (!rows[0]) return res.status(404).json({ error: 'Booking not found' });

    res.json({ booking: await withAccount(serialiseBooking(rows[0]), req.user.customerId) });
  } catch (err) {
    next(err);
  }
});

/**
 * Take a booking by hand: over the phone, at the counter, or from an email
 * that reached the office rather than the bot.
 *
 * It goes in exactly as one the bot took would -- a reference in the bot's own
 * format, so the guest's replies find it; `booked_at` stamped when it is taken
 * as Booked, so the payment ladder counts its deposit window from today -- and
 * from there it is an ordinary booking: paid for from the drawer, chased and
 * confirmed by the same emails as any other.
 */
router.post('/', async (req, res, next) => {
  try {
    const club = req.user.customerId;
    const operators = await loadOperators(club);
    const check = validateNewBooking(req.body, { today: todayInClubZone(), operators });
    if (!check.ok) return res.status(400).json({ error: check.errors.join('. '), errors: check.errors });

    const booking = check.value;
    const source = NEW_BOOKING_SOURCES[booking.source];
    // Who took it and how, at the head of the note, so the record says so
    // wherever the note is read.
    const note = [`Taken by ${req.user.username} (${source.toLowerCase()}).`, booking.note]
      .filter(Boolean)
      .join('\n\n');

    let inserted = null;
    // A clash on eight random hex characters within one day is all but
    // impossible; trying again is cheaper than reasoning about it.
    for (let attempt = 0; attempt < 3 && !inserted; attempt += 1) {
      const { rows } = await query(
        `INSERT INTO public.bookings
           (booking_id, club, guest_email, guest_name, contact_phone, date, tee_time, players, total,
            status, note, special_requests, tour_operator_id, source, timestamp, booked_at, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text,$11,$12,$13,$14,NOW(),
                 CASE WHEN $10::text = 'Booked' THEN NOW() END, NOW(), $15)
         ON CONFLICT (booking_id) DO NOTHING
         RETURNING ${BOOKING_SELECT}`,
        [
          mintDeskReference(),
          club,
          booking.guestEmail ?? '',
          booking.guestName ?? '',
          booking.contactPhone ?? '',
          booking.date,
          booking.teeTime ?? 'Not Specified',
          booking.players,
          booking.total,
          booking.status,
          note,
          booking.specialRequests ?? '',
          booking.operatorId ?? null,
          // The column knows two origins: a live booking ('teemail') and
          // history loaded from a spreadsheet ('imported'), which is kept out
          // of the payment ledger and the emails. A phone booking is live, so
          // it is the first; how it came in is in the note above.
          'teemail',
          req.user.username,
        ],
      );
      inserted = rows[0] ?? null;
    }
    if (!inserted) return res.status(500).json({ error: 'Could not issue a booking reference. Try again.' });

    res.status(201).json({ booking: await withAccount(serialiseBooking(inserted), club) });
  } catch (err) {
    next(err);
  }
});

/**
 * Change a booking's details: the date, the tee time, the party, the price,
 * and who it is with.
 *
 * Only what differs is written, so the audit stamp means somebody changed
 * something. A new party size is repriced at the price per player the booking
 * was taken at unless a total comes with it. The answer carries `warnings` --
 * a payment link out for the old amount, more paid than the new total -- for
 * the drawer to put in front of whoever made the change.
 */
router.patch('/:bookingId', async (req, res, next) => {
  try {
    const club = req.user.customerId;
    const { rows: found } = await query(
      `SELECT ${BOOKING_SELECT} FROM public.bookings WHERE booking_id = $1 AND club = $2`,
      [req.params.bookingId, club],
    );
    if (!found[0]) return res.status(404).json({ error: 'Booking not found' });
    const current = serialiseBooking(found[0]);

    const check = validateBookingEdit(req.body, current);
    if (!check.ok) return res.status(400).json({ error: check.errors.join('. '), errors: check.errors });

    const entries = Object.entries(check.changes);
    const audit = buildAuditSet(entries.length + 1, req.user.username);
    const sets = entries.map(([field], index) => `"${columnFor(field)}" = $${index + 1}`);
    const { rows } = await query(
      `UPDATE public.bookings
          SET ${[...sets, ...audit.clauses].join(', ')}
        WHERE booking_id = $${entries.length + audit.values.length + 1}
          AND club = $${entries.length + audit.values.length + 2}
      RETURNING ${BOOKING_SELECT}`,
      [...entries.map(([, value]) => value), ...audit.values, req.params.bookingId, club],
    );

    res.json({
      booking: await withAccount(serialiseBooking(rows[0]), club),
      changed: entries.map(([field]) => field),
      repriced: check.repriced,
      warnings: check.warnings,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:bookingId/status', async (req, res, next) => {
  const requested = req.body?.status;
  if (!ALLOWED_STATUSES.includes(requested)) {
    return res.status(400).json({ error: `Unknown status: ${requested}` });
  }
  // A retired spelling is stored as the status it stands for.
  const status = normaliseStatus(requested);

  try {
    const booking = await updateBookingField({
      column: 'status',
      value: status,
      bookingId: req.params.bookingId,
      club: req.user.customerId,
      username: req.user.username,
    });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    // The handover is not awaited: it is somebody else's endpoint, and the
    // user who just changed a status should not wait on it — nor see a save
    // that worked reported as a failure because it did not. The booking is
    // unstamped until the receiver accepts, so the sweep covers everything
    // this call does not (lib/booked-webhook-outbox.js).
    void handoverBookedCustomer(booking, { reason: `status by ${req.user.username}` });
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

/**
 * On the tee sheet, or not after all. A booking a payment booked waits as
 * 'to_enter' until somebody puts it on the club's tee sheet and says so here;
 * `entered: false` puts the flag back, for a mark made on the wrong booking.
 */
router.patch('/:bookingId/tee-sheet', async (req, res, next) => {
  const entered = req.body?.entered;
  if (typeof entered !== 'boolean') return res.status(400).json({ error: 'entered must be true or false' });
  try {
    const { rows } = await query(
      `UPDATE public.bookings
          SET tee_sheet_status = $1,
              tee_sheet_entered_at = CASE WHEN $1 = 'entered' THEN NOW() END,
              tee_sheet_entered_by = CASE WHEN $1 = 'entered' THEN $2 END,
              updated_at = NOW(), updated_by = $2
        WHERE booking_id = $3 AND club = $4
      RETURNING ${BOOKING_SELECT}`,
      [entered ? 'entered' : 'to_enter', req.user.username, req.params.bookingId, req.user.customerId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Booking not found' });
    res.json({ booking: await withAccount(serialiseBooking(rows[0]), req.user.customerId) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:bookingId/note', async (req, res, next) => {
  const { note } = req.body ?? {};
  if (typeof note !== 'string') {
    return res.status(400).json({ error: 'note must be a string' });
  }

  try {
    const booking = await updateBookingField({
      column: 'note',
      value: note,
      bookingId: req.params.bookingId,
      club: req.user.customerId,
      username: req.user.username,
    });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

router.patch('/:bookingId/tee-time', async (req, res, next) => {
  const { teeTime } = req.body ?? {};
  if (typeof teeTime !== 'string' || !teeTime.trim()) {
    return res.status(400).json({ error: 'teeTime is required' });
  }

  try {
    const booking = await updateBookingField({
      column: 'tee_time',
      value: teeTime.trim(),
      bookingId: req.params.bookingId,
      club: req.user.customerId,
      username: req.user.username,
    });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

// Deleting is permanent and leaves no trail, so it is an administrator's
// call; staff cancel instead, which keeps the row.
router.delete('/:bookingId', requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM public.bookings WHERE booking_id = $1 AND club = $2', [
      req.params.bookingId,
      req.user.customerId,
    ]);
    if (!rowCount) return res.status(404).json({ error: 'Booking not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Backfill tee_time from the stored email body for rows that never got one. */
router.post('/fix-tee-times', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT booking_id, note
         FROM public.bookings
        WHERE club = $1
          AND (tee_time IS NULL OR tee_time = 'Not Specified' OR tee_time = '')`,
      [req.user.customerId],
    );

    let updated = 0;
    for (const row of rows) {
      const teeTime = extractTeeTimeFromNote(row.note);
      if (!teeTime) continue;
      await query('UPDATE public.bookings SET tee_time = $1, updated_at = NOW() WHERE booking_id = $2 AND club = $3', [
        teeTime,
        row.booking_id,
        req.user.customerId,
      ]);
      updated += 1;
    }

    res.json({ updated, notFound: rows.length - updated });
  } catch (err) {
    next(err);
  }
});

const EXPORT_COLUMNS = [
  ['bookingId', 'Booking ID'],
  ['guestName', 'Lead Guest'],
  ['guestEmail', 'Guest Email'],
  ['contactPhone', 'Phone'],
  ['date', 'Tee Date'],
  ['teeTime', 'Tee Time'],
  ['players', 'Players'],
  ['total', `Total (${BRAND.currency})`],
  ['status', 'Status'],
  ['golfCourses', 'Golf Courses'],
  ['selectedTeeTimes', 'Selected Tee Times'],
  ['caddieRequirements', 'Caddies'],
  ['specialRequests', 'Special Requests'],
  ['hotelRequired', 'Accommodation Required'],
  ['hotelCheckin', 'Check-In'],
  ['hotelCheckout', 'Check-Out'],
  ['operatorName', 'Tour Operator'],
  ['paymentStatus', 'Payment Status'],
  ['amountPaid', 'Amount Paid'],
  ['outstanding', 'Outstanding'],
  ['dueDate', 'Payment Due'],
  ['daysOverdue', 'Days Overdue'],
  ['invoiceNumber', 'Invoice No.'],
  ['updatedBy', 'Updated By'],
  ['updatedAt', 'Updated At'],
];

router.get('/export', async (req, res, next) => {
  const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  try {
    const loaded = await loadBookingsWithAccounts(req.user.customerId);
    // The finance columns are flattened onto the row: a spreadsheet cannot
    // read a nested object, and this export is what goes to the bookkeeper.
    let bookings = loaded.bookings.map((booking) => ({
      ...booking,
      outstanding: booking.payment.outstanding,
      dueDate: booking.payment.dueDate,
      daysOverdue: booking.payment.daysOverdue || '',
    }));
    bookings = applyFilters(bookings, req.query);

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bookings_${stamp}.csv"`);
      return res.send(toCsv(bookings));
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Bookings');
    sheet.columns = EXPORT_COLUMNS.map(([key, header]) => ({ key, header, width: 20 }));
    sheet.getRow(1).font = { bold: true };
    const keys = EXPORT_COLUMNS.map(([key]) => key);
    bookings.forEach((booking) => sheet.addRow(defuseRow(booking, keys)));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="bookings_${stamp}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

/** Same status/date narrowing the dashboard applies, so an export matches the view. */
export function applyFilters(bookings, { statuses, from, to } = {}) {
  let result = bookings;

  if (statuses) {
    const wanted = new Set(String(statuses).split(',').filter(Boolean));
    if (wanted.size) result = result.filter((b) => wanted.has(b.status));
  }
  if (from) result = result.filter((b) => b.date && b.date >= from);
  if (to) result = result.filter((b) => b.date && b.date <= to);

  return result;
}

/** Every cell goes through lib/csv.js, which defuses spreadsheet formulas. */
export function toCsv(bookings) {
  const header = csvLine(EXPORT_COLUMNS.map(([, label]) => label));
  const lines = bookings.map((booking) => csvLine(EXPORT_COLUMNS.map(([key]) => booking[key])));
  return [header, ...lines].join('\n');
}

export default router;
