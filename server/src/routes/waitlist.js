/**
 * The waitlist: parties waiting for a time the club could not give them.
 *
 * The point of this route is the conversion link. When an entry becomes a
 * booking, both rows are written in one transaction and the waitlist row keeps
 * `converted_booking_id` — so "how much of our waitlist turns into play" is a
 * query rather than an exercise in parsing notes, which is what it used to be.
 */
import { Router } from 'express';
import { pool, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { serialiseBooking } from '../lib/bookings-domain.js';
import { BOOKING_SELECT } from '../lib/schema.js';
import {
  WAITLIST_STATUSES,
  buildWaitlistConversion,
  buildWaitlistDemand,
  mintWaitlistId,
  normaliseWaitlistStatus,
  serialiseWaitlistEntry,
  suggestConversions,
  validateWaitlistEntry,
} from '../lib/waitlist-domain.js';

const router = Router();
router.use(requireAuth);

/** Everything the page needs. */
router.get('/', async (req, res, next) => {
  try {
    const entries = await loadEntries(req.user.customerId);
    const bookings = await loadConvertedBookings(entries, req.user.customerId);
    // Conversions made outside the dashboard leave no link, so they are found
    // by looking rather than reported by the act that made them.
    const suggestions = suggestConversions(entries, await loadCandidateBookings(entries, req.user.customerId));

    res.json({
      entries,
      statuses: WAITLIST_STATUSES,
      conversion: buildWaitlistConversion(entries, bookings),
      demand: buildWaitlistDemand(entries),
      suggestions,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const check = validateWaitlistEntry(req.body);
    if (!check.ok) return res.status(400).json({ error: check.errors.join('. ') });

    const v = check.value;
    const { rows } = await query(
      `INSERT INTO public.waitlist
         (waitlist_id, guest_email, guest_name, requested_date, preferred_time,
          time_flexibility, players, golf_course, status, priority, notes, club)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Waiting', $9, $10, $11)
       RETURNING *`,
      [
        mintWaitlistId(),
        v.guestEmail,
        v.guestName,
        v.requestedDate,
        v.preferredTime,
        v.timeFlexibility,
        v.players,
        v.golfCourse,
        v.priority,
        v.notes,
        req.user.customerId,
      ],
    );

    res.status(201).json({ entry: serialiseWaitlistEntry(rows[0]) });
  } catch (err) {
    next(err);
  }
});

/** Status, priority, notes and the notification flag. */
router.patch('/:waitlistId', async (req, res, next) => {
  try {
    const entry = await findEntry(req.params.waitlistId, req.user.customerId);
    if (!entry) return res.status(404).json({ error: 'No such waitlist entry' });

    const sets = [];
    const values = [];
    const push = (column, value) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (req.body?.status !== undefined) {
      const status = normaliseWaitlistStatus(req.body.status);
      // Converted is not a label somebody types: it means a booking exists, and
      // is only ever set by the conversion below, which creates one.
      if (status === 'Converted') {
        return res.status(400).json({
          error: 'Use the convert action — marking an entry Converted has to create the booking it converted to',
        });
      }
      push('status', status);
    }
    if (req.body?.priority !== undefined) push('priority', Number(req.body.priority));
    if (req.body?.notes !== undefined) push('notes', String(req.body.notes));
    if (req.body?.notificationSent !== undefined) {
      push('notification_sent', Boolean(req.body.notificationSent));
      push('notification_sent_at', req.body.notificationSent ? new Date() : null);
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
    sets.push('updated_at = NOW()');

    values.push(entry.waitlist_id, req.user.customerId);
    const { rows } = await query(
      `UPDATE public.waitlist SET ${sets.join(', ')}
        WHERE waitlist_id = $${values.length - 1} AND club = $${values.length}
        RETURNING *`,
      values,
    );

    res.json({ entry: serialiseWaitlistEntry(rows[0]) });
  } catch (err) {
    next(err);
  }
});

/**
 * Convert an entry into a booking.
 *
 * Both writes go in one transaction: a booking without its link would be a
 * conversion the report cannot see, and a link without its booking would be a
 * conversion that never happened. Either half alone is worse than neither.
 */
router.post('/:waitlistId/convert', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const entry = await findEntry(req.params.waitlistId, req.user.customerId);
    if (!entry) return res.status(404).json({ error: 'No such waitlist entry' });
    if (entry.converted_booking_id) {
      return res.status(409).json({
        error: `That entry already became booking ${entry.converted_booking_id}`,
      });
    }

    const teeTime = String(req.body?.teeTime ?? '').trim();
    if (!teeTime) return res.status(400).json({ error: 'A tee time is required' });

    const date = String(req.body?.date ?? '').trim() || toDateOnly(entry.requested_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid date is required' });

    const total = Number(req.body?.total ?? 0);
    // Shaped like a booking, not like the waitlist entry it came from: the two
    // ids sit in adjacent columns and a shared prefix makes them unreadable.
    const bookingId = mintConvertedBookingId();

    await client.query('BEGIN');

    const { rows: bookingRows } = await client.query(
      `INSERT INTO public.bookings
         (booking_id, guest_email, guest_name, date, tee_time, players, total,
          status, note, club, golf_courses, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Booked', $8, $9, $10, NOW())
       RETURNING *`,
      [
        bookingId,
        entry.guest_email,
        entry.guest_name,
        date,
        teeTime,
        entry.players,
        Number.isFinite(total) ? total : 0,
        `Converted from waitlist ${entry.waitlist_id}.${entry.notes ? ` ${entry.notes}` : ''}`,
        req.user.customerId,
        entry.golf_course ?? '',
      ],
    );

    const { rows: entryRows } = await client.query(
      `UPDATE public.waitlist
          SET status = 'Converted', converted_booking_id = $1, converted_at = NOW(), updated_at = NOW()
        WHERE waitlist_id = $2 AND club = $3
        RETURNING *`,
      [bookingId, entry.waitlist_id, req.user.customerId],
    );

    await client.query('COMMIT');

    res.status(201).json({
      entry: serialiseWaitlistEntry(entryRows[0]),
      booking: serialiseBooking(bookingRows[0]),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

/**
 * Attach an existing booking to an entry — confirming a conversion that
 * happened outside the dashboard.
 *
 * Unlike the convert action this creates nothing: the booking is already
 * there, and somebody has decided it is the one this entry became.
 */
router.post('/:waitlistId/link', async (req, res, next) => {
  try {
    const entry = await findEntry(req.params.waitlistId, req.user.customerId);
    if (!entry) return res.status(404).json({ error: 'No such waitlist entry' });
    if (entry.converted_booking_id) {
      return res.status(409).json({
        error: `That entry already became booking ${entry.converted_booking_id}`,
      });
    }

    const bookingId = String(req.body?.bookingId ?? '').trim();
    if (!bookingId) return res.status(400).json({ error: 'A booking reference is required' });

    const { rows: bookingRows } = await query(
      `SELECT ${BOOKING_SELECT} FROM public.bookings WHERE booking_id = $1 AND club = $2`,
      [bookingId, req.user.customerId],
    );
    if (!bookingRows.length) return res.status(404).json({ error: 'No such booking at this club' });

    // One booking cannot be two entries' conversion, or the same play would be
    // counted twice in the rate and twice in the revenue.
    const { rows: taken } = await query(
      'SELECT waitlist_id FROM public.waitlist WHERE converted_booking_id = $1 AND club = $2',
      [bookingId, req.user.customerId],
    );
    if (taken.length) {
      return res.status(409).json({
        error: `Booking ${bookingId} is already recorded as the conversion of ${taken[0].waitlist_id}`,
      });
    }

    const { rows } = await query(
      `UPDATE public.waitlist
          SET status = 'Converted', converted_booking_id = $1, converted_at = NOW(), updated_at = NOW()
        WHERE waitlist_id = $2 AND club = $3
        RETURNING *`,
      [bookingId, entry.waitlist_id, req.user.customerId],
    );

    res.json({
      entry: serialiseWaitlistEntry(rows[0]),
      booking: serialiseBooking(bookingRows[0]),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:waitlistId', async (req, res, next) => {
  try {
    const entry = await findEntry(req.params.waitlistId, req.user.customerId);
    if (!entry) return res.status(404).json({ error: 'No such waitlist entry' });
    if (entry.converted_booking_id) {
      // Deleting it would erase a conversion the report has already counted.
      return res.status(409).json({
        error: 'That entry became a booking — it is the only record of that conversion and cannot be deleted',
      });
    }

    await query('DELETE FROM public.waitlist WHERE waitlist_id = $1 AND club = $2', [
      entry.waitlist_id,
      req.user.customerId,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---------- helpers ---------- */

async function loadEntries(club) {
  const { rows } = await query(
    `SELECT * FROM public.waitlist WHERE club = $1
      ORDER BY requested_date, priority DESC, created_at`,
    [club],
  );
  return rows.map(serialiseWaitlistEntry);
}

/** Only the bookings the waitlist actually points at, so conversions can be valued. */
async function loadConvertedBookings(entries, club) {
  const ids = entries.map((entry) => entry.convertedBookingId).filter(Boolean);
  if (!ids.length) return [];

  const { rows } = await query(
    `SELECT ${BOOKING_SELECT} FROM public.bookings
      WHERE club = $1 AND booking_id = ANY($2::text[])`,
    [club, ids],
  );
  return rows.map(serialiseBooking);
}

/**
 * Bookings that could be an unrecorded conversion: this club's, for a guest
 * who is on the list, around the dates they asked for. Narrowed in SQL so a
 * club with years of history does not load all of it to match a dozen entries.
 */
async function loadCandidateBookings(entries, club) {
  const open = entries.filter((entry) => entry.open && entry.guestEmail);
  if (!open.length) return [];

  const emails = [...new Set(open.map((entry) => entry.guestEmail))];
  const dates = open
    .map((entry) => entry.requestedDate)
    .filter(Boolean)
    .sort();
  if (!dates.length) return [];

  const { rows } = await query(
    `SELECT ${BOOKING_SELECT} FROM public.bookings
      WHERE club = $1
        AND LOWER(guest_email) = ANY($2::text[])
        AND date BETWEEN $3::date - 7 AND $4::date + 7`,
    [club, emails, dates[0], dates.at(-1)],
  );
  return rows.map(serialiseBooking);
}

async function findEntry(waitlistId, club) {
  const { rows } = await query('SELECT * FROM public.waitlist WHERE waitlist_id = $1 AND club = $2', [
    String(waitlistId),
    club,
  ]);
  return rows[0] ?? null;
}

/** `BOOK-20260923-8F2A` — the shape the Streamlit conversion used. */
function mintConvertedBookingId(now = new Date()) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .toUpperCase()
    .padStart(4, '0');
  return `BOOK-${stamp}-${suffix}`;
}

function toDateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const match = String(value ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

export default router;
