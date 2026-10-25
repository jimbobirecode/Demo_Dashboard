/**
 * The booking lifecycle ladder, as the dashboard can see and drive it.
 *
 * Three things a club needs from a mechanism that emails cancellations:
 *
 *   GET  /api/booking-triggers            what is configured, and what the
 *                                         last run did
 *   POST /api/booking-triggers/preview    a dry run: what it would do today,
 *                                         sending nothing and writing nothing
 *   GET  /api/booking-triggers/held       the bookings waiting on a person,
 *                                         because auto-cancel is off
 *
 * The preview is the important one. A club should read a week of dry runs
 * before letting the ladder send anything, and nothing here needs the
 * schedule to be on for that to be possible.
 */
import { Router } from 'express';
import { requireAdmin, requireAuth } from '../auth.js';
import { readTriggerConfig, sendableLadder } from '../lib/booking-triggers-domain.js';
import { readEmailConfig } from '../lib/email-domain.js';
import {
  bookingLifecycle,
  heldDecisions,
  lastTriggerRun,
  runBookingTriggers,
  templateFor,
} from '../lib/booking-triggers.js';

const router = Router();
router.use(requireAuth);

/** The ladder as configured, with each rung's template reduced to a yes/no. */
function describeLadder(config, env) {
  return sendableLadder(config).map((rung) => ({
    key: rung.key,
    phase: rung.phase,
    label: rung.label,
    anchor: rung.anchor,
    offset: rung.offset,
    flows: rung.flows,
    cancels: rung.cancels,
    /** Never the template id itself: this shape is handed to the browser. */
    configured: Boolean(templateFor(rung, env)),
  }));
}

router.get('/', (req, res) => {
  const config = readTriggerConfig(process.env);
  const email = readEmailConfig(process.env);
  const ladder = describeLadder(config, process.env);

  res.json({
    // The three switches, which nest: nothing cancels until all three are on.
    switches: {
      enabled: config.enabled,
      deadlines: config.deadlines,
      scheduled: config.unattended,
      autoCancel: config.autoCancel,
      visitorDunning: config.visitorDunning,
    },
    catchUpDays: config.catchUpDays,
    everyMinutes: config.minutes,
    days: config.ladder,
    ladder,
    unconfigured: ladder.filter((rung) => !rung.configured).map((rung) => rung.key),
    emailReady: email.hasApiKey && Boolean(email.fromEmail),
    lastRun: lastTriggerRun(),
  });
});

/**
 * A dry run for today: every booking walked, nothing sent, nothing written.
 *
 * Admin-only and a POST rather than a GET, because it is not free — it reads
 * every eligible booking and its operator — and because a club reading this
 * is about to make a decision with it.
 */
router.post('/preview', requireAdmin, async (req, res, next) => {
  try {
    const result = await runBookingTriggers({ reason: `preview by ${req.user.username}`, dryRun: true });
    res.json({ preview: result });
  } catch (err) {
    next(err);
  }
});

/**
 * Run it now, for real.
 *
 * Admin-only. Allowed even when the schedule is off: that combination is the
 * deliberate one — a club that wants the ladder driven by a person rather
 * than by a clock.
 */
router.post('/run', requireAdmin, async (req, res, next) => {
  try {
    const config = readTriggerConfig(process.env);
    if (!config.enabled) {
      return res.status(409).json({ error: 'The lifecycle ladder is off. Set BOOKING_TRIGGERS_ENABLED=true first.' });
    }
    const result = await runBookingTriggers({ reason: `run by ${req.user.username}` });
    res.json({ run: result });
  } catch (err) {
    next(err);
  }
});

/** The bookings the ladder stopped at because a person has to decide. */
router.get('/held', async (req, res, next) => {
  try {
    res.json({ held: await heldDecisions(req.user.customerId) });
  } catch (err) {
    next(err);
  }
});

/** One booking's lifecycle history, for the drawer. */
router.get('/booking/:bookingId', async (req, res, next) => {
  try {
    res.json({ history: await bookingLifecycle(req.user.customerId, req.params.bookingId) });
  } catch (err) {
    next(err);
  }
});

export default router;
