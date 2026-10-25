/**
 * The booking lifecycle ladder, as the dashboard can see and drive it.
 *
 * Three things a club needs from a mechanism that emails cancellations:
 *
 *   GET  /api/booking-triggers            what this club has configured, and
 *                                         what its last run did
 *   GET  /api/booking-triggers/settings   the settings form's own view of it
 *   PUT  /api/booking-triggers/settings   change them (admin)
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
import { logger } from '../lib/logger.js';
import {
  DAY_SETTINGS,
  LADDER_DEFAULTS,
  readTriggerConfig,
  sendableLadder,
  validateLifecycleSettings,
} from '../lib/booking-triggers-domain.js';
import { readEmailConfig } from '../lib/email-domain.js';
import {
  bookingLifecycle,
  clubTriggerConfig,
  heldDecisions,
  lastTriggerRun,
  loadLifecycleSettings,
  runBookingTriggers,
  saveLifecycleSettings,
  templateFor,
} from '../lib/booking-triggers.js';
import { hasBuiltInEmail } from '../lib/lifecycle-emails.js';

const log = logger.child('booking-triggers');

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
    /**
     * Whether this rung has anything to send. Never the template id itself:
     * this shape is handed to the browser.
     *
     * A club's own SendGrid template wins, and the built-in email is the
     * fallback — so a rung is only unconfigured if nobody has written copy
     * for it, which means a rung newer than lifecycle-emails.js.
     */
    configured: Boolean(templateFor(rung, env)) || hasBuiltInEmail(rung.key),
    /** True where the club has supplied its own wording. */
    ownTemplate: Boolean(templateFor(rung, env)),
  }));
}

router.get('/', async (req, res, next) => {
  try {
    const config = await clubTriggerConfig(req.user.customerId);
    const email = readEmailConfig(process.env);
    const ladder = describeLadder(config, process.env);

    res.json({
      // The switches, which nest: nothing cancels until all of them are on.
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
      canEdit: req.user.role === 'admin',
      lastRun: lastTriggerRun(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The settings form's view: what this club has set, what it would inherit if
 * it set nothing, and the bounds each field is held to.
 *
 * `saved` is the list of keys the club has actually chosen, so the form can
 * say "inherited" beside the rest rather than presenting an environment
 * default as though somebody here had decided it.
 */
router.get('/settings', async (req, res, next) => {
  try {
    const club = req.user.customerId;
    const [stored, config] = await Promise.all([loadLifecycleSettings(club), clubTriggerConfig(club)]);
    const inherited = readTriggerConfig(process.env);

    res.json({
      settings: {
        enabled: config.enabled,
        deadlines: config.deadlines,
        scheduled: config.unattended,
        autoCancel: config.autoCancel,
        visitorDunning: config.visitorDunning,
        catchUpDays: config.catchUpDays,
        ...config.ladder,
      },
      saved: Object.keys(stored),
      inherited: {
        enabled: inherited.enabled,
        deadlines: inherited.deadlines,
        scheduled: inherited.unattended,
        autoCancel: inherited.autoCancel,
        visitorDunning: inherited.visitorDunning,
        catchUpDays: inherited.catchUpDays,
        ...inherited.ladder,
      },
      defaults: { ...LADDER_DEFAULTS },
      bounds: DAY_SETTINGS,
      canEdit: req.user.role === 'admin',
      everyMinutes: config.minutes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Change them. Admin only, and validated as a whole rather than field by
 * field: the orderings that matter — a reminder before the deadline it
 * reminds about — cannot be checked one input at a time.
 */
router.put('/settings', requireAdmin, async (req, res, next) => {
  try {
    const club = req.user.customerId;
    const current = await loadLifecycleSettings(club);
    const before = readTriggerConfig(process.env, current);

    const check = validateLifecycleSettings(req.body?.settings, {
      current: { ...before.ladder, catchUpDays: before.catchUpDays },
    });
    if (!check.ok) return res.status(400).json({ error: check.errors.join('. '), errors: check.errors });
    if (!Object.keys(check.value).length) return res.status(400).json({ error: 'Nothing to change' });

    const stored = await saveLifecycleSettings(club, check.value, req.user.username);
    const after = readTriggerConfig(process.env, stored);

    // Worth a line in the log on its own: these two decide whether guests are
    // emailed at all, and whether a booking can be cancelled without anybody
    // seeing it first.
    if (after.enabled !== before.enabled) {
      log.info(
        `lifecycle ladder ${after.enabled ? 'switched on' : 'switched off'} for ${club} by ${req.user.username}`,
      );
    }
    if (after.autoCancel !== before.autoCancel) {
      log.info(
        `lifecycle auto-cancel ${after.autoCancel ? 'switched ON' : 'switched off'} for ${club} ` +
          `by ${req.user.username}`,
      );
    }

    res.json({ saved: Object.keys(stored), settings: { ...after.ladder, catchUpDays: after.catchUpDays } });
  } catch (err) {
    next(err);
  }
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
    // Scoped to the signed-in club: one club must never read, or act on,
    // another's bookings, and a dry run walks every booking it is given.
    const result = await runBookingTriggers({
      reason: `preview by ${req.user.username}`,
      dryRun: true,
      club: req.user.customerId,
    });
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
    const club = req.user.customerId;
    const config = await clubTriggerConfig(club);
    if (!config.enabled) {
      return res
        .status(409)
        .json({ error: 'The lifecycle ladder is off. Switch it on in Settings before running it.' });
    }
    const result = await runBookingTriggers({ reason: `run by ${req.user.username}`, club });
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
