/**
 * When a booking became Booked (migration 0025).
 *
 * The deposit is due within the club's invoice terms of the booking being
 * confirmed, so the date it was confirmed has to be on the record. No column
 * held it: customer_confirmed_at is empty on all 539 of County Louth's booked
 * rounds, and updated_at is last-touched-by-anything — 442 of those carry the
 * day the database was moved to Supabase.
 *
 * It is stamped by a trigger rather than by the dashboard because the status
 * is also set by the email bot and by imports, and all of them have to be
 * right. These are that trigger against a real Postgres, because all of it is
 * SQL.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { createScratchDatabase, skip } from './helpers.js';

describe('when a booking was booked', { skip }, () => {
  let db;
  let client;
  let next = 0;

  /** A booking written straight in, as the bot or an import writes one. */
  async function insert(status) {
    next += 1;
    const bookingId = `BA-${next}`;
    await client.query(
      `INSERT INTO public.bookings (booking_id, club, guest_email, date, players, total, status)
       VALUES ($1, 'baltray', 'groups@tours.test', CURRENT_DATE + 300, 4, 1000, $2)`,
      [bookingId, status],
    );
    return bookingId;
  }

  const bookedAt = async (bookingId) => {
    const { rows } = await client.query('SELECT booked_at FROM public.bookings WHERE booking_id = $1', [bookingId]);
    return rows[0].booked_at;
  };

  const setStatus = (bookingId, status) =>
    client.query('UPDATE public.bookings SET status = $2 WHERE booking_id = $1', [bookingId, status]);

  before(async () => {
    db = await createScratchDatabase('booked_at');
    await migrate({ connectionString: db.url });
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
  });

  after(async () => {
    await client?.end();
    await db?.drop();
  });

  test('an enquiry that becomes Booked is stamped when it does', async () => {
    const bookingId = await insert('Inquiry');
    assert.equal(await bookedAt(bookingId), null, 'an enquiry has not been booked');

    await setStatus(bookingId, 'Booked');
    assert.ok(await bookedAt(bookingId), 'stamped on the way in');
  });

  test('the stamp is the first time it was booked, not the last time it was touched', async () => {
    // The club edits the note, moves it to Requested and back, raises the
    // price. None of that is the day it was booked.
    const bookingId = await insert('Inquiry');
    await setStatus(bookingId, 'Booked');
    const first = await bookedAt(bookingId);

    await client.query(`UPDATE public.bookings SET note = 'rang them' WHERE booking_id = $1`, [bookingId]);
    assert.deepEqual(await bookedAt(bookingId), first, 'an edit is not a booking');

    await setStatus(bookingId, 'Requested');
    await setStatus(bookingId, 'Booked');
    assert.deepEqual(await bookedAt(bookingId), first, 'and nor is being re-confirmed');
  });

  test('a booking written already Booked is not stamped, because its own timestamp is the moment', async () => {
    // The bot writing a confirmed booking, or a tee sheet loaded in. Stamping
    // NOW() here would date a year of history to the afternoon it was loaded;
    // the row's timestamp already says when it arrived.
    const bookingId = await insert('Booked');
    assert.equal(await bookedAt(bookingId), null);
  });

  test('Confirmed is the retired spelling of Booked, not a booking being made', async () => {
    const bookingId = await insert('Inquiry');
    await setStatus(bookingId, 'Confirmed');
    const first = await bookedAt(bookingId);
    assert.ok(first, 'the old spelling counts as booked');

    await setStatus(bookingId, 'Booked');
    assert.deepEqual(await bookedAt(bookingId), first, 'spelling it the new way is not a second booking');
  });

  test('a cancellation leaves the record of when it had been booked', async () => {
    const bookingId = await insert('Inquiry');
    await setStatus(bookingId, 'Booked');
    const first = await bookedAt(bookingId);

    await setStatus(bookingId, 'Cancelled');
    assert.deepEqual(await bookedAt(bookingId), first, 'it was booked, and then it was cancelled');
  });

  test('a stamp set deliberately is left alone', async () => {
    // An import that knows when the round was sold can say so.
    const bookingId = await insert('Inquiry');
    await client.query(
      `UPDATE public.bookings SET status = 'Booked', booked_at = TIMESTAMPTZ '2025-03-04 09:00:00+00'
        WHERE booking_id = $1`,
      [bookingId],
    );
    assert.equal((await bookedAt(bookingId)).toISOString(), '2025-03-04T09:00:00.000Z');
  });
});
