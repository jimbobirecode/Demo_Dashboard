/**
 * Getting every booked customer to the club's endpoint, exactly once if the
 * network allows and at least once if it does not.
 *
 * Two ways in, on purpose:
 *
 *   `handoverBookedCustomer` is called the moment a booking reaches 'Booked',
 *   so the usual case is immediate.
 *
 *   `sweepBookedCustomers` asks the database the same question instead -
 *   which 'Booked' bookings carry no stamp? - and so catches everything the
 *   first way misses: a POST the receiver was down for, a booking the core
 *   API booked in its own process, a path that reaches 'Booked' without
 *   calling the first way at all. The schema, not this file, is where the
 *   rule lives (see db/migrations/0011).
 *
 * The stamp is written after the receiver accepts, never before. A process
 * killed between the POST and the stamp therefore sends that one booking
 * twice on the next sweep, which is the right way round to be wrong: the
 * payload carries `bookingRef` for a receiver to key on, and a duplicate it
 * can drop is better than a customer nobody ever hears about.
 */
import { query } from '../db.js';
import { logger } from './logger.js';
import { serialiseBooking } from './bookings-domain.js';
import { BOOKING_SELECT } from './schema.js';
import { buildBookedCustomerPayload, readBookedWebhookConfig, shouldSendBooked } from './booked-webhook-domain.js';
import { postBookedCustomer } from './booked-webhook.js';

const log = logger.child('booked-webhook');

/** One sweep at a time in this process, however often it is asked for. */
let sweeping = null;

/** The last sweep, for the diagnostics drawer and for the log at boot. */
let lastRun = null;

export function lastBookedWebhookRun() {
  return lastRun;
}

/**
 * Hand one booking over, if it is one to hand over and the integration is on.
 *
 * Resolves to an outcome rather than throwing, and never rejects: this is
 * called from inside request handlers that have already changed the booking,
 * and a receiver being down must not turn a saved booking into a 500 the user
 * reads as "it did not save".
 */
export async function handoverBookedCustomer(booking, { reason = 'transition', env = process.env, fetchImpl } = {}) {
  const config = readBookedWebhookConfig(env);
  if (!config.enabled) return { ok: true, skipped: 'not configured' };
  if (!shouldSendBooked(booking)) return { ok: true, skipped: 'nothing to send' };

  try {
    const payload = buildBookedCustomerPayload(booking, { source: config.source });
    const outcome = await postBookedCustomer({ config, payload, fetchImpl });

    if (outcome.ok) {
      await markSent(booking);
      log.info(`${reason}: ${outcome.message}`);
      return outcome;
    }

    // Left unstamped either way, so the next sweep tries again. A refusal is
    // logged louder than an outage: an outage fixes itself, a refusal is
    // somebody's bug and will keep failing until it is found.
    const line = `${reason}: ${outcome.message}`;
    if (outcome.retryable) log.warn(`${line} — will retry`);
    else log.error(line);
    return outcome;
  } catch (err) {
    log.warn(`${reason}: ${booking?.bookingId} could not be handed over: ${err.message}`);
    return { ok: false, status: 0, retryable: true, message: err.message };
  }
}

/** Stamp the booking as handed over. Idempotent, and never overwrites an earlier stamp. */
async function markSent(booking) {
  await query(
    `UPDATE public.bookings
        SET booked_webhook_sent_at = NOW()
      WHERE booking_id = $1 AND club = $2 AND booked_webhook_sent_at IS NULL`,
    [booking.bookingId, booking.club],
  );
}

/**
 * Every booked customer the endpoint has not accepted yet.
 *
 * Oldest change first, so a backlog drains in the order the bookings were
 * made, and capped per run: a club switching the integration on for the first
 * time has a whole back catalogue waiting, and posting all of it in one burst
 * is how a receiver starts refusing.
 */
export async function sweepBookedCustomers({ reason = 'schedule', env = process.env, fetchImpl } = {}) {
  const config = readBookedWebhookConfig(env);
  if (!config.enabled) return { skipped: 'not configured' };

  // An overlapping run would read the same unstamped rows and post them
  // twice; the caller gets the run already in flight instead.
  if (sweeping) return sweeping;

  const limit = Math.max(Number.parseInt(env.BOOKED_WEBHOOK_BATCH ?? '25', 10) || 25, 1);
  sweeping = run({ reason, config, limit, fetchImpl }).finally(() => {
    sweeping = null;
  });
  return sweeping;
}

async function run({ reason, config, limit, fetchImpl }) {
  const result = { reason, startedAt: new Date().toISOString(), sent: 0, failed: 0, skipped: 0, finishedAt: null };

  try {
    const { rows } = await query(
      `SELECT ${BOOKING_SELECT} FROM public.bookings
        WHERE status = 'Booked' AND booked_webhook_sent_at IS NULL
        ORDER BY updated_at NULLS FIRST
        LIMIT $1`,
      [limit],
    );

    for (const row of rows) {
      const booking = serialiseBooking(row);

      if (!shouldSendBooked(booking)) {
        // No email and no phone: nothing a receiver could use. Left for a
        // later sweep in case the details arrive, and not counted a failure.
        result.skipped += 1;
        continue;
      }

      const payload = buildBookedCustomerPayload(booking, { source: config.source });
      const outcome = await postBookedCustomer({ config, payload, fetchImpl });

      if (outcome.ok) {
        await markSent(booking);
        result.sent += 1;
      } else {
        result.failed += 1;
        log.warn(`sweep: ${outcome.message}`);
        // The receiver is down, not refusing this one booking: stop the run
        // rather than time out against it once per booking in the backlog.
        if (outcome.retryable) break;
      }
    }

    if (result.sent || result.failed) {
      log.info(`sweep (${reason}): ${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped`);
    }
    return result;
  } catch (err) {
    result.error = err.message;
    log.error(`sweep (${reason}) failed: ${err.message}`);
    return result;
  } finally {
    result.finishedAt = new Date().toISOString();
    lastRun = result;
  }
}

/** Start the background sweep. Returns a function that stops it. */
export function startBookedWebhook({ env = process.env } = {}) {
  const config = readBookedWebhookConfig(env);

  if (config.insecure) {
    log.error(
      `BOOKED_WEBHOOK_URL is not https (${config.url}) — booked customers are not being sent. ` +
        "A guest's name, email address and phone number would travel in clear.",
    );
    return () => {};
  }
  if (!config.enabled) {
    // Said once at boot, and only when the club has started configuring it:
    // a dashboard that has never heard of this integration needs no warning.
    if (config.missing.length === 1) {
      log.warn(`${config.missing[0]} is not set — booked customers are not being sent anywhere.`);
    }
    return () => {};
  }

  const minutes = Math.max(Number.parseFloat(env.BOOKED_WEBHOOK_MINUTES ?? '2') || 2, 0.5);
  const first = setTimeout(() => sweepBookedCustomers({ reason: 'startup' }), 20_000);
  const every = setInterval(() => sweepBookedCustomers({ reason: 'schedule' }), minutes * 60_000);
  first.unref?.();
  every.unref?.();
  log.info(`posting booked customers to ${hostOf(config.url)}; sweeping for missed ones every ${minutes} min`);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

/** The endpoint's host, for a log line: a full URL can carry a token in its path. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'the configured endpoint';
  }
}
