/**
 * The booking trigger workflow, from the dashboard.
 *
 *   GET  /api/booking-triggers/config    the ladder, the deadlines, the switches
 *   GET  /api/booking-triggers/settings  the Settings page's view of them
 *   PUT  /api/booking-triggers/settings  change them, per club (admin)
 *   GET  /api/booking-triggers/pending   what is due, missed, or on the way
 *   GET  /api/booking-triggers/history   what the workflow has done lately
 *   GET  /api/booking-triggers/bookings/:bookingId  one booking's whole ladder
 *   POST /api/booking-triggers/run       climb the rungs that are due
 *   POST /api/booking-triggers/clear     take rungs off the list without sending
 *
 * The browser only ever names booking references — the rows themselves are
 * re-read here, scoped to the signed-in user's club, so a request cannot reach
 * another club's guests. And the selection is re-made on the server for the same
 * reason the two reminder pages re-make theirs: the browser may have been
 * looking at the list for an hour, and the club's own rules decide what goes in
 * an email, not the payload.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { BOOKING_SELECT } from '../lib/schema.js';
import { serialiseBooking } from '../lib/bookings-domain.js';
import { addDays, todayInClubZone } from '../lib/email-domain.js';
import { logger } from '../lib/logger.js';
import {
  DEFAULT_SCHEDULE,
  SETTING_BOUNDS,
  STEP_IDS,
  publicTriggerConfig,
  readTriggerConfig,
  triggerReady,
  validateTriggerSettings,
} from '../lib/booking-triggers-domain.js';
import {
  SettingsMissingError,
  clubTriggerConfig,
  loadTriggerSettings,
  saveTriggerSettings,
} from '../lib/booking-trigger-settings.js';
import { loadOperators } from './operators.js';
import {
  LedgerMissingError,
  MAX_RUN,
  planClub,
  recentSends,
  recordStep,
  runTriggers,
} from '../lib/booking-trigger-runner.js';
import { lastTriggerRun, sweepTriggers } from '../lib/booking-trigger-sweep.js';

const router = Router();
router.use(requireAuth);

const log = logger.child('triggers');

/** The ladder and the deadlines it is cut to, with the last pass's result. */
router.get('/config', async (req, res, next) => {
  try {
    const config = await clubTriggerConfig(req.user.customerId);
    res.json({
      ...publicTriggerConfig(config),
      ready: triggerReady(config),
      lastRun: lastTriggerRun(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The settings form's view: what this club has set, what it would inherit from
 * the environment if it cleared a setting, the defaults, the bounds, and how
 * the trade book is actually chased.
 *
 * Reading is open to anyone signed in — everybody on the desk should be able
 * to see why a guest was chased on a Tuesday. Saving is an administrator's.
 */
router.get('/settings', async (req, res, next) => {
  try {
    const club = req.user.customerId;
    const [stored, operators] = await Promise.all([loadTriggerSettings(club), loadOperators(club)]);
    const config = readTriggerConfig(process.env, stored);
    const inherited = readTriggerConfig(process.env);

    // The settings page says "the default applies to N accounts" rather than
    // presenting a number that, for most accounts, their own terms override.
    const active = operators.filter((operator) => operator.active !== false);
    const trade = {
      accounts: active.length,
      ownDepositTerm: active.filter((operator) => operator.depositDueDaysBeforePlay != null).length,
      ownBalanceTerm: active.filter((operator) => operator.balanceDueDaysBeforePlay != null).length,
      notChased: active.filter((operator) => operator.autoChase === false).length,
      noContactEmail: active.filter((operator) => operator.autoChase !== false && !operator.contactEmail).length,
    };

    res.json({
      settings: settingsOf(config),
      saved: config.saved,
      locked: config.locked,
      inherited: settingsOf(inherited),
      defaults: { enabled: false, automatic: false, autoCancel: false, ...DEFAULT_SCHEDULE },
      bounds: SETTING_BOUNDS,
      trade,
      ready: triggerReady(config),
      missing: config.missing,
      canEdit: req.user.role === 'admin',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Change the club's settings.
 *
 * A patch, validated against the settings as they would be after it, then
 * merged into what is saved. Two of the keys decide whether guests are emailed
 * at all and whether a booking can be cancelled with nobody looking, so a
 * change to either gets a line in the log of its own.
 */
router.put('/settings', requireAdmin, async (req, res, next) => {
  try {
    const club = req.user.customerId;
    const current = await loadTriggerSettings(club);
    const before = readTriggerConfig(process.env, current);

    const check = validateTriggerSettings(req.body?.settings, { current: before.schedule });
    if (!check.ok) return res.status(400).json({ error: check.errors.join('. '), errors: check.errors });
    if (!Object.keys(check.value).length) return res.status(400).json({ error: 'Nothing to change' });

    const stored = await saveTriggerSettings(club, check.value, req.user.username);
    const after = readTriggerConfig(process.env, stored);

    if (after.enabled !== before.enabled) {
      log.info(`chasing ${after.enabled ? 'switched on' : 'switched off'} for ${club} by ${req.user.username}`);
    }
    if (after.automatic !== before.automatic) {
      log.info(
        `scheduled sending ${after.automatic ? 'switched on' : 'switched off'} for ${club} by ${req.user.username}`,
      );
    }
    if (after.autoCancel !== before.autoCancel) {
      log.info(`auto-cancel ${after.autoCancel ? 'switched ON' : 'switched off'} for ${club} by ${req.user.username}`);
    }

    res.json({ saved: after.saved, locked: after.locked, settings: settingsOf(after) });
  } catch (err) {
    next(err);
  }
});

/** The switches and the schedule as one flat object, which is what the form edits. */
function settingsOf(config) {
  return {
    enabled: config.enabled,
    automatic: config.automatic,
    autoCancel: config.autoCancel,
    ...config.schedule,
  };
}

const SCOPES = ['due', 'missed', 'all'];

/**
 * How far back the "every booking" view reaches.
 *
 * The other two scopes are narrow by construction -- a rung that fell due, or
 * one that fell due recently and went unsent -- but 'all' would otherwise draw
 * the club's whole archive, oldest first, which on a decade of rounds is both
 * slow and useless: the bookings somebody is looking for are at the far end of
 * it. A month back covers the rounds whose post-play rung is still live.
 *
 * It applies to the VIEW only. A run is never scoped by it: `runTriggers` plans
 * with `scope: 'due'` and no window, so a rung inside the catch-up horizon is
 * climbed whatever this page happens to be showing.
 */
const HISTORY_DAYS = 30;

/**
 * What the workflow would do.
 *
 * `scope=due` is the run: the bookings with a rung falling due today.
 * `scope=missed` is the list to read after switching it on — rungs whose date
 * went past before anybody was sending. `scope=all` is every live booking with
 * its whole ladder, which is what the page draws.
 */
router.get('/pending', async (req, res, next) => {
  const scope = SCOPES.includes(req.query.scope) ? req.query.scope : 'due';
  try {
    const today = todayInClubZone();
    const plan = await planClub(req.user.customerId, {
      scope,
      playedSince: scope === 'all' ? addDays(today, -HISTORY_DAYS) : null,
    });
    res.json({
      scope,
      today: plan.today,
      playedSince: plan.playedSince,
      schedule: plan.config.schedule,
      enabled: plan.config.enabled,
      automatic: plan.config.automatic,
      autoCancel: plan.config.autoCancel,
      locked: plan.config.locked,
      ready: triggerReady(plan.config),
      missing: plan.config.missing,
      // The chase ladder can only run where the club records payments; see
      // planClub. Reported rather than left to be inferred from an empty list.
      paymentsTracked: plan.paymentsTracked,
      trackedFrom: plan.trackedFrom,
      outsideLedger: plan.outsideLedger,
      summary: plan.summary,
      bookings: plan.plans,
    });
  } catch (err) {
    next(err);
  }
});

/** What the workflow has done lately, newest first. */
router.get('/history', async (req, res, next) => {
  try {
    res.json({ sends: await recentSends(req.user.customerId, req.query.limit) });
  } catch (err) {
    next(err);
  }
});

/** One booking's whole ladder, for the drawer. */
router.get('/bookings/:bookingId', async (req, res, next) => {
  try {
    const club = req.user.customerId;
    const { rows } = await query(`SELECT ${BOOKING_SELECT} FROM public.bookings WHERE booking_id = $1 AND club = $2`, [
      req.params.bookingId,
      club,
    ]);
    if (!rows[0]) return res.status(404).json({ error: 'Booking not found' });

    // Planned through the club-wide pass rather than on its own, so one
    // booking's ladder is read exactly as a run would read it — same trade
    // attribution, same ledger, same today. No `playedSince`: the list view's
    // window must not hide a booking somebody asked for by reference.
    const plan = await planClub(club, { scope: 'all' });
    const theirs = plan.plans.find((entry) => entry.bookingId === req.params.bookingId);
    if (!theirs) {
      return res.json({
        today: plan.today,
        booking: serialiseBooking(rows[0]),
        plan: null,
        message: 'This booking is not on the ladder.',
      });
    }
    res.json({ today: plan.today, booking: serialiseBooking(rows[0]), plan: theirs });
  } catch (err) {
    next(err);
  }
});

/**
 * Climb what is due.
 *
 * `bookingIds` limits the run to those bookings; absent, every booking with
 * something due is run. `dryRun` walks the same path and stops short of the
 * send, so a preview reports exactly what a real run would do.
 */
router.post('/run', async (req, res, next) => {
  const { bookingIds = null, dryRun = false } = req.body ?? {};
  if (bookingIds !== null && !Array.isArray(bookingIds)) {
    return res.status(400).json({ error: 'bookingIds must be an array, or absent for every booking that is due' });
  }
  if (Array.isArray(bookingIds) && bookingIds.length > MAX_RUN) {
    return res.status(400).json({ error: `Too many bookings in one run (max ${MAX_RUN}).` });
  }

  try {
    const config = await clubTriggerConfig(req.user.customerId);
    if (!config.enabled) {
      return res.status(409).json({
        error: config.locked
          ? 'The workflow is switched off in the environment (TRIGGER_WORKFLOW=false).'
          : 'Chasing is switched off for this club. Turn it on under Settings.',
      });
    }
    if (!dryRun && !triggerReady(config)) {
      return res.status(409).json({ error: `The workflow cannot send. Missing: ${config.missing.join(', ')}.` });
    }

    res.json(
      await runTriggers({
        club: req.user.customerId,
        bookingIds: Array.isArray(bookingIds) ? bookingIds : null,
        dryRun: Boolean(dryRun),
        sentBy: req.user.username,
        reason: 'dashboard',
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Take rungs off the list without emailing anybody.
 *
 * Not every step is answered by an email. The club rings the operator, takes a
 * card payment over the phone, or decides this particular guest should not get
 * a chase — and without this the only way off the list is to send something, so
 * the list keeps showing work that has already been done, which is the fastest
 * way to teach people to stop reading a list.
 *
 * It writes the same ledger row a send writes, with outcome `cleared`, so the
 * rung is climbed and never fires later. Permanent rather than a week's quiet:
 * a rung of a ladder is a one-off event, and "we are not sending the 30-day
 * confirmation" does not become untrue in seven days.
 */
router.post('/clear', async (req, res, next) => {
  const { bookingId, steps } = req.body ?? {};
  if (!bookingId || typeof bookingId !== 'string') {
    return res.status(400).json({ error: 'bookingId is required' });
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'steps must be a non-empty array' });
  }
  const unknown = steps.filter((step) => !STEP_IDS.includes(step));
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown step(s): ${unknown.join(', ')}` });
  }

  try {
    const club = req.user.customerId;
    const plan = await planClub(club, { scope: 'all' });
    const theirs = plan.plans.find((entry) => entry.bookingId === bookingId);
    if (!theirs) return res.status(404).json({ error: 'Booking not found' });

    const results = [];
    for (const step of new Set(steps)) {
      const entry = theirs.steps.find((line) => line.step === step);
      if (entry?.state === 'sent') {
        results.push({ step, status: 'failed', message: 'Already done' });
        continue;
      }
      const id = await recordStep({
        club,
        bookingId,
        step,
        flow: theirs.flow,
        dueOn: entry?.dueOn ?? null,
        outcome: 'cleared',
        detail: 'Taken off the list by hand',
        sentBy: req.user.username,
      });
      results.push({
        step,
        status: id ? 'cleared' : 'failed',
        message: id ? 'Cleared without emailing' : 'Already recorded — refresh the list',
      });
    }

    res.json({ bookingId, today: todayInClubZone(), results });
  } catch (err) {
    next(err);
  }
});

/**
 * Run the scheduled pass now, across every club.
 *
 * Admin only, and it is the schedule's own pass rather than this club's: it is
 * here so somebody setting the workflow up can see whether the sweep works
 * without waiting a day for it, which is the question that actually gets asked.
 */
router.post('/sweep', requireAdmin, async (req, res, next) => {
  try {
    res.json(await sweepTriggers({ reason: 'dashboard' }));
  } catch (err) {
    next(err);
  }
});

/**
 * The one database fault worth explaining rather than hiding.
 *
 * Migrations are applied by hand before a deploy, so a database without 0026 is
 * the normal first state of this feature on a real install — and until now it
 * answered "Internal server error", which tells the club nothing and the one
 * person who could fix it nothing either. A router-level handler rather than a
 * check in each route: there are seven of them, and the eighth somebody adds
 * is covered without their having to remember.
 *
 * Everything else falls through to the app's own handler and keeps its 500.
 */
router.use((err, req, res, next) => {
  if (err instanceof LedgerMissingError || err instanceof SettingsMissingError) {
    return res.status(err.status).json({ error: err.message, migration: err.migration });
  }
  return next(err);
});

export default router;
