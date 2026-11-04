/**
 * A direct customer pays on the booking form, and the dashboard shows it.
 *
 * The email bot opens a Stripe Checkout with the booking's id and club in its
 * metadata; Stripe tells the dashboard's webhook (or the payment sync finds
 * it). What these guard, against a real Postgres: the payment is recorded,
 * the booking goes straight to Booked, and -- because nobody at the club has
 * touched it -- it is flagged to go on the tee sheet, until somebody marks it
 * done. A booking the club had already confirmed is not flagged: they put it
 * on the sheet when they confirmed it.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createScratchDatabase, skip } from './helpers.js';

describe('paid on the booking form', { skip }, () => {
  let db;
  let client;
  let recordStripePayment;

  /** A paid Checkout from the bot's booking form, as Stripe sends it. */
  const session = (bookingId, amountCents, id = `cs_${bookingId}`) => ({
    id,
    object: 'checkout.session',
    payment_status: 'paid',
    amount_total: amountCents,
    currency: 'eur',
    payment_intent: `pi_${id}`,
    client_reference_id: bookingId,
    metadata: { booking_id: bookingId, club: 'baltray', source: 'booking_form' },
  });

  const row = async (bookingId) =>
    (
      await client.query(
        `SELECT status, payment_status, amount_paid, tee_sheet_status, booked_at, stripe_paid_at
           FROM public.bookings WHERE booking_id = $1`,
        [bookingId],
      )
    ).rows[0];

  before(async () => {
    db = await createScratchDatabase('paid_online');
    process.env.DATABASE_URL = db.url;
    const { migrate } = await import('../../src/db/migrate.js');
    await migrate({ connectionString: db.url });
    ({ recordStripePayment } = await import('../../src/lib/record-payment.js'));
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    await client.query(
      `INSERT INTO public.bookings (booking_id, club, guest_email, guest_name, date, tee_time, players, total, status)
       VALUES ('FORM-1', 'baltray', 'anne.kelly@example.com', 'Anne Kelly', CURRENT_DATE + 200, '09:40', 4, 1540, 'Requested'),
              ('DESK-1', 'baltray', 'groups@tours.test', 'Group', CURRENT_DATE + 200, '10:20', 8, 2600, 'Booked')`,
    );
  });

  after(async () => {
    await client?.end();
    const { pool } = await import('../../src/db.js');
    await pool.end();
    await db?.drop();
  });

  test('the payment books it, marks it paid, and flags it for the tee sheet', async () => {
    const recorded = await recordStripePayment(session('FORM-1', 154000));
    assert.match(recorded.result, /Paid \(booking Booked\).*flagged for the tee sheet/);
    assert.equal(recorded.booking.teeSheetStatus, 'to_enter');

    const after = await row('FORM-1');
    assert.equal(after.status, 'Booked', 'straight to Booked');
    assert.equal(after.payment_status, 'Paid');
    assert.equal(Number(after.amount_paid), 1540);
    assert.equal(after.tee_sheet_status, 'to_enter');
    assert.ok(after.booked_at, 'stamped as booked, so the arrival emails count from now');
    assert.ok(after.stripe_paid_at);
  });

  test('the same payment told twice is counted once, and flagged once', async () => {
    const again = await recordStripePayment(session('FORM-1', 154000));
    assert.equal(again.result, 'already recorded');
    assert.equal(Number((await row('FORM-1')).amount_paid), 1540);
  });

  test('marked on the sheet, a later payment does not flag it again', async () => {
    await client.query(
      "UPDATE public.bookings SET tee_sheet_status = 'entered', tee_sheet_entered_by = 'desk' WHERE booking_id = 'FORM-1'",
    );
    // A second, separate payment -- an extra player, say.
    await client.query("UPDATE public.bookings SET total = 1925 WHERE booking_id = 'FORM-1'");
    const extra = await recordStripePayment(session('FORM-1', 38500, 'cs_extra'));
    assert.doesNotMatch(extra.result, /tee sheet/);
    assert.equal((await row('FORM-1')).tee_sheet_status, 'entered');
  });

  test('a booking the club had already confirmed is paid, not flagged', async () => {
    const recorded = await recordStripePayment(session('DESK-1', 78000));
    assert.doesNotMatch(recorded.result, /tee sheet/);
    const after = await row('DESK-1');
    assert.equal(after.payment_status, 'Deposit paid');
    assert.equal(after.tee_sheet_status, null);
  });
});
