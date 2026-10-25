/**
 * Running the booking lifecycle ladder: the part that reads the database,
 * sends the email and writes the ledger.
 *
 * The rules are next door in `booking-triggers-domain.js` and are pure. This
 * file is deliberately dull by comparison — it decides nothing about which
 * rung is due, it only carries out what the rules return, in an order chosen
 * so that a crash anywhere leaves the ledger honest:
 *
 *   1. stamp the anchor, so the clock cannot start twice
 *   2. write the ledger row, claiming the rung
 *   3. send
 *   4. cancel the booking, where the rung cancels and a club has allowed it
 *
 * The claim comes before the send because the unique index is the only real
 * guarantee against emailing a guest twice, and a claim that turns out not to
 * have sent is recoverable — it is recorded as failed and tried again — while
 * a second cancellation notice is not.
 */
import { query } from '../db.js';
import { logger } from './logger.js';
import { serialiseBooking } from './bookings-domain.js';
import { BOOKING_SELECT, OPERATOR_SELECT } from './schema.js';
import { buildOperatorIndex, identify, serialiseOperator } from './operators-domain.js';
import { buildTemplateData, getCampaign, readEmailConfig } from './email-domain.js';
import { sendTemplateEmail } from './sendgrid.js';
import {
  evaluateLadder,
  ladderToday,
  planForBooking,
  readTriggerConfig,
  sendableLadder,
} from './booking-triggers-domain.js';

const log = logger.child('booking-triggers');

/**
 * Statuses the ladder takes an interest in.
 *
 * `Requested` is in because a deposit request is exactly what a booking at
 * that stage is waiting for, and a payment advances it to `Booked` anyway
 * (see ADVANCES_ON_PAYMENT in payment-link-domain.js). `Cancelled` and
 * `Rejected` are out, and a booking the ladder cancels therefore leaves it.
 */
export const ELIGIBLE_STATUSES = ['Requested', 'Booked'];

/** One run at a time in this process, however often it is asked for. */
let running = null;

/** The last run, for the route and for the log at boot. */
let lastRun = null;

export function lastTriggerRun() {
  return lastRun;
}

/**
 * The SendGrid template for one rung.
 *
 * A rung that maps onto an existing campaign uses that campaign's template, so
 * the confirmation email a club has already written and tested is the one the
 * ladder sends. Everything else looks for its own, then a single fallback
 * template for a club that would rather write one email with a wide merge
 * field than sixteen.
 */
export function templateFor(rung, env = process.env) {
  if (rung.campaign) {
    const campaign = getCampaign(rung.campaign);
    if (campaign && env[campaign.templateEnv]) return env[campaign.templateEnv];
  }
  return env[`SENDGRID_TEMPLATE_${rung.key.toUpperCase()}`] || env.SENDGRID_TEMPLATE_LIFECYCLE || null;
}

/**
 * Run the ladder once.
 *
 * Resolves to a summary rather than throwing: this is called from a schedule
 * and from a route, and one booking whose email fails must not abandon the
 * rest of the run.
 */
export async function runBookingTriggers({
  reason = 'schedule',
  env = process.env,
  now = new Date(),
  dryRun = false,
} = {}) {
  const config = readTriggerConfig(env);
  if (!config.enabled) return { skipped: 'not enabled' };

  if (running) return running;
  running = execute({ reason, env, now, dryRun, config }).finally(() => {
    running = null;
  });
  return running;
}

async function execute({ reason, env, now, dryRun, config }) {
  const today = ladderToday(now);
  const email = readEmailConfig(env);
  const ladder = sendableLadder(config);

  const result = {
    reason,
    today,
    dryRun,
    startedAt: new Date().toISOString(),
    considered: 0,
    sent: 0,
    held: 0,
    failed: 0,
    superseded: 0,
    skipped: 0,
    cancelled: 0,
    unconfigured: [],
    actions: [],
    finishedAt: null,
  };

  try {
    const { rows } = await query(
      `SELECT ${BOOKING_SELECT} FROM public.bookings
        WHERE status = ANY($1)
        ORDER BY date NULLS LAST, booking_id
        LIMIT $2`,
      [ELIGIBLE_STATUSES, config.batch],
    );

    const operatorsByClub = new Map();
    for (const row of rows) {
      const booking = serialiseBooking(row);
      result.considered += 1;
      try {
        const operators = await loadOperators(booking.club, operatorsByClub);
        const { operator } = identify(booking, buildOperatorIndex(operators));

        const lifecycleStartedOn = await ensureLifecycleAnchor(booking, { today, dryRun });
        const already = await settledRungs(booking);
        const paidOn = paymentDay(booking);

        const evaluated = evaluateLadder({
          booking,
          operator,
          ladder,
          today,
          lifecycleStartedOn,
          paidOn,
          already,
          catchUpDays: config.catchUpDays,
          ladderConfig: config.ladder,
        });

        const plan = planForBooking(evaluated.map((entry) => withLegacyStamp(entry, booking)));

        await writeOff(booking, plan, { result, dryRun });

        if (plan.send) {
          await act(booking, plan.send, { config, email, env, result, dryRun, today });
        }
      } catch (err) {
        result.failed += 1;
        log.warn(`${booking.bookingId}: ${err.message}`);
      }
    }

    if (result.sent || result.held || result.failed || result.cancelled) {
      log.info(
        `run (${reason}${dryRun ? ', dry run' : ''}): ${result.considered} considered, ${result.sent} sent, ` +
          `${result.held} held, ${result.cancelled} cancelled, ${result.failed} failed`,
      );
    }
    return result;
  } catch (err) {
    result.error = err.message;
    log.error(`run (${reason}) failed: ${err.message}`);
    return result;
  } finally {
    result.finishedAt = new Date().toISOString();
    lastRun = result;
  }
}

/**
 * A rung whose email the existing campaigns have already sent counts as
 * settled.
 *
 * The confirmation and the post-play thank you exist twice over: as rungs of
 * this ladder, and as the Guest Emails campaigns a club has been sending by
 * hand for a year, each with its own stamp on the booking. The ledger's unique
 * index cannot see those stamps, so without this a club that switches the
 * ladder on would thank every guest twice. Read here, and written back in
 * `act`, so the two mechanisms share one answer to "has this gone out?".
 */
function withLegacyStamp(entry, booking) {
  if (entry.state === 'settled' || !entry.rung.campaign) return entry;
  const campaign = getCampaign(entry.rung.campaign);
  if (!campaign || !booking[campaign.field]) return entry;
  return {
    ...entry,
    state: 'settled',
    settled: { outcome: 'sent', detail: `already sent as the ${campaign.label} campaign`, legacy: true },
  };
}

/**
 * Stamp the day the ladder started caring about this booking.
 *
 * Every payment-phase rung is measured from here, so it must be written once
 * and never moved. A booking that already had a payment link sent by hand is
 * anchored on that instead: the link is the day-0 rung, and a club that sent
 * one last Tuesday should be five days into the ladder, not starting it now.
 */
async function ensureLifecycleAnchor(booking, { today, dryRun }) {
  if (booking.lifecycleStartedAt) return booking.lifecycleStartedAt.slice(0, 10);
  if (booking.paymentLinkSentAt) return booking.paymentLinkSentAt.slice(0, 10);
  if (dryRun) return today;

  // COALESCE so two runs racing cannot move an anchor that is already set.
  const { rows } = await query(
    `UPDATE public.bookings
        SET lifecycle_started_at = COALESCE(lifecycle_started_at, NOW())
      WHERE booking_id = $1 AND club = $2
    RETURNING lifecycle_started_at`,
    [booking.bookingId, booking.club],
  );
  const stamped = rows[0]?.lifecycle_started_at;
  return stamped ? new Date(stamped).toISOString().slice(0, 10) : today;
}

/** The day the money arrived, for the receipt rung. */
function paymentDay(booking) {
  const stamp = booking.stripePaidAt ?? booking.prePlayClockStartedAt ?? null;
  return stamp ? stamp.slice(0, 10) : null;
}

/** Every rung this booking has already settled, from the ledger. */
async function settledRungs(booking) {
  const { rows } = await query(
    `SELECT rung, outcome, detail FROM public.booking_trigger_sends
      WHERE club = $1 AND booking_id = $2 AND outcome <> 'failed'`,
    [booking.club, booking.bookingId],
  );
  return new Map(rows.map((row) => [row.rung, row]));
}

/**
 * Record the rungs nobody is going to act on.
 *
 * Superseded and skipped rows are what make the ledger readable a month later:
 * without them a booking that paid on day six shows no trace of the warnings it
 * did not get, and the question "why was this guest never chased?" has no
 * answer. They are also what stops a passed warning arriving a day late.
 */
async function writeOff(booking, plan, { result, dryRun }) {
  for (const entry of plan.superseded) {
    result.superseded += 1;
    if (!dryRun) await record(booking, entry, 'superseded', 'passed before the run reached it');
  }
  for (const entry of plan.skipped) {
    result.skipped += 1;
    if (!dryRun) await record(booking, entry, 'skipped', 'its condition did not hold on the day');
  }
}

/**
 * Carry out the one rung chosen for this booking.
 *
 * The ledger row is written before the send, so the unique index — not this
 * code — is what prevents a second attempt. A send that then fails rewrites
 * the row as failed, which falls outside the index and leaves the rung
 * eligible for the next run.
 */
async function act(booking, entry, { config, email, env, result, dryRun, today }) {
  const { rung } = entry;
  const templateId = templateFor(rung, env);

  // A rung with no template is not recorded at all: it must stay eligible for
  // the run after the club configures one, and a 'failed' row every quarter of
  // an hour would bury the ledger.
  if (!templateId) {
    if (!result.unconfigured.includes(rung.key)) result.unconfigured.push(rung.key);
    return;
  }
  if (!booking.guestEmail) {
    if (!dryRun) await record(booking, entry, 'skipped', 'no email address to send to');
    result.skipped += 1;
    return;
  }

  // A rung that cancels, where the club has not allowed the ladder to cancel
  // by itself, is held for a person. Nothing is emailed: the sheet's
  // "booking removed" is somebody's decision until a club says otherwise.
  if (rung.cancels && !config.autoCancel) {
    if (!dryRun) await record(booking, entry, 'held', 'a person has to decide: auto-cancel is off');
    result.held += 1;
    result.actions.push({ bookingId: booking.bookingId, rung: rung.key, outcome: 'held', dueOn: entry.dueOn });
    return;
  }

  if (dryRun) {
    result.sent += 1;
    result.actions.push({ bookingId: booking.bookingId, rung: rung.key, outcome: 'would send', dueOn: entry.dueOn });
    return;
  }

  // Claim the rung. A duplicate key here means another run already has it.
  const claimed = await record(booking, entry, 'sent', null);
  if (!claimed) {
    log.info(`${booking.bookingId}: ${rung.key} was already claimed by another run`);
    return;
  }

  const outcome = await sendTemplateEmail({
    apiKey: email.apiKey,
    fromEmail: email.fromEmail,
    fromName: email.fromName,
    toEmail: booking.guestEmail,
    templateId,
    data: {
      ...buildTemplateData(booking, { fromEmail: email.fromEmail }),
      lifecycle_rung: rung.key,
      lifecycle_label: rung.label,
      amount_outstanding: entry.money.outstanding,
      amount_paid: entry.money.paid,
      balance_due_date: entry.money.balanceDueDate ?? null,
      deadline_date: entry.dueOn,
    },
  });

  if (!outcome.ok) {
    // Rewrite the claim as a failure so the rung comes round again.
    await query(
      `UPDATE public.booking_trigger_sends SET outcome = 'failed', detail = $3
        WHERE club = $1 AND booking_id = $2 AND rung = $4 AND outcome = 'sent'`,
      [booking.club, booking.bookingId, String(outcome.message ?? 'send failed').slice(0, 300), rung.key],
    );
    result.failed += 1;
    log.warn(`${booking.bookingId}: ${rung.key} not sent — ${outcome.message}`);
    return;
  }

  result.sent += 1;
  result.actions.push({ bookingId: booking.bookingId, rung: rung.key, outcome: 'sent', dueOn: entry.dueOn });

  // Keep the legacy campaign stamp in step, so the Guest Emails page shows
  // this guest as already written to and cannot send the same email again.
  if (rung.campaign) {
    const campaign = getCampaign(rung.campaign);
    if (campaign) {
      await query(
        `UPDATE public.bookings SET "${campaign.column}" = COALESCE("${campaign.column}", NOW())
          WHERE booking_id = $1 AND club = $2`,
        [booking.bookingId, booking.club],
      );
    }
  }

  if (rung.cancels) await cancel(booking, rung, { result, today });
}

/**
 * The sheet's "booking removed".
 *
 * Implemented as the status and a note, never a delete. The row is the
 * evidence behind the cancellation — what was owed, what was chased, and on
 * which days — and a club that deletes it keeps the consequence and throws
 * away the justification. `changes.js` cancels the same way.
 */
async function cancel(booking, rung, { result, today }) {
  // The note names the reason and the rung, because it is what somebody reads
  // months later when the operator asks why their tee times went.
  const reason = rung.cancelReason ?? rung.label.toLowerCase();
  const note = `Cancelled by the booking lifecycle on ${today}: ${reason} (${rung.key}).`;
  await query(
    `UPDATE public.bookings
        SET status = 'Cancelled',
            note = CASE WHEN COALESCE(note, '') = '' THEN $3 ELSE note || E'\\n' || $3 END,
            updated_at = NOW(),
            updated_by = 'lifecycle'
      WHERE booking_id = $1 AND club = $2 AND status <> 'Cancelled'`,
    [booking.bookingId, booking.club, note],
  );
  result.cancelled += 1;
  log.info(`${booking.bookingId}: cancelled — ${rung.key}`);
}

/**
 * Write one ledger row, or report that the rung was already settled.
 *
 * Returns false on a unique-index collision, which is not an error: it is the
 * guarantee working. Another run, or another process, got to this rung first.
 */
async function record(booking, entry, outcome, detail) {
  try {
    await query(
      `INSERT INTO public.booking_trigger_sends
          (club, booking_id, rung, phase, outcome, due_on, detail, email_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        booking.club,
        booking.bookingId,
        entry.rung.key,
        entry.rung.phase,
        outcome,
        entry.dueOn,
        detail,
        outcome === 'sent' ? booking.guestEmail : null,
      ],
    );
    return true;
  } catch (err) {
    if (err.code === '23505' || err.code === '23P01') return false;
    throw err;
  }
}

async function loadOperators(club, cache) {
  if (cache.has(club)) return cache.get(club);
  const { rows } = await query(`SELECT ${OPERATOR_SELECT} FROM public.tour_operators WHERE club = $1`, [club]);
  const operators = rows.map(serialiseOperator);
  cache.set(club, operators);
  return operators;
}

/**
 * What a person has to look at: the rungs the ladder held back.
 *
 * With auto-cancel off — the default — a booking that runs out of road is
 * listed here and nothing is emailed. If this list is never read, the ladder
 * has quietly stopped doing the last thing the sheet asks of it, so the route
 * that serves it is the one worth putting on a screen.
 */
export async function heldDecisions(club, { limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT s.rung, s.phase, s.due_on, s.detail, s.created_at,
            b.booking_id, b.guest_name, b.guest_email, b.date, b.total, b.amount_paid, b.payment_status, b.status
       FROM public.booking_trigger_sends s
       JOIN public.bookings b ON b.booking_id = s.booking_id AND b.club = s.club
      WHERE s.club = $1 AND s.outcome = 'held'
      ORDER BY s.created_at DESC
      LIMIT $2`,
    [club, limit],
  );
  return rows.map((row) => ({
    bookingId: row.booking_id,
    rung: row.rung,
    phase: row.phase,
    dueOn: row.due_on ? new Date(row.due_on).toISOString().slice(0, 10) : null,
    detail: row.detail,
    heldAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    guestName: row.guest_name,
    guestEmail: row.guest_email,
    playDate: row.date ? new Date(row.date).toISOString().slice(0, 10) : null,
    status: row.status,
    paymentStatus: row.payment_status,
    total: row.total == null ? null : Number(row.total),
    amountPaid: row.amount_paid == null ? null : Number(row.amount_paid),
  }));
}

/** One booking's lifecycle history, newest first, for the drawer. */
export async function bookingLifecycle(club, bookingId) {
  const { rows } = await query(
    `SELECT rung, phase, outcome, due_on, detail, email_to, created_at
       FROM public.booking_trigger_sends
      WHERE club = $1 AND booking_id = $2
      ORDER BY created_at DESC`,
    [club, bookingId],
  );
  return rows.map((row) => ({
    rung: row.rung,
    phase: row.phase,
    outcome: row.outcome,
    dueOn: row.due_on ? new Date(row.due_on).toISOString().slice(0, 10) : null,
    detail: row.detail,
    emailTo: row.email_to,
    at: row.created_at ? new Date(row.created_at).toISOString() : null,
  }));
}

/** Start the background schedule. Returns a function that stops it. */
export function startBookingTriggers({ env = process.env } = {}) {
  const config = readTriggerConfig(env);

  if (!config.enabled) return () => {};
  if (!config.unattended) {
    log.info(
      'the lifecycle ladder is on but not scheduled — nothing runs by itself. ' +
        'Set BOOKING_TRIGGERS_SCHEDULE=true once you have read a dry run.',
    );
    return () => {};
  }

  const first = setTimeout(() => runBookingTriggers({ reason: 'startup' }), 30_000);
  const every = setInterval(() => runBookingTriggers({ reason: 'schedule' }), config.minutes * 60_000);
  first.unref?.();
  every.unref?.();
  log.info(
    `running the lifecycle ladder every ${config.minutes} min ` +
      `(auto-cancel ${config.autoCancel ? 'on' : 'off'}, catch-up ${config.catchUpDays} days)`,
  );
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
