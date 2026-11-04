/**
 * One pass of the booking trigger workflow, end to end against a real Postgres
 * with SendGrid stubbed at `fetch`.
 *
 * The rules are tested as pure functions in `booking-triggers-domain.test.js`
 * and the ledger's uniqueness in `booking-trigger-ledger.test.js`. What is left
 * is the part that is only true when the pieces are joined up, and it is the
 * part that would do the damage:
 *
 *   - a dry run sends nothing at all;
 *   - a real run sends exactly one email per booking and stamps it, so the
 *     next pass the same day does nothing;
 *   - the rungs a booking has outrun are recorded rather than left to fire a
 *     day late as a warning about a deadline that has already expired;
 *   - a cancellation does not happen without the switch for it, and does when
 *     it is set — and even then the booking is cancelled, never deleted.
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createScratchDatabase, skip } from './helpers.js';

let db;
let pool;
let query;
let runTriggers;
let planClub;

/** Every SendGrid payload the run posted. */
let posted = [];
let realFetch;

/** The environment a run is given, so each test can vary one switch. */
function env(over = {}) {
  return {
    TRIGGER_WORKFLOW: 'true',
    SENDGRID_API_KEY: 'SG.test',
    FROM_EMAIL: 'golf@club.test',
    // Without this nothing is in the payment ledger, no booking has a balance,
    // and the whole chase ladder is silent. See docs/BOOKING_TRIGGERS.md.
    PAYMENTS_TRACKED_FROM: 'all',
    ...over,
  };
}

/**
 * A booked booking confirmed `daysAgo` days ago.
 *
 * `paid` also sets `pre_play_clock_started_at`, because that is what the real
 * system does: the dashboard stamps it when staff record a payment and
 * `record-payment.js` stamps it when Stripe reports one. A paid booking without
 * it is one whose payment predates the column, and it behaves differently --
 * see the test for it below.
 */
async function booking(
  bookingId,
  { daysAgo = 5, total = 1200, paid = 0, paidDaysAgo = 0, status = 'Booked', playsIn = 120, clock = true } = {},
) {
  const confirmed = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const paidAt = paid > 0 && clock ? new Date(Date.now() - paidDaysAgo * 86_400_000).toISOString() : null;
  await query(
    `INSERT INTO public.bookings
       (booking_id, club, guest_email, guest_name, date, tee_time, players, total,
        status, payment_status, amount_paid, timestamp, booked_at, golf_courses,
        pre_play_clock_started_at)
     VALUES ($1, 'club_a', $2, 'Ann Burke', CURRENT_DATE + $3::int, '10:20', 4, $4,
             $5, $6, $7, $8::timestamp, $8::timestamptz, 'Championship Course', $9::timestamptz)`,
    [
      bookingId,
      `${bookingId.toLowerCase()}@guest.test`,
      playsIn,
      total,
      status,
      paid > 0 ? (paid >= total ? 'Paid' : 'Deposit paid') : 'Unpaid',
      paid,
      confirmed,
      paidAt,
    ],
  );
  return bookingId;
}

const ledgerFor = async (bookingId) => {
  const { rows } = await query(
    `SELECT step, outcome FROM public.booking_trigger_sends
      WHERE booking_id = $1 ORDER BY id`,
    [bookingId],
  );
  return rows;
};

/** Settle every rung before the lapse, so the lapse is what falls due next. */
async function settle(bookingId) {
  for (const step of [
    'deposit_request',
    'deposit_reminder',
    'deposit_final_notice',
    'deposit_overdue',
    'deposit_rescue_48h',
    'deposit_rescue_24h',
  ]) {
    await query(
      `INSERT INTO public.booking_trigger_sends (club, booking_id, step, outcome)
       VALUES ('club_a', $1, $2, 'sent')`,
      [bookingId, step],
    );
  }
}

const dayFromNow = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const statusOf = async (bookingId) => {
  const { rows } = await query('SELECT status FROM public.bookings WHERE booking_id = $1', [bookingId]);
  return rows[0]?.status ?? null;
};

describe('one pass of the booking trigger workflow', { skip }, () => {
  before(async () => {
    db = await createScratchDatabase('trigger_run');
    Object.assign(process.env, { DATABASE_URL: db.url, NODE_ENV: 'test' });
    delete process.env.STRIPE_SECRET_KEY;

    ({ pool, query } = await import('../../src/db.js'));
    ({ runTriggers, planClub } = await import('../../src/lib/booking-trigger-runner.js'));
    const { migrate } = await import('../../src/db/migrate.js');
    await migrate({ pool });

    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('sendgrid')) {
        posted.push(JSON.parse(init.body));
        return new Response('', { status: 202 });
      }
      return realFetch(url, init);
    };
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await pool?.end();
    await db?.drop();
  });

  beforeEach(async () => {
    posted = [];
    await query('TRUNCATE public.booking_trigger_sends');
    await query('TRUNCATE public.bookings CASCADE');
    await query('TRUNCATE public.email_messages CASCADE');
  });

  test('a dry run reports what it would send and sends nothing', async () => {
    await booking('DRY-1');
    const run = await runTriggers({ club: 'club_a', dryRun: true, sentBy: 'tester', env: env() });

    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].status, 'would_send');
    assert.equal(run.results[0].step, 'deposit_reminder');
    assert.equal(posted.length, 0, 'nothing was posted to SendGrid');
    assert.deepEqual(await ledgerFor('DRY-1'), [], 'and nothing was written down');
  });

  test('a real run sends one email, records it, and does nothing on the next pass', async () => {
    await booking('RUN-1');

    const first = await runTriggers({ club: 'club_a', sentBy: 'tester', env: env() });
    assert.equal(first.sent, 1);
    assert.equal(first.failed, 0);
    assert.equal(posted.length, 1);
    assert.match(posted[0].subject, /Reminder: payment due for booking RUN-1/);
    assert.deepEqual(posted[0].personalizations[0].to, [{ email: 'run-1@guest.test' }]);
    assert.deepEqual(await ledgerFor('RUN-1'), [{ step: 'deposit_reminder', outcome: 'sent' }]);

    const second = await runTriggers({ club: 'club_a', sentBy: 'tester', env: env() });
    assert.equal(second.sent, 0);
    assert.equal(second.results.length, 0);
    assert.equal(posted.length, 1, 'the guest was not written to twice');
  });

  test('the email is written onto the booking’s own conversation', async () => {
    await booking('LOG-1');
    await runTriggers({ club: 'club_a', sentBy: 'tester', env: env() });

    const { rows } = await query(
      `SELECT kind, direction, to_email, sent_by FROM public.email_messages WHERE booking_id = 'LOG-1'`,
    );
    assert.deepEqual(rows, [
      { kind: 'trigger_deposit_reminder', direction: 'outbound', to_email: 'log-1@guest.test', sent_by: 'tester' },
    ]);
  });

  test('a booking that has outrun its ladder gets the latest rung, and the rest are recorded', async () => {
    // Booked 8 days ago: days 5, 6, 7 and 8 are all inside the catch-up
    // horizon, and a guest must not receive four emails in one minute.
    await booking('LATE-1', { daysAgo: 8 });
    const run = await runTriggers({ club: 'club_a', sentBy: 'tester', env: env() });

    assert.equal(posted.length, 1);
    assert.match(posted[0].subject, /48 hours to save booking LATE-1/);
    assert.equal(run.sent, 1);
    assert.equal(run.skipped, 3);
    assert.deepEqual(await ledgerFor('LATE-1'), [
      { step: 'deposit_reminder', outcome: 'superseded' },
      { step: 'deposit_final_notice', outcome: 'superseded' },
      { step: 'deposit_overdue', outcome: 'superseded' },
      { step: 'deposit_rescue_48h', outcome: 'sent' },
    ]);
  });

  test('a lapsed booking is left for a person unless the switch is set', async () => {
    await booking('HOLD-1', { daysAgo: 10 });
    await settle('HOLD-1');

    const run = await runTriggers({ club: 'club_a', sentBy: 'tester', env: env() });
    assert.equal(run.needsReview, 1);
    assert.equal(run.cancelled, 0);
    assert.equal(posted.length, 0, 'no cancellation email, because nothing was cancelled');
    assert.equal(await statusOf('HOLD-1'), 'Booked');
    assert.deepEqual(
      (await ledgerFor('HOLD-1')).filter((row) => row.step === 'deposit_lapsed'),
      [],
      'and it stays on the list until somebody deals with it',
    );
  });

  test('with the switch set, the booking is cancelled and told so — but never deleted', async () => {
    await booking('GONE-1', { daysAgo: 10 });
    await settle('GONE-1');

    const run = await runTriggers({
      club: 'club_a',
      sentBy: 'tester',
      env: env({ TRIGGER_WORKFLOW_AUTO_CANCEL: 'true' }),
    });
    assert.equal(run.cancelled, 1);
    assert.equal(posted.length, 1);
    assert.match(posted[0].subject, /Booking GONE-1 has been cancelled/);
    assert.equal(await statusOf('GONE-1'), 'Cancelled');
    assert.deepEqual(await ledgerFor('GONE-1').then((rows) => rows.at(-1)), {
      step: 'deposit_lapsed',
      outcome: 'cancelled',
    });

    // The row is the evidence behind the cancellation; it carries the money,
    // the correspondence and the audit trail.
    const { rows } = await query(`SELECT note FROM public.bookings WHERE booking_id = 'GONE-1'`);
    assert.equal(rows.length, 1);
    assert.match(rows[0].note, /Cancelled by the booking trigger workflow \(deposit_lapsed\)/);
  });

  test('a booking carrying the retired Confirmed spelling is cancelled, not just told it was', async () => {
    // `normaliseStatus` reads 'Confirmed' as Booked, so such a row is on the
    // ladder. If the cancel only matched 'Booked' the guest would be emailed
    // "your booking has been cancelled" about a booking still on the sheet.
    await booking('LEGACY-1', { daysAgo: 10 });
    await query(`UPDATE public.bookings SET status = 'Confirmed' WHERE booking_id = 'LEGACY-1'`);
    await settle('LEGACY-1');

    const run = await runTriggers({
      club: 'club_a',
      sentBy: 'tester',
      env: env({ TRIGGER_WORKFLOW_AUTO_CANCEL: 'true' }),
    });

    assert.equal(run.cancelled, 1);
    assert.equal(await statusOf('LEGACY-1'), 'Cancelled');
    assert.match(posted[0].subject, /has been cancelled/);
  });

  test('a booking that has paid is thanked rather than chased', async () => {
    // Confirmed 8 days ago and paid today: by the chase ladder it would be two
    // rungs from cancellation, and instead it gets its receipt.
    await booking('PAID-1', { daysAgo: 8, paid: 1200 });
    const run = await runTriggers({ club: 'club_a', sentBy: 'tester', env: env() });

    assert.equal(run.sent, 1);
    assert.equal(run.results[0].step, 'deposit_receipt');
    assert.match(posted[0].subject, /Payment received/);
  });

  test('a payment of unknown age earns no receipt, because it may be a year old', async () => {
    // A booking paid before pre_play_clock_started_at existed. There is no
    // record of when the money came in, so the receipt dates to the booking
    // and falls outside the catch-up horizon -- which is right: "thank you for
    // your payment" about a payment nobody can date is worse than silence.
    await booking('OLDPAID-1', { daysAgo: 40, paid: 1200, clock: false });
    const plan = await planClub('club_a', { scope: 'all', env: env() });
    const theirs = plan.plans.find((entry) => entry.bookingId === 'OLDPAID-1');
    const receipt = theirs.steps.find((entry) => entry.step === 'deposit_receipt');

    assert.equal(receipt.state, 'missed');
    const run = await runTriggers({ club: 'club_a', sentBy: 'tester', env: env() });
    assert.equal(run.sent, 0);
    assert.equal(posted.length, 0);
  });

  test('a booking with no guest address is reported, not emailed into the void', async () => {
    await booking('NOMAIL-1');
    await query(`UPDATE public.bookings SET guest_email = NULL WHERE booking_id = 'NOMAIL-1'`);

    const plan = await planClub('club_a', { scope: 'all', env: env() });
    const theirs = plan.plans.find((entry) => entry.bookingId === 'NOMAIL-1');
    assert.equal(theirs.blocker, 'No guest email address');

    const run = await runTriggers({ club: 'club_a', sentBy: 'tester', env: env() });
    assert.equal(run.sent, 0);
    assert.equal(posted.length, 0);
  });

  test('a switched-off workflow does nothing at all', async () => {
    await booking('OFF-1');
    const run = await runTriggers({ club: 'club_a', sentBy: 'tester', env: env({ TRIGGER_WORKFLOW: '' }) });

    assert.match(run.skippedRun, /switched off for this club/);
    assert.equal(posted.length, 0);
    assert.deepEqual(await ledgerFor('OFF-1'), []);

    const locked = await runTriggers({ club: 'club_a', sentBy: 'tester', env: env({ TRIGGER_WORKFLOW: 'false' }) });
    assert.match(locked.skippedRun, /TRIGGER_WORKFLOW is set to false/);
    assert.equal(posted.length, 0);
  });

  test("the club's own settings decide, over the environment", async () => {
    await booking('SETTINGS-1', { daysAgo: 5 });
    await query(
      `INSERT INTO public.club_settings (club, trigger_settings) VALUES ('club_a', $1::jsonb)
       ON CONFLICT (club) DO UPDATE SET trigger_settings = EXCLUDED.trigger_settings`,
      [JSON.stringify({ enabled: true, depositReminderDay: 4 })],
    );
    try {
      // The environment has it off; the club switched it on and moved the
      // reminder to day 4, so a 5-day-old booking is past it.
      const plan = await planClub('club_a', { scope: 'all', env: env({ TRIGGER_WORKFLOW: '' }) });
      assert.equal(plan.config.enabled, true);
      assert.equal(plan.config.schedule.depositReminderDay, 4);
      const theirs = plan.plans.find((entry) => entry.bookingId === 'SETTINGS-1');
      assert.equal(theirs.steps.find((entry) => entry.step === 'deposit_reminder').dueOn, dayFromNow(-1));

      const run = await runTriggers({ club: 'club_a', sentBy: 'tester', env: env({ TRIGGER_WORKFLOW: '' }) });
      assert.equal(run.skippedRun, undefined);
      assert.ok(run.sent >= 1);
    } finally {
      await query(`DELETE FROM public.club_settings WHERE club = 'club_a'`);
    }
  });

  test('a trade booking is chased at the account, not the guest', async () => {
    await booking('TRADE-1', { daysAgo: 5 });
    // Net 7, the same window the club gives a visitor, so this test is about
    // WHO is chased rather than when. An account on other terms is chased by
    // them -- see the test below.
    const { rows } = await query(
      `INSERT INTO public.tour_operators (club, name, contact_email, email_domains, payment_terms_days)
       VALUES ('club_a', 'Carr Golf', 'accounts@carrgolf.test', ARRAY['guest.test'], 7) RETURNING id`,
    );
    try {
      await query(`UPDATE public.bookings SET tour_operator_id = $1 WHERE booking_id = 'TRADE-1'`, [rows[0].id]);
      const run = await runTriggers({ club: 'club_a', bookingIds: ['TRADE-1'], sentBy: 'tester', env: env() });
      assert.equal(run.sent, 1);
      assert.equal(run.results[0].email, 'accounts@carrgolf.test');
      assert.equal(posted.at(-1).personalizations[0].to[0].email, 'accounts@carrgolf.test');

      // Switched off on the account, the next rung is not this account's.
      await query(`UPDATE public.tour_operators SET auto_chase = FALSE WHERE id = $1`, [rows[0].id]);
      const plan = await planClub('club_a', { scope: 'all', env: env() });
      const theirs = plan.plans.find((entry) => entry.bookingId === 'TRADE-1');
      assert.equal(theirs.chased, false);
      assert.equal(theirs.next, null);
    } finally {
      await query(`UPDATE public.bookings SET tour_operator_id = NULL WHERE booking_id = 'TRADE-1'`);
      await query(`DELETE FROM public.tour_operators WHERE id = $1`, [rows[0].id]);
    }
  });

  test('without a payment ledger the chase is silent, and says nothing is due', async () => {
    await booking('UNTRACKED-1');
    const plan = await planClub('club_a', { scope: 'due', env: env({ PAYMENTS_TRACKED_FROM: '' }) });

    assert.equal(plan.paymentsTracked, false);
    assert.equal(plan.outsideLedger, 1, 'counted, so the page can name the setting');
    assert.equal(plan.plans.length, 0);
  });

  test('a run only ever touches its own club', async () => {
    await booking('MINE-1');
    await booking('THEIRS-1');
    await query(`UPDATE public.bookings SET club = 'club_b' WHERE booking_id = 'THEIRS-1'`);

    const run = await runTriggers({ club: 'club_a', sentBy: 'tester', env: env() });
    assert.equal(run.sent, 1);
    assert.deepEqual(
      run.results.map((line) => line.bookingId),
      ['MINE-1'],
    );
    assert.deepEqual(await ledgerFor('THEIRS-1'), []);
  });

  test('a named selection runs only those bookings', async () => {
    await booking('PICK-1');
    await booking('PICK-2');

    const run = await runTriggers({ club: 'club_a', bookingIds: ['PICK-2'], sentBy: 'tester', env: env() });
    assert.equal(run.sent, 1);
    assert.deepEqual(await ledgerFor('PICK-1'), []);
    assert.deepEqual(await ledgerFor('PICK-2'), [{ step: 'deposit_reminder', outcome: 'sent' }]);
  });

  test('a refused send is recorded as failed and tried again next time', async () => {
    await booking('FAIL-1');
    const working = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('sendgrid'))
        return new Response('{"errors":[{"message":"bad address"}]}', { status: 400 });
      return realFetch(url, init);
    };

    const first = await runTriggers({ club: 'club_a', sentBy: 'tester', env: env() });
    assert.equal(first.failed, 1);
    assert.deepEqual(await ledgerFor('FAIL-1'), [{ step: 'deposit_reminder', outcome: 'failed' }]);

    globalThis.fetch = working;
    const second = await runTriggers({ club: 'club_a', sentBy: 'tester', env: env() });
    assert.equal(second.sent, 1, 'the rung was not settled by the failure');
    assert.deepEqual(await ledgerFor('FAIL-1'), [
      { step: 'deposit_reminder', outcome: 'failed' },
      { step: 'deposit_reminder', outcome: 'sent' },
    ]);
  });
});
