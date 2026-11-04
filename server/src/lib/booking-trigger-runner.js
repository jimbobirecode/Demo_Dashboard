/**
 * Running the booking trigger workflow: the I/O half of the ladder.
 *
 * `booking-triggers-domain.js` decides which rung each booking is on and which
 * one falls due today, without touching a database. This reads the club's
 * bookings and the ledger of rungs already climbed, asks the domain what to do,
 * does it, and writes down what happened. One pass, never throwing: a run
 * covers every booking in the club, and one guest with a dead address must not
 * abandon the rest.
 *
 * The ledger is `booking_trigger_sends` (migration 0026). Every settled outcome
 * is written there, which is what stops a rung being climbed twice — including
 * the ones that were not sent: a skipped step and a superseded step are both
 * recorded, because "we decided not to" is a decision and it should not be
 * re-taken differently tomorrow.
 *
 * `dryRun` walks the same path — same selection, same rendered email, same
 * Stripe decision — and stops short of the send, so a preview reports exactly
 * what a real run would do.
 */
import { query } from '../db.js';
import { BRAND } from './brand.js';
import { logger } from './logger.js';
import { BOOKING_SELECT, buildAuditSet } from './schema.js';
import { serialiseBooking } from './bookings-domain.js';
import { logEmail } from './email-log.js';
import { sendHtmlEmail, sendTemplateEmail } from './sendgrid.js';
import { todayInClubZone } from './email-domain.js';
import { createPaymentLink, deactivatePaymentLink, prefilledLinkUrl } from './stripe.js';
import { readPaymentLinkConfig } from './payment-link-domain.js';
import { OPERATOR_SELECT } from './schema.js';
import {
  buildOperatorIndex,
  identify,
  inPaymentLedger,
  paymentState,
  paymentTracking,
  serialiseOperator,
} from './operators-domain.js';
import { getStep, planBookings, readTriggerConfig, summarisePlans, triggerReady } from './booking-triggers-domain.js';
import { loadTriggerSettings } from './booking-trigger-settings.js';
import { buildTriggerEmail, buildTriggerTemplateData } from './booking-trigger-emails.js';

const log = logger.child('triggers');

/** One run never writes to more than this many bookings. */
export const MAX_RUN = 200;

/** Outcomes that settle a rung. A failure is left out so it is retried. */
export const SETTLED_OUTCOMES = ['sent', 'cancelled', 'skipped', 'superseded', 'cleared'];

/** The migration that creates the ledger. Named in the error below. */
export const LEDGER_MIGRATION = '0026_booking_trigger_workflow.sql';

/**
 * The ledger table is not there.
 *
 * Migrations are applied deliberately with `npm run migrate` before a deploy,
 * never at boot (see db/migrate.js and render.yaml), so the first thing that
 * happens to this feature on a real install is a deploy of the code against a
 * database that has not had 0026 yet. Postgres answers "relation does not
 * exist", which became a bare 500 and "Internal server error" on the page --
 * a dead end, for a problem with a one-line fix.
 *
 * So it is its own error, carrying the remedy, and the routes turn it into a
 * 409 the page prints. The server already says the same thing once at boot
 * (`reportSchema`), but nobody reads a log because a page went blank.
 */
export class LedgerMissingError extends Error {
  constructor() {
    super(
      'The booking trigger workflow needs a database table it cannot find ' +
        `(public.booking_trigger_sends, from migration ${LEDGER_MIGRATION}). ` +
        'Run "npm run migrate" against this database, then reload this page.',
    );
    this.name = 'LedgerMissingError';
    this.status = 409;
    this.migration = LEDGER_MIGRATION;
  }
}

/** Postgres' code for "relation does not exist". */
const UNDEFINED_TABLE = '42P01';

/**
 * Run a ledger query, turning a missing table into the error above.
 *
 * Only that one code is translated: any other database fault is a real fault
 * and must keep its own 500, rather than every outage being reported to the
 * club as a migration they have already run.
 */
async function onLedger(run) {
  try {
    return await run();
  } catch (err) {
    if (err?.code === UNDEFINED_TABLE) throw new LedgerMissingError();
    throw err;
  }
}

// --- reading -----------------------------------------------------------------

async function loadBookingRows(club) {
  const { rows } = await query(`SELECT ${BOOKING_SELECT} FROM public.bookings WHERE club = $1`, [club]);
  return rows.map(serialiseBooking);
}

async function loadOperatorRows(club) {
  const { rows } = await query(`SELECT ${OPERATOR_SELECT} FROM public.tour_operators WHERE club = $1`, [club]);
  return rows.map(serialiseOperator);
}

/**
 * Which rungs each booking has already climbed.
 *
 * A Map of booking reference to a Set of step ids, which is the shape the
 * domain's `sent` argument wants.
 */
export async function loadLedger(club) {
  const { rows } = await onLedger(() =>
    query(
      `SELECT booking_id, step FROM public.booking_trigger_sends
      WHERE club = $1 AND outcome = ANY($2::text[])`,
      [club, SETTLED_OUTCOMES],
    ),
  );

  const ledger = new Map();
  for (const row of rows) {
    if (!ledger.has(row.booking_id)) ledger.set(row.booking_id, new Set());
    ledger.get(row.booking_id).add(row.step);
  }
  return ledger;
}

/** The last things the workflow did, newest first — what the page shows as history. */
export async function recentSends(club, limit = 50) {
  const { rows } = await onLedger(() =>
    query(
      `SELECT booking_id, step, flow, due_on, sent_at, outcome, to_email, subject, detail, sent_by
       FROM public.booking_trigger_sends
      WHERE club = $1
      ORDER BY sent_at DESC
      LIMIT $2`,
      [club, Math.min(Math.max(Number(limit) || 50, 1), 200)],
    ),
  );
  return rows.map((row) => ({
    bookingId: row.booking_id,
    step: row.step,
    flow: row.flow,
    dueOn: row.due_on instanceof Date ? row.due_on.toISOString().slice(0, 10) : row.due_on,
    sentAt: row.sent_at instanceof Date ? row.sent_at.toISOString() : row.sent_at,
    outcome: row.outcome,
    toEmail: row.to_email,
    subject: row.subject,
    detail: row.detail,
    sentBy: row.sent_by,
  }));
}

/**
 * Write one rung into the ledger.
 *
 * `ON CONFLICT DO NOTHING` against the partial unique index, so two runs that
 * overlap — a person pressing Send while the schedule is mid-pass — cannot
 * double-write a step. The returned id says which run actually claimed it.
 */
export async function recordStep({
  club,
  bookingId,
  step,
  flow = null,
  dueOn = null,
  outcome = 'sent',
  toEmail = null,
  subject = null,
  detail = null,
  sentBy = 'schedule',
}) {
  const { rows } = await onLedger(() =>
    query(
      `INSERT INTO public.booking_trigger_sends
       (club, booking_id, step, flow, due_on, outcome, to_email, subject, detail, sent_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT DO NOTHING
     RETURNING id`,
      [club, bookingId, step, flow, dueOn, outcome, toEmail, subject, truncate(detail), sentBy],
    ),
  );
  return rows[0]?.id ?? null;
}

/**
 * The club's whole table planned against the ladder.
 *
 * Shared by the page, which draws it, and by a run, which walks it — so what a
 * run does is exactly what the page said it would.
 */
export async function planClub(club, { scope = 'due', playedSince = null, now = new Date(), env = process.env } = {}) {
  const today = todayInClubZone(now);
  const [bookings, operators, ledger, stored] = await Promise.all([
    loadBookingRows(club),
    loadOperatorRows(club),
    loadLedger(club),
    loadTriggerSettings(club),
  ]);
  // The club's own settings over the environment: see booking-trigger-settings.js.
  const config = readTriggerConfig(env, stored);

  // Attribution, once, for the whole table: which trade account each booking
  // belongs to decides which ladder it is on and whose credit terms its money
  // is read under.
  const index = buildOperatorIndex(operators);
  const accounts = new Map();
  for (const booking of bookings) {
    accounts.set(booking.bookingId, identify(booking, index));
  }

  // A ladder is only worth drawing while it still has rungs to climb. The page
  // asks for `playedSince` so "every booking" means every booking that is
  // still happening or has only just happened, rather than the whole archive
  // -- a club with ten years of rounds would otherwise be served a few
  // megabytes of settled history, sorted oldest first, with next week's
  // bookings off the end of it.
  const inWindow = playedSince ? bookings.filter((booking) => !booking.date || booking.date >= playedSince) : bookings;

  const tracking = paymentTracking(env);
  const plans = planBookings(inWindow, {
    scope,
    sent: ledger,
    operators: accounts,
    today,
    now,
    schedule: config.schedule,
    tracking,
  });

  // The club's payment ledger decides whether the chase ladder can run at all,
  // so the page has to be able to say so. With PAYMENTS_TRACKED_FROM unset
  // every booking is outside the ledger, no booking has a balance to chase,
  // and the deposit rungs match nothing -- which from the page looks exactly
  // like a workflow that is quietly broken. Counted here so it can be named.
  const outsideLedger = bookings.filter(
    (booking) => booking.status === 'Booked' && Number(booking.total) > 0 && !inPaymentLedger(booking, tracking),
  ).length;

  return {
    today,
    scope,
    config,
    playedSince,
    paymentsTracked: tracking.tracked,
    trackedFrom: tracking.from,
    outsideLedger,
    operators,
    accounts,
    bookings: new Map(bookings.map((booking) => [booking.bookingId, booking])),
    plans,
    summary: summarisePlans(plans),
  };
}

// --- running -----------------------------------------------------------------

/**
 * Climb every rung that falls due.
 *
 * `bookingIds`, when given, limits the run to those bookings — which is what
 * the page's "send these" button does. Absent, every booking with something due
 * is run, which is what the schedule does.
 */
export async function runTriggers({
  club,
  bookingIds = null,
  dryRun = false,
  sentBy = 'schedule',
  now = new Date(),
  env = process.env,
  reason = 'manual',
} = {}) {
  const result = {
    reason,
    club,
    dryRun,
    startedAt: new Date(now).toISOString(),
    finishedAt: null,
    sent: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    needsReview: 0,
    results: [],
  };

  try {
    const plan = await planClub(club, { scope: 'due', now, env });
    const { config } = plan;

    if (!config.enabled) {
      result.skippedRun = config.locked
        ? 'TRIGGER_WORKFLOW is set to false in the environment, which switches the workflow off for every club'
        : 'Chasing is switched off for this club. Turn it on under Settings.';
      return result;
    }
    if (!dryRun && !triggerReady(config)) {
      result.skippedRun = `The workflow cannot send. Missing: ${config.missing.join(', ')}.`;
      return result;
    }

    const wanted = bookingIds ? new Set(bookingIds) : null;
    const chosen = plan.plans.filter((entry) => !wanted || wanted.has(entry.bookingId)).slice(0, MAX_RUN);

    for (const booking of chosen) {
      // The rungs this booking passed on its way to the one that is due. They
      // are settled first and never sent: a reminder about a deadline that has
      // already expired is worse than no reminder.
      for (const passed of booking.superseded) {
        if (!dryRun) {
          await recordStep({
            club,
            bookingId: booking.bookingId,
            step: passed.step,
            flow: booking.flow,
            dueOn: passed.dueOn,
            outcome: 'superseded',
            detail: passed.reason,
            sentBy,
          });
        }
        result.skipped += 1;
        result.results.push({
          bookingId: booking.bookingId,
          step: passed.step,
          status: dryRun ? 'would_supersede' : 'superseded',
          message: passed.reason,
        });
      }

      if (!booking.next) continue;
      result.results.push(await climb(booking, plan, { club, dryRun, sentBy, env, tally: result }));
    }

    return result;
  } catch (err) {
    // A run that could not read the ledger has not run. Reported as a result
    // with `error` set, it would be a green "0 sent, 0 failed" — the page would
    // say every booking is where it should be, which is the one thing nobody
    // can know without the ledger. So this one goes up to the caller, which
    // turns it into a 409 naming the migration.
    if (err instanceof LedgerMissingError) throw err;
    log.error('run failed:', err.message);
    result.error = err.message;
    return result;
  } finally {
    result.finishedAt = new Date().toISOString();
  }
}

/**
 * One rung, for one booking: mint a link if the step needs one, render the
 * email, send it, cancel the booking if that is what the step does, and write
 * the ledger row.
 */
async function climb(plan, run, { club, dryRun, sentBy, env, tally }) {
  const { config } = run;
  const step = getStep(plan.next.step, config.schedule);
  const booking = run.bookings.get(plan.bookingId);
  const account = run.accounts.get(plan.bookingId);
  const base = { bookingId: plan.bookingId, step: step.id, dueOn: plan.next.dueOn, flow: plan.flow };
  // Money to the account, the round-up to the tee to the guest: the domain
  // decided this per rung (`recipientFor`), and the runner only posts it.
  const toEmail = plan.next.to ?? plan.guestEmail;

  // Cancelling is the one rung that changes the club's own tee sheet. With
  // automatic cancelling off it is reported and left: nothing is emailed,
  // because the cancellation email would be announcing a cancellation that
  // has not happened, and nothing is written to the ledger, so it stays on
  // the list until a person deals with it.
  if (step.action === 'cancel' && !config.autoCancel) {
    tally.needsReview += 1;
    return {
      ...base,
      status: 'needs_review',
      message: 'Due for cancellation. Automatic cancelling is off under Settings, so a person has to do it.',
    };
  }

  const state = paymentState(booking, account?.operator ?? null, {
    today: run.today,
    tracking: paymentTracking(env),
  });

  // A fresh payment link, where the step is one that asks for money and the
  // amount it asks for is not the one the last link carried.
  let paymentUrl = booking.paymentLinkUrl || null;
  let linkIssued = null;
  if (step.action === 'payment_link') {
    const issued = await issuePaymentLink(booking, state, { club, dryRun, env });
    if (issued.error) {
      tally.failed += 1;
      await record(base, { club, outcome: 'failed', detail: issued.error, sentBy, dryRun });
      return { ...base, status: 'failed', message: issued.error };
    }
    if (issued.url) {
      paymentUrl = issued.url;
      linkIssued = issued;
    }
  }

  const data = buildTriggerTemplateData(plan, step, booking, {
    fromEmail: config.fromEmail,
    money: plan.money,
    paymentUrl,
    schedule: config.schedule,
    today: run.today,
    // Whose inbox, and so which voice: see the two voices in the emails module.
    operator: account?.operator ?? null,
    toEmail,
  });
  const built = buildTriggerEmail(step.id, data);
  const templateId = config.templates[step.id] ?? null;

  // The figure in the sentence and the figure on the button come from two
  // computations -- the ladder's own `moneyState` and the ledger's
  // `paymentState` -- and for five days they disagreed: every deposit email
  // asked a 30% account for the whole round while the Stripe link beside it
  // charged the deposit. Twenty-nine emails went out before anybody noticed,
  // because nothing was comparing them.
  //
  // So they are compared now, on every send, and a disagreement stops the
  // email instead of posting it. A chase that cannot say what is owed is
  // worth far less than the trust it spends being wrong, and the rung stays
  // open for the next run once somebody has fixed the cause.
  const disagreement = moneyDisagreement(step, data, state);
  if (disagreement) {
    tally.failed += 1;
    await record(base, { club, outcome: 'failed', detail: disagreement, sentBy, dryRun });
    return { ...base, status: 'failed', message: disagreement };
  }

  if (dryRun) {
    return {
      ...base,
      status: 'would_send',
      email: toEmail,
      subject: built.subject,
      message:
        `Dry run — ${plan.next.reason}` +
        (templateId ? `, through SendGrid template ${templateId}` : ', using the built-in email') +
        (linkIssued ? ', with a new payment link' : ''),
      preview: data,
    };
  }

  // The tee sheet before the inbox, where the step does both.
  //
  // The email for a lapse step says the booking HAS been cancelled, so it must
  // not go out until it has. The booking was read at the start of the pass and
  // somebody may have taken a payment or cancelled it by hand since -- the
  // UPDATE requires it to still be Booked -- and in that case the right answer
  // is to send nothing and leave the rung open rather than to tell a guest
  // their round is gone when it is not.
  let cancelled = false;
  if (step.action === 'cancel') {
    cancelled = await cancelBooking(plan.bookingId, club, step.id, sentBy);
    if (!cancelled) {
      if (linkIssued) await retireLink(linkIssued.id, env);
      tally.failed += 1;
      const message = 'The booking was no longer Booked, so nothing was cancelled and nothing was sent.';
      await record(base, { club, outcome: 'failed', detail: message, sentBy, dryRun });
      return { ...base, status: 'failed', message };
    }
    tally.cancelled += 1;
  }

  const sender = {
    apiKey: config.apiKey,
    fromEmail: config.fromEmail,
    fromName: config.fromName,
    toEmail,
  };
  const outcome = templateId
    ? await sendTemplateEmail({ ...sender, templateId, data })
    : await sendHtmlEmail({ ...sender, subject: built.subject, html: built.html, text: built.text });

  if (!outcome.ok) {
    // Nobody has the link, so it must not stay payable.
    if (linkIssued) await retireLink(linkIssued.id, env);
    tally.failed += 1;
    await record(base, { club, outcome: 'failed', detail: outcome.message, toEmail, sentBy, dryRun });
    // A cancellation that went through is reported even though the email did
    // not: the tee time is released, and the ledger row above is the retry.
    return {
      ...base,
      status: 'failed',
      email: toEmail,
      message: cancelled ? `The booking was cancelled, but the email failed: ${outcome.message}` : outcome.message,
    };
  }

  if (linkIssued) await storeLink(booking, linkIssued, { club, sentBy });

  tally.sent += 1;
  await record(base, {
    club,
    outcome: cancelled ? 'cancelled' : 'sent',
    toEmail,
    subject: built.subject,
    detail: plan.next.reason,
    sentBy,
    dryRun,
  });

  await logEmail({
    club,
    direction: 'outbound',
    booking_id: plan.bookingId,
    from_email: config.fromEmail,
    to_email: toEmail,
    subject: built.subject,
    body_text: templateId ? `${step.label} sent from the SendGrid template (${templateId}).` : built.text,
    sent_by: sentBy,
    kind: `trigger_${step.id}`,
  });

  log.info(`${plan.bookingId}: ${step.id} → ${toEmail}${cancelled ? ' (and cancelled)' : ''}`);

  return {
    ...base,
    status: cancelled ? 'cancelled' : 'sent',
    email: toEmail,
    subject: built.subject,
    message: outcome.message,
  };
}

function record(base, { club, outcome, toEmail = null, subject = null, detail, sentBy, dryRun }) {
  if (dryRun) return Promise.resolve(null);
  return recordStep({ club, ...base, outcome, toEmail, subject, detail, sentBy });
}

/**
 * Whether this email is about to quote a figure the ledger does not agree is
 * owed. Returns the reason to refuse, or '' when the two agree.
 *
 * Only the money rungs are checked: the arrival and thank-you emails talk
 * about the round, not the bill, and quote no figure to be wrong about.
 *
 * The tolerance is half a cent — both sides round to cents, and a float
 * comparison that demands exactness would refuse perfectly good emails.
 */
export function moneyDisagreement(step, data, state) {
  if (step.group !== 'payment') return '';
  if (state?.tracked === false) return '';

  const said = Number(data?.due_raw);
  const owed = Number(state?.dueAmount);
  if (!Number.isFinite(said) || !Number.isFinite(owed)) {
    return 'The email could not work out what is owed, so it was not sent.';
  }
  if (Math.abs(said - owed) < 0.005) return '';

  return (
    `The email would have asked for ${said.toFixed(2)} where the booking owes ${owed.toFixed(2)}. ` +
    'Nothing was sent. The two ways this club works out what is due have gone out of step, which is a ' +
    'fault in the dashboard rather than anything about this booking.'
  );
}

// --- the two side effects ----------------------------------------------------

/**
 * A Stripe link for whatever this booking owes next.
 *
 * Resolves to `{ url, id, amount }`, to `{}` when Stripe is not configured (the
 * email then asks them to reply for a link, which is better than a dead
 * button), or to `{ error }` when Stripe refused.
 *
 * The amount is the next unsettled milestone under the booking's own terms —
 * the deposit while it is outstanding, the balance after — rather than the
 * whole total, so the figure in the email matches the word next to it.
 */
async function issuePaymentLink(booking, state, { club, dryRun, env }) {
  const config = readPaymentLinkConfig(env);
  if (!config.configured) return {};

  const amount = round2(state.dueAmount > 0 ? state.dueAmount : state.outstanding);
  if (!(amount >= 0.5)) return {};
  if (dryRun) return { url: booking.paymentLinkUrl || 'https://pay.stripe.com/dry-run', id: null, amount };

  try {
    const link = await createPaymentLink({
      secretKey: config.secretKey,
      amount,
      currency: config.currency,
      productName:
        state.stage === 'deposit'
          ? `${BRAND.fullName} – deposit for booking ${booking.bookingId}`
          : `${BRAND.fullName} – booking ${booking.bookingId}`,
      bookingId: booking.bookingId,
      club,
      confirmationMessage: `Thank you — your payment for booking ${booking.bookingId} has been received. ${BRAND.fullName}`,
    });
    return {
      id: link.id,
      amount,
      url: prefilledLinkUrl(link.url, { email: booking.guestEmail, bookingId: booking.bookingId }),
      previousId: booking.paymentLinkId || null,
    };
  } catch (err) {
    return { error: /^Stripe /.test(err.message) ? err.message : `Could not create a payment link: ${err.message}` };
  }
}

/** Record the link on the booking, exactly as the drawer's own button does. */
async function storeLink(booking, link, { club, sentBy }) {
  // The audit values are spliced in at placeholder 8, after the seven below.
  const audit = buildAuditSet(8, sentBy);
  await query(
    `UPDATE public.bookings
        SET stripe_payment_link_id = $1,
            stripe_payment_link_url = $2,
            payment_link_amount = $3,
            payment_link_sent_by = $4,
            payment_status = $5,
            payment_link_sent_at = NOW()
            ${audit.clauses.length ? `, ${audit.clauses.join(', ')}` : ''}
      WHERE booking_id = $6 AND club = $7`,
    [link.id, link.url, link.amount, sentBy, 'Pending', booking.bookingId, club, ...audit.values],
  ).catch((err) => log.warn(`${booking.bookingId}: could not record the payment link — ${err.message}`));

  // The previous link asked for a different amount; switch it off so nobody
  // pays both. Best effort — the new link is already out.
  if (link.previousId && link.previousId !== link.id) await retireLink(link.previousId, process.env);
}

function retireLink(linkId, env) {
  if (!linkId) return Promise.resolve();
  const config = readPaymentLinkConfig(env);
  if (!config.secretKey) return Promise.resolve();
  return deactivatePaymentLink({ secretKey: config.secretKey, linkId }).catch((err) =>
    log.error('could not deactivate payment link', linkId, err.message),
  );
}

/**
 * Take the booking off the sheet.
 *
 * Only from Booked, which is the guard behind the ordering in `climb`: if
 * somebody has taken a payment or cancelled it by hand since the pass read the
 * table, this matches nothing and no email goes out. 'Confirmed' is the retired
 * spelling of Booked that older rows still carry -- `normaliseStatus` reads it
 * as Booked, so this has to as well, or such a booking would be told it was
 * cancelled and then not be.
 *
 * Cancelled, never deleted. The club's record of a round that was booked and
 * lost is worth keeping — it is the evidence behind the cancellation, and the
 * row carries the money, the correspondence and the audit trail. A delete would
 * take all of it, and no apology brings it back.
 */
async function cancelBooking(bookingId, club, step, sentBy) {
  try {
    const audit = buildAuditSet(4, sentBy);
    const { rowCount } = await query(
      `UPDATE public.bookings
          SET status = 'Cancelled',
              note = CONCAT(COALESCE(note, ''), $1::text)
              ${audit.clauses.length ? `, ${audit.clauses.join(', ')}` : ''}
        WHERE booking_id = $2 AND club = $3
          AND lower(COALESCE(status, '')) IN ('booked', 'confirmed')`,
      [
        `\n\nCancelled by the booking trigger workflow (${step}) on ${new Date().toISOString().slice(0, 10)}.`,
        bookingId,
        club,
        ...audit.values,
      ],
    );
    return rowCount > 0;
  } catch (err) {
    log.error(`${bookingId}: could not cancel — ${err.message}`);
    return false;
  }
}

function truncate(value) {
  return value == null ? null : String(value).slice(0, 500);
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
