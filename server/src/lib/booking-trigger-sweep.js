/**
 * The schedule that climbs the booking trigger ladder.
 *
 * Built like payment-sync and inbox-triage, which solve the same problem: one
 * pass shortly after boot, then every so often, and a last-run record so a
 * quiet failure can be found without shell access.
 *
 * Unlike those two it writes to guests, so the switch is stricter -- and since
 * migration 0027 it is the club's switch rather than the deployer's. Each club
 * decides on its Settings page whether it chases at all and whether the
 * schedule may send without anybody reading first; the pass ticks regardless
 * and asks each club in turn. A club can switch chasing on, watch the Booking
 * Status page for a week, and hand it to the schedule when it believes what it
 * sees.
 *
 * The environment keeps one word: TRIGGER_WORKFLOW set to an explicit false
 * stops the schedule for every club, which is how a staging copy of a live
 * database is kept from emailing real guests.
 *
 * The pass is daily by default, not minutely. Every rung of this ladder is
 * dated to a calendar day, so running it hourly would do fifteen times the work
 * to send the same emails; TRIGGER_SWEEP_MINUTES exists for a club that wants a
 * shorter cycle and for the tests.
 */
import { query } from '../db.js';
import { logger } from './logger.js';
import { readTriggerConfig, triggerReady } from './booking-triggers-domain.js';
import { clubTriggerConfig } from './booking-trigger-settings.js';
import { LedgerMissingError, runTriggers } from './booking-trigger-runner.js';

const log = logger.child('triggers');

let lastRun = null;

/** What the last pass did, for /api/booking-triggers/config. */
export function lastTriggerRun() {
  return lastRun;
}

/**
 * Every club with bookings.
 *
 * The ladder is per club because the bookings are: one deployment serves
 * whichever club it is pointed at, and a County Louth install has exactly one
 * row here. Read rather than assumed, so a group deployment sweeps all of them.
 */
export async function clubsWithBookings() {
  const { rows } = await query(`SELECT DISTINCT club FROM public.bookings WHERE club IS NOT NULL ORDER BY club ASC`);
  return rows.map((row) => row.club);
}

/** One pass over every club. Returns what it did, and never throws. */
export async function sweepTriggers({ reason = 'manual', env = process.env, now = new Date() } = {}) {
  const result = { reason, startedAt: new Date(now).toISOString(), finishedAt: null, clubs: [] };
  try {
    if (readTriggerConfig(env).locked) {
      result.skipped = 'TRIGGER_WORKFLOW is set to false in the environment, so no club is swept';
      return result;
    }

    for (const club of await clubsWithBookings()) {
      // Each club's own switches, read fresh each pass so a Save on the
      // Settings page takes effect at the next tick rather than the next deploy.
      const config = await clubTriggerConfig(club, env);
      if (!config.automatic) {
        result.clubs.push({
          club,
          skipped: config.enabled
            ? 'Only a person may send for this club (scheduled sending is off under Settings)'
            : 'Chasing is switched off for this club',
        });
        continue;
      }
      if (!triggerReady(config)) {
        result.clubs.push({ club, skipped: `The workflow cannot send. Missing: ${config.missing.join(', ')}.` });
        log.warn(`${club}: ${result.clubs.at(-1).skipped}`);
        continue;
      }

      // One club's bad afternoon must not stop the next club's.
      let run;
      try {
        run = await runTriggers({ club, sentBy: 'schedule', reason, now, env });
      } catch (err) {
        if (!(err instanceof LedgerMissingError)) throw err;
        // Not this club's problem and not the next club's either: the table is
        // missing for all of them. Said once, with the remedy, rather than once
        // per club per pass for however long it takes somebody to notice.
        result.skipped = err.message;
        log.error(err.message);
        return result;
      }
      result.clubs.push({
        club,
        sent: run.sent,
        failed: run.failed,
        skipped: run.skipped,
        cancelled: run.cancelled,
        needsReview: run.needsReview,
        error: run.error ?? null,
      });
      if (run.sent || run.failed || run.cancelled) {
        log.info(
          `${club}: ${run.sent} sent, ${run.failed} failed` +
            (run.cancelled ? `, ${run.cancelled} cancelled` : '') +
            (run.needsReview ? `, ${run.needsReview} waiting on a person` : ''),
        );
      }
    }
    return result;
  } catch (err) {
    result.error = err.message;
    log.error('sweep failed:', err.message);
    return result;
  } finally {
    result.finishedAt = new Date().toISOString();
    lastRun = result;
  }
}

/** Start the background schedule. Returns a function that stops it. */
export function startBookingTriggers({ env = process.env } = {}) {
  if (readTriggerConfig(env).locked) {
    log.info('TRIGGER_WORKFLOW is set to false, so the booking trigger workflow is off for every club');
    return () => {};
  }

  const minutes = Math.max(Number.parseFloat(env.TRIGGER_SWEEP_MINUTES ?? '1440') || 1440, 1);
  // Two minutes after boot, not twenty seconds: a deploy restarts the process,
  // and a ladder that emails guests should not race the first health check.
  const first = setTimeout(() => sweepTriggers({ reason: 'startup', env }), 120_000);
  const every = setInterval(() => sweepTriggers({ reason: 'schedule', env }), minutes * 60_000);
  first.unref?.();
  every.unref?.();
  log.info(
    `checking the booking trigger ladder every ${minutes} min; each club's Settings decide whether anything is sent`,
  );
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
