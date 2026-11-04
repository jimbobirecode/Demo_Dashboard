/**
 * The booking trigger workflow: the club's lifecycle ladder, as rules.
 *
 * The two campaigns in `email-domain.js` each sit on one date — three days
 * before play, two days after. The club's actual journey is longer than that
 * and it branches: a booking is taken, a payment link goes out, and what
 * happens next depends entirely on whether the money arrives and when. Paid,
 * and it climbs a ladder of confirmations to the tee. Not paid, and it climbs a
 * different one, of warnings, towards cancellation — and can step back onto the
 * first at any point by paying.
 *
 * The ladder as the club specified it, with the trigger numbers it uses:
 *
 *   PAYMENT PHASE, counted from the day the booking was confirmed
 *     T1  day 0   payment link, to secure the booking within 7 days
 *     T1  day 5   reminder, warning of cancellation
 *     T1  day 6   24 hours before the window closes
 *     T2  day 7   window closed — cancellation, with a chance to rescue it
 *     T3  day 8   48 hours before the rescue window closes
 *     T3  day 9   24 hours before it closes
 *     T3  day 10  cancellation issued, the booking comes off the sheet
 *
 *   ...and the moment money arrives, the same phase instead produces a thank
 *   you with the terms for the next stage, and the unpaid rungs stop matching.
 *
 *   BALANCE PHASE, counted back from the play date (trade bookings)
 *     T2  70 days  deposit is in: ten days left to settle the balance
 *     T3  62 days  48 hours before the balance deadline
 *     T3  61 days  24 hours before it
 *     T3  60 days  balance deadline — cancellation, or, where it is paid,
 *                  the thank you that closes the payment phase and opens
 *                  the communication one
 *
 *   COMMUNICATION PHASE, counted back from the play date
 *     T4  30 days  confirmation, with the information for the round
 *     T5  10 days  final summary and arrival details
 *         play day nothing is sent; the club is busy playing golf
 *         +24h     thank you, with the post-play details and offers
 *
 * Everything here is pure: which ladder a booking is on, which rung falls due
 * today, and what the email says are all derived from a serialised booking, its
 * trade account and a date. `booking-trigger-runner.js` does the I/O, and
 * `booking-trigger-sweep.js` decides when to ask.
 *
 * Two choices in here are worth reading before changing anything:
 *
 * The CATCH-UP HORIZON. A rung is due only within a few days of its date. Half
 * of this ladder fires on dates that are in the past for most of a club's
 * table, so without a horizon the first run after switching the workflow on
 * would email a year of history its deadlines. Older rungs are reported as
 * missed, where a person can see them and decide, and are never sent by the
 * schedule.
 *
 * COLLAPSING. At most one email per booking per run. A booking whose deposit
 * ladder has run away from it has several rungs inside the horizon at once, and
 * a guest must not receive a reminder and a final notice in the same minute.
 * The furthest-advanced rung goes; the ones it passed are recorded as
 * superseded, so they are climbed rather than left to fire late.
 */
import { BRAND } from './brand.js';
import { CLOCK_STARTING_PAYMENTS, addDays, cleanEmail, todayInClubZone } from './email-domain.js';
import {
  CLOSED_PAYMENT_STATUSES,
  DEFAULT_TERMS,
  dueDatesFor,
  inPaymentLedger,
  normalisePaymentStatus,
  stageSplit,
} from './operators-domain.js';

/** The two ladders. Which one a booking is on is decided by its trade account. */
export const FLOWS = {
  tour_operator: {
    id: 'tour_operator',
    label: 'Tour operator',
    /** How the club describes the recipient in its own notes. */
    audience: 'trade partner',
  },
  visitor: {
    id: 'visitor',
    label: 'Visitor',
    audience: 'guest',
  },
};

export const FLOW_IDS = Object.keys(FLOWS);

/**
 * Where a step's date is counted from.
 *
 *   booked     days after the booking was confirmed
 *   paid       the moment money arrived; no waiting
 *   play       days before the play date
 *   post_play  hours after the tee time
 */
export const ANCHORS = ['booked', 'paid', 'play', 'post_play'];

/** What a booking's money has to look like for a step to apply. */
export const CONDITIONS = {
  /** Nothing has been received, and there is a figure to receive. */
  unpaid: 'Nothing paid',
  /** Some money is in and some is still owed. */
  part_paid: 'Deposit paid, balance outstanding',
  /** Nothing further is owed. */
  settled: 'Paid in full',
  /** Money has been received, whether or not it covers the lot. */
  secured: 'Secured by a payment',
  /** The money does not come into it. */
  any: 'Any payment state',
};

/**
 * The club's deadlines, in days. Every step's date is derived from these
 * rather than configured one by one: the ladder is a shape, and moving the
 * deposit window from 7 days to 14 should move the whole ladder with it.
 */
export const DEFAULT_SCHEDULE = {
  /** Days from booking in which the deposit secures the tee time. */
  depositDays: 7,
  /** The day inside that window the first chase goes out. */
  depositReminderDay: 5,
  /** Days after the window closes before the booking is cancelled. */
  depositGraceDays: 3,
  /** Days before play the balance notice goes out. */
  balanceNoticeDays: 70,
  /** Days before play the balance must be settled. */
  balanceDeadlineDays: 60,
  /** Days before play the confirmation goes out. */
  confirmationDays: 30,
  /** Days before play the final details go out. */
  finalDetailsDays: 10,
  /** Hours after the tee time the thank you goes out. */
  postPlayHours: 24,
  /** How many days late a step may be and still go out. */
  catchUpDays: 3,
};

/** The environment names for each of them. */
const SCHEDULE_ENV = {
  depositDays: 'TRIGGER_DEPOSIT_DAYS',
  depositReminderDay: 'TRIGGER_DEPOSIT_REMINDER_DAY',
  depositGraceDays: 'TRIGGER_DEPOSIT_GRACE_DAYS',
  balanceNoticeDays: 'TRIGGER_BALANCE_NOTICE_DAYS',
  balanceDeadlineDays: 'TRIGGER_BALANCE_DEADLINE_DAYS',
  confirmationDays: 'TRIGGER_CONFIRMATION_DAYS',
  finalDetailsDays: 'TRIGGER_FINAL_DETAILS_DAYS',
  postPlayHours: 'TRIGGER_POST_PLAY_HOURS',
  catchUpDays: 'TRIGGER_CATCH_UP_DAYS',
};

/** The schedule keys, in the order the settings page shows them. */
export const SCHEDULE_KEYS = Object.keys(DEFAULT_SCHEDULE);

/**
 * What a club may set each deadline to, and how the settings page names it.
 *
 * The bounds are wide on purpose: the orderings below are the real guard, and
 * a club that wants a 60-day deposit window is entitled to one.
 */
export const SETTING_BOUNDS = {
  depositDays: { min: 1, max: 365, label: 'Days to pay the deposit' },
  depositReminderDay: { min: 0, max: 364, label: 'Day of the first deposit reminder' },
  depositGraceDays: { min: 2, max: 365, label: 'Days between the deadline and cancellation' },
  balanceNoticeDays: { min: 1, max: 365, label: 'Days before play for the balance notice' },
  balanceDeadlineDays: { min: 0, max: 364, label: 'Days before play the balance is due' },
  confirmationDays: { min: 1, max: 365, label: 'Days before play for the confirmation' },
  finalDetailsDays: { min: 0, max: 364, label: 'Days before play for the arrival details' },
  postPlayHours: { min: 0, max: 720, label: 'Hours after the round for the thank you' },
  catchUpDays: { min: 0, max: 365, label: 'Catch-up limit' },
};

/**
 * The three switches, as the club saves them. `enabled` is "chase our
 * bookings", `automatic` is "without anybody pressing Send", `autoCancel` is
 * "and cancel what never pays".
 */
export const SWITCH_SETTINGS = ['enabled', 'automatic', 'autoCancel'];

const SWITCH_LABELS = {
  enabled: 'Chase unpaid bookings',
  automatic: 'Send on a schedule',
  autoCancel: 'Cancel automatically',
};

/**
 * The ladder, in the order it is climbed.
 *
 * `offset` is resolved against the schedule by `stepsFor`, so a step says
 * which deadline it hangs off rather than carrying a number of its own.
 *
 * `legacyColumn` is for the two steps that existed before this engine did. The
 * post-play thank you is already a campaign on the Guest Emails page, and the
 * receipt is already sent by the Stripe webhook; both write a stamp on the
 * booking, and this engine reads those stamps as the rung being climbed. That
 * is the whole reason they are listed here: so switching the workflow on does
 * not send a guest a second copy of an email they have already had.
 */
const STEP_DEFINITIONS = [
  // --- Payment phase: securing the booking ---------------------------------
  {
    id: 'deposit_request',
    label: 'Payment link to secure the booking',
    trigger: 'Trigger 1',
    group: 'payment',
    anchor: 'booked',
    offset: () => 0,
    condition: 'unpaid',
    flows: FLOW_IDS,
    /** Needs a Stripe link, not just an email. See the runner. */
    action: 'payment_link',
  },
  {
    id: 'deposit_reminder',
    label: 'Deposit reminder, warning of cancellation',
    trigger: 'Trigger 1',
    group: 'payment',
    anchor: 'booked',
    offset: (s) => s.depositReminderDay,
    condition: 'unpaid',
    flows: FLOW_IDS,
    action: 'email',
  },
  {
    id: 'deposit_final_notice',
    label: 'Deposit reminder, 24 hours before the window closes',
    trigger: 'Trigger 1',
    group: 'payment',
    anchor: 'booked',
    offset: (s) => s.depositDays - 1,
    condition: 'unpaid',
    flows: FLOW_IDS,
    action: 'email',
  },
  {
    id: 'deposit_overdue',
    label: 'Deposit window closed — cancellation, with a chance to rescue it',
    trigger: 'Trigger 2',
    group: 'payment',
    anchor: 'booked',
    offset: (s) => s.depositDays,
    condition: 'unpaid',
    flows: FLOW_IDS,
    action: 'email',
  },
  {
    id: 'deposit_rescue_48h',
    label: 'Rescue reminder, 48 hours before cancellation',
    trigger: 'Trigger 3',
    group: 'payment',
    anchor: 'booked',
    offset: (s) => s.depositDays + s.depositGraceDays - 2,
    condition: 'unpaid',
    flows: FLOW_IDS,
    action: 'email',
  },
  {
    id: 'deposit_rescue_24h',
    label: 'Rescue reminder, 24 hours before cancellation',
    trigger: 'Trigger 3',
    group: 'payment',
    anchor: 'booked',
    offset: (s) => s.depositDays + s.depositGraceDays - 1,
    condition: 'unpaid',
    flows: FLOW_IDS,
    action: 'email',
  },
  {
    id: 'deposit_lapsed',
    label: 'Cancellation issued, booking released',
    trigger: 'Trigger 3',
    group: 'payment',
    anchor: 'booked',
    offset: (s) => s.depositDays + s.depositGraceDays,
    condition: 'unpaid',
    flows: FLOW_IDS,
    /** Emails the guest AND takes the booking off the sheet. */
    action: 'cancel',
  },

  // --- Payment phase: the money arrived ------------------------------------
  {
    id: 'deposit_receipt',
    label: 'Thank you for the payment, with the terms for the next stage',
    trigger: 'Payment trigger 2',
    group: 'payment',
    anchor: 'paid',
    offset: () => 0,
    condition: 'secured',
    flows: FLOW_IDS,
    action: 'email',
    /** Already sent by the Stripe webhook; see the note above. */
    legacyColumn: 'paymentReceiptSentAt',
  },

  // --- Balance phase (trade bookings) --------------------------------------
  {
    id: 'balance_notice',
    label: 'Ten days left to settle the balance',
    trigger: 'Trigger 2',
    group: 'payment',
    anchor: 'play',
    offset: (s) => s.balanceNoticeDays,
    condition: 'part_paid',
    flows: ['tour_operator'],
    /** A fresh link: the one issued for the deposit asks the wrong amount. */
    action: 'payment_link',
  },
  {
    id: 'balance_rescue_48h',
    label: 'Balance reminder, 48 hours before the deadline',
    trigger: 'Trigger 3',
    group: 'payment',
    anchor: 'play',
    offset: (s) => s.balanceDeadlineDays + 2,
    condition: 'part_paid',
    flows: ['tour_operator'],
    action: 'email',
  },
  {
    id: 'balance_rescue_24h',
    label: 'Balance reminder, 24 hours before the deadline',
    trigger: 'Trigger 3',
    group: 'payment',
    anchor: 'play',
    offset: (s) => s.balanceDeadlineDays + 1,
    condition: 'part_paid',
    flows: ['tour_operator'],
    action: 'email',
  },
  {
    id: 'balance_lapsed',
    label: 'Balance deadline passed — cancellation issued, booking released',
    trigger: 'Trigger 3',
    group: 'payment',
    anchor: 'play',
    offset: (s) => s.balanceDeadlineDays,
    condition: 'part_paid',
    flows: ['tour_operator'],
    action: 'cancel',
  },

  // --- Communication phase -------------------------------------------------
  {
    id: 'booking_confirmed',
    label: 'Paid in full — the booking is confirmed',
    trigger: 'Trigger 3',
    group: 'communication',
    anchor: 'play',
    offset: (s) => s.balanceDeadlineDays,
    condition: 'settled',
    flows: FLOW_IDS,
    action: 'email',
  },
  {
    id: 'pre_arrival_confirmation',
    label: 'Confirmation with the information for the round',
    trigger: 'Trigger 4',
    group: 'communication',
    anchor: 'play',
    offset: (s) => s.confirmationDays,
    condition: 'secured',
    flows: FLOW_IDS,
    action: 'email',
  },
  {
    id: 'final_details',
    label: 'Final summary and arrival details',
    trigger: 'Trigger 5',
    group: 'communication',
    anchor: 'play',
    offset: (s) => s.finalDetailsDays,
    condition: 'secured',
    flows: FLOW_IDS,
    action: 'email',
  },
  {
    id: 'post_play',
    label: 'Thank you, with the post-play details and offers',
    trigger: 'Post play',
    group: 'communication',
    anchor: 'post_play',
    offset: (s) => s.postPlayHours,
    condition: 'any',
    flows: FLOW_IDS,
    action: 'email',
    /** The Guest Emails page's own post-play campaign writes this. */
    legacyColumn: 'postPlayEmailSentAt',
  },
];

/** Every step id, in ladder order. */
export const STEP_IDS = STEP_DEFINITIONS.map((step) => step.id);

/**
 * The ladder with each step's date resolved against the schedule, and its
 * position recorded — the position is what collapsing compares.
 */
export function stepsFor(schedule = DEFAULT_SCHEDULE, flow = null) {
  return STEP_DEFINITIONS.filter((step) => !flow || step.flows.includes(flow)).map((step) => ({
    ...step,
    order: STEP_IDS.indexOf(step.id),
    days: step.offset(schedule),
  }));
}

/**
 * One step, with its date resolved against `schedule`.
 *
 * The schedule is an argument rather than a default read inside, because a club
 * that has moved its deposit window must not get a step whose `days` came from
 * somebody else's deadlines. `DEFAULT_SCHEDULE` is the fallback for a caller
 * that only wants the step's identity.
 */
export function getStep(id, schedule = DEFAULT_SCHEDULE) {
  const step = STEP_DEFINITIONS.find((entry) => entry.id === id);
  return step ? { ...step, order: STEP_IDS.indexOf(id), days: step.offset(schedule) } : null;
}

/**
 * The workflow as this club has it, secret reduced to a yes/no — this shape is
 * handed to the browser.
 *
 * `stored` is what the club saved on its Settings page (migration 0027): any
 * key present there wins over the environment, and any key absent inherits it.
 * The precedence is saved, then environment, then the defaults above.
 *
 * Nothing about it is on by default. `TRIGGER_WORKFLOW=true` lets a person run
 * it from the page; `TRIGGER_WORKFLOW_AUTO=true` additionally lets the schedule
 * run it unattended. Two switches rather than one because they are different
 * decisions: the first is "these are our deadlines", the second is "send to our
 * guests without anybody reading it first", and a club should be able to make
 * the first and watch what it would do for a week before making the second.
 */
export function readTriggerConfig(env = process.env, stored = {}) {
  const saved = stored && typeof stored === 'object' ? stored : {};
  const schedule = { ...DEFAULT_SCHEDULE };
  for (const [key, name] of Object.entries(SCHEDULE_ENV)) {
    schedule[key] = positiveInt(saved[key], positiveInt(env[name], DEFAULT_SCHEDULE[key]));
  }

  // The deployer's last word. TRIGGER_WORKFLOW set to an explicit "false"
  // (as against unset) is a kill switch no club setting can lift: it is how
  // a staging copy of a live database is kept from emailing real guests.
  const locked = isOff(env.TRIGGER_WORKFLOW);
  const enabled = !locked && pick(saved.enabled, isOn(env.TRIGGER_WORKFLOW));
  const automatic = enabled && pick(saved.automatic, isOn(env.TRIGGER_WORKFLOW_AUTO));
  const autoCancel = pick(saved.autoCancel, isOn(env.TRIGGER_WORKFLOW_AUTO_CANCEL));

  const templates = {};
  for (const step of STEP_DEFINITIONS) {
    templates[step.id] = env[templateEnvFor(step.id)] ?? null;
  }

  const missing = [];
  if (!env.SENDGRID_API_KEY) missing.push('SENDGRID_API_KEY');
  if (!env.FROM_EMAIL) missing.push('FROM_EMAIL');

  return {
    enabled,
    /** Whether the background sweep may send, as opposed to only a person. */
    automatic,
    /** True when the environment has forbidden the workflow outright. */
    locked,
    /** Which keys came from the club rather than the environment. */
    saved: Object.keys(saved).filter((key) => SWITCH_SETTINGS.includes(key) || key in DEFAULT_SCHEDULE),
    /**
     * Whether a lapse step may cancel a booking on its own.
     *
     * Off by default, and deliberately a switch of its own. Cancelling is the
     * one rung that does something to the club's own tee sheet rather than to
     * somebody's inbox, and it is not undone by apologising. With it off the
     * step still falls due, is still listed, and still emails nobody: a person
     * reads it and cancels the booking themselves.
     */
    autoCancel,
    hasApiKey: Boolean(env.SENDGRID_API_KEY),
    apiKey: env.SENDGRID_API_KEY ?? null,
    fromEmail: env.FROM_EMAIL ?? null,
    fromName: env.FROM_NAME ?? BRAND.fromName,
    schedule,
    /**
     * A SendGrid template per step, where the club has designed one. Absent,
     * the step's own branded email goes instead — see
     * `booking-trigger-emails.js`. That is the opposite default from the guest
     * campaigns, which refuse to send without a template: fifteen steps is
     * fifteen templates to build before anything works at all, and the ladder
     * has to be usable on the day it is switched on.
     */
    templates,
    missing,
    configured: missing.length === 0,
  };
}

/** `SENDGRID_TEMPLATE_TRIGGER_FINAL_DETAILS` for `final_details`. */
export function templateEnvFor(stepId) {
  return `SENDGRID_TEMPLATE_TRIGGER_${String(stepId).toUpperCase()}`;
}

/** Strips the key, for anything that crosses the wire. */
export function publicTriggerConfig(config) {
  const { apiKey, ...rest } = config;
  return {
    ...rest,
    steps: stepsFor(config.schedule).map((step) => ({
      id: step.id,
      label: step.label,
      trigger: step.trigger,
      group: step.group,
      anchor: step.anchor,
      days: step.days,
      condition: step.condition,
      conditionLabel: CONDITIONS[step.condition],
      flows: step.flows,
      action: step.action,
      templateEnv: templateEnvFor(step.id),
      templateId: config.templates[step.id] ?? null,
    })),
  };
}

/** Whether the workflow can send at all. */
export function triggerReady(config) {
  return config.enabled && config.hasApiKey && Boolean(config.fromEmail);
}

/**
 * Check a patch of settings from the Settings page.
 *
 * Returns `{ ok, errors, value }`, where `value` holds only the keys that were
 * given and passed. Unknown keys are dropped rather than refused, so an older
 * page talking to a newer server is not broken by a key it does not know.
 *
 * The orderings are checked against the settings as they would be AFTER this
 * save (`current` laid under the patch), not against the patch alone: a club
 * moving one deadline must not be told its untouched ones are wrong, nor be
 * allowed to walk one end of the ladder past the other.
 */
export function validateTriggerSettings(input, { current = {} } = {}) {
  const errors = [];
  const value = {};

  if (input === undefined || input === null) return { ok: true, errors, value };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Settings must be an object'], value };
  }

  for (const key of SWITCH_SETTINGS) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'boolean') {
      errors.push(`${SWITCH_LABELS[key]} must be true or false`);
      continue;
    }
    value[key] = raw;
  }

  for (const [key, bounds] of Object.entries(SETTING_BOUNDS)) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    const unit = key === 'postPlayHours' ? 'hours' : 'days';
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      errors.push(`${bounds.label} must be a whole number of ${unit}`);
      continue;
    }
    if (raw < bounds.min || raw > bounds.max) {
      errors.push(`${bounds.label} must be between ${bounds.min} and ${bounds.max} ${unit}`);
      continue;
    }
    value[key] = raw;
  }

  const after = { ...DEFAULT_SCHEDULE, ...current, ...value };
  if (after.depositReminderDay >= after.depositDays) {
    errors.push('The first deposit reminder must come before the deposit deadline');
  }
  if (after.depositGraceDays < 2) {
    errors.push('Leave at least two days between the deadline and cancellation, for the 48- and 24-hour notices');
  }
  if (after.balanceNoticeDays <= after.balanceDeadlineDays) {
    errors.push('The balance notice must go out before the balance is due');
  }
  if (after.finalDetailsDays >= after.confirmationDays) {
    errors.push('The arrival details must go out after the confirmation, nearer the play date');
  }

  return { ok: errors.length === 0, errors, value };
}

// --- reading a booking ------------------------------------------------------

/**
 * Which ladder this booking is on.
 *
 * A booking attributed to a trade account is on the operator ladder; everything
 * else is a visitor. The attribution has to be evidence the club can stand
 * behind — an assignment or a registered sending domain, never a name that
 * turned up in the body of an email — which is the same bar the operator
 * reminders apply, and for the same reason: the two ladders have different
 * deadlines, and guessing puts a guest on a trade partner's one.
 */
export function flowFor(booking, { operator = null, source = null } = {}) {
  if (operator && source !== 'name') return FLOWS.tour_operator.id;
  if (booking.tourOperatorId) return FLOWS.tour_operator.id;
  return FLOWS.visitor.id;
}

/**
 * Whether this account's bookings are chased for money at all.
 *
 * A retired account is never chased — that is the operator module's own
 * promise — and a trading one can be taken out of the chase with its
 * `auto_chase` switch. Either way the round-up to the tee still goes to the
 * guest: it is the bill the club has chosen not to press, not the welcome.
 */
export function chaseable(operator) {
  if (!operator) return true;
  if (operator.active === false) return false;
  return operator.autoChase !== false;
}

/**
 * Who a step's email goes to.
 *
 * Money goes to the account. The operator form's own words for the contact
 * email are "where reminders are sent", and a tour operator's guest neither
 * holds the purse nor should be told the operator is late. The run-up to the
 * tee goes to whoever is playing, which is what the booking's email is.
 */
export function recipientFor(step, booking, operator = null) {
  const guest = cleanEmail(booking.guestEmail) || null;
  if (operator && step.group === 'payment') {
    return cleanEmail(operator.contactEmail) || guest;
  }
  return guest;
}

/**
 * The day the payment clock started: the day the booking was confirmed.
 *
 * `bookedAt` is stamped when the status reaches Booked (migration 0025). Where
 * there is none — a booking confirmed before that column existed, or one
 * written already Booked by the email bot — the enquiry's own timestamp stands
 * in, exactly as `paymentState` does it for the deposit due date. The two must
 * agree: a ladder that chases on one date while the booking's payment panel
 * shows another is a ladder nobody trusts.
 */
export function securedClockStart(booking) {
  return dayOf(booking.bookedAt) ?? dayOf(booking.timestamp) ?? null;
}

/** The day money first arrived, as far as the record shows. */
export function paidClockStart(booking) {
  return dayOf(booking.stripePaidAt) ?? dayOf(booking.prePlayClockStartedAt) ?? null;
}

/**
 * What this booking's money looks like, in the terms the conditions are
 * written in.
 *
 * `tracked` is the one that silences everything. A booking taken before the
 * club started recording payments has no balance to speak of — see
 * `inPaymentLedger` — so chasing it would be the arithmetic talking, and the
 * email would demand money that may well have arrived by bank transfer a year
 * ago. Such a booking still climbs the communication ladder, which is about
 * the round rather than the bill.
 */
export function moneyState(booking, { tracking = null, operator = null } = {}) {
  const gross = round2(Number(booking.total) || 0);
  const paid = round2(Number(booking.amountPaid) || 0);
  const status = normalisePaymentStatus(booking.paymentStatus);
  const closed = CLOSED_PAYMENT_STATUSES.includes(status);
  const tracked = tracking === null || inPaymentLedger(booking, tracking);

  // The two milestones, under this booking's own terms. An account that holds
  // a round on 30% owes 30% today, not the lot, and the chase emails ask for
  // `dueAmount` for exactly that reason -- it is the same figure the Stripe
  // link is made out for. A booking with no operator has no deposit
  // percentage, so its one milestone is the whole amount, as it always was.
  const terms = operator ?? DEFAULT_TERMS;
  const split = stageSplit({ gross, paid, closed, depositPercent: terms.depositPercent, status });
  const { outstanding } = split;

  // A payment status staff typed in counts as money arriving even where no
  // figure was recorded against it: 'Paid' on a booking with amount_paid 0 is
  // somebody saying it is settled, and the ladder must not chase it.
  const secured = paid > 0.005 || CLOCK_STARTING_PAYMENTS.includes(status) || closed;

  return {
    ...split,
    gross,
    paid,
    outstanding,
    status,
    closed,
    tracked,
    secured,
    settled: closed || (secured && outstanding <= 0.005),
    /** Nothing in, and a figure to ask for. */
    empty: !secured && gross > 0.005,
  };
}

/** Whether a step's condition holds for this booking's money. */
export function conditionHolds(condition, money) {
  switch (condition) {
    case 'unpaid':
      return money.tracked && money.empty;
    case 'part_paid':
      return money.tracked && money.secured && !money.settled && money.outstanding > 0.005;
    case 'settled':
      return money.settled;
    case 'secured':
      return money.secured;
    case 'any':
      return true;
    default:
      return false;
  }
}

/**
 * The calendar day a step falls due for this booking, or null when it cannot
 * be worked out (no play date, no booking date, no tee time to count from).
 */
export function dueDateFor(
  step,
  booking,
  { schedule = DEFAULT_SCHEDULE, timeZone = BRAND.timeZone, operator = null } = {},
) {
  const days = step.days ?? step.offset(schedule);

  switch (step.anchor) {
    case 'booked': {
      const start = securedClockStart(booking);
      if (!start) return null;
      // A trade account is chased by its own credit terms, not by the club's
      // default window: a "days before play" rule where it has one, otherwise
      // net terms from the day the booking was taken. The whole deposit ladder
      // slides so its deadline rung lands on the account's date, and nothing
      // is asked for before the booking was made.
      //
      // The date comes from `dueDatesFor`, which is also what the payment
      // columns and the Stripe link are drawn from. Working it out again here
      // is how the ladder came to cancel bookings on a date no screen showed.
      const deadline = operator ? dueDatesFor(booking, operator).depositDue : null;
      if (step.group === 'payment' && deadline) {
        const due = addDays(deadline, days - schedule.depositDays);
        return due < start ? start : due;
      }
      return addDays(start, days);
    }
    case 'paid': {
      const start = paidClockStart(booking);
      if (start) return addDays(start, days);
      // Money is in but nothing records when. Both the dashboard and the Stripe
      // webhook stamp the clock as they record a payment, so this is a booking
      // paid before that column existed -- and the honest answer is that the
      // payment cannot be dated. Counting from the booking instead puts the
      // receipt outside the catch-up horizon, where it reads as missed and
      // nothing is sent: "thank you for your payment" about a payment that may
      // have arrived a year ago is worse than silence.
      return securedClockStart(booking) ?? null;
    }
    case 'play': {
      if (!booking.date) return null;
      // Likewise the balance: an account whose terms say 45 days before play
      // has its notice, its warnings and its deadline counted to that date.
      const lead = operator?.balanceDueDaysBeforePlay;
      const shifted = lead != null && (step.group === 'payment' || step.id === 'booking_confirmed');
      const shift = shifted ? schedule.balanceDeadlineDays - lead : 0;
      return addDays(booking.date, -(days - shift));
    }
    case 'post_play': {
      const at = postPlayDueAt(booking, days);
      return at ? dayInZone(at, timeZone) : null;
    }
    default:
      return null;
  }
}

/**
 * The instant the post-play thank you falls due: the tee time plus `hours`.
 *
 * The tee time is read as the club's own local time and the offset applied in
 * hours, which is near enough: the club plays in one time zone, the offset is a
 * day, and an hour of summer time either side of it does not change which day
 * the email lands on. A booking with no usable tee time counts from midday,
 * because a round is played in the day and midday is the least wrong guess.
 */
export function postPlayDueAt(booking, hours = DEFAULT_SCHEDULE.postPlayHours) {
  if (!booking.date) return null;
  const minutes = parseTeeTime(booking.teeTime) ?? 12 * 60;
  const base = new Date(`${booking.date}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  return new Date(base.getTime() + (minutes + hours * 60) * 60_000);
}

/**
 * Minutes past midnight from a stored tee time, or null.
 *
 * Tee sheets write them every way there is: '14:30', '2:30 PM', '9.10am',
 * 'Not Specified'. Only the ones that mean a time are read.
 */
export function parseTeeTime(value) {
  const text = String(value ?? '')
    .trim()
    .toUpperCase();
  if (!text || text === 'NOT SPECIFIED' || text === 'TBD') return null;

  const match = text.match(/^(\d{1,2})[:.](\d{2})\s*(AM|PM)?$/) ?? text.match(/^(\d{1,2})\s*(AM|PM)$/);
  if (!match) return null;

  // The two-group form ('9AM') has the meridiem where the minutes would be.
  const hasMinutes = match.length === 4;
  let hour = Number(match[1]);
  const minute = hasMinutes ? Number(match[2]) : 0;
  const meridiem = hasMinutes ? match[3] : match[2];

  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;

  return hour * 60 + minute;
}

/** Why this booking cannot be in the workflow at all, or null. */
/**
 * The club's own email domains: the address it sends from and the one it
 * asks for replies at, and any listed in CLUB_EMAIL_DOMAINS.
 *
 * A booking the office makes on a guest's behalf is often filed under the
 * office's own address, because that is where the request came from. The
 * ladder then wrote to the club: reservations@countylouthgolfclub.com was
 * sent five deposit reminders and a cancellation warning about Lorraine
 * Hughes's round in five days. Nothing goes to these domains; the booking
 * needs the guest's or the account's address before it can be chased.
 */
export function clubOwnDomains(env = process.env) {
  const domains = new Set();
  for (const address of [env.FROM_EMAIL, env.REPLY_TO_EMAIL]) {
    const at = String(address ?? '')
      .trim()
      .toLowerCase()
      .split('@');
    if (at.length === 2 && at[1]) domains.add(at[1]);
  }
  for (const domain of String(env.CLUB_EMAIL_DOMAINS ?? '').split(',')) {
    const clean = domain.trim().toLowerCase().replace(/^@/, '');
    if (clean) domains.add(clean);
  }
  return domains;
}

/** Whether `email` is one of the club's own addresses. */
export function isClubsOwnAddress(email, ownDomains = clubOwnDomains()) {
  const domain = String(email ?? '')
    .trim()
    .toLowerCase()
    .split('@')[1];
  return Boolean(domain) && ownDomains.has(domain);
}

export function workflowProblem(booking, operator = null) {
  if (!booking.bookingId) return 'Missing booking reference';
  if (!booking.date) return 'No play date';
  if (booking.status !== 'Booked') return `A ${String(booking.status).toLowerCase()} booking is not on the ladder`;
  if (!cleanEmail(booking.guestEmail) && !cleanEmail(operator?.contactEmail)) return 'No guest email address';
  return null;
}

// --- selection --------------------------------------------------------------

/**
 * Every step of every booking, with what the workflow would do about it today.
 *
 * `sent` is the ledger: a Map of `bookingId` to a Set of step ids already
 * climbed. `scope` chooses how much comes back — 'due' is what a run would
 * send, 'all' is the whole ladder for every booking, which is what the page
 * draws so the club can see where each booking has got to.
 *
 * States, in the order they are decided:
 *
 *   sent        the rung is in the ledger, or its legacy stamp is set
 *   blocked     the booking cannot be emailed at all (no address, cancelled)
 *   skipped     the condition does not hold, so this rung is not this
 *               booking's to climb — a paid booking's chase ladder, for one
 *   due         the date has come and is inside the catch-up horizon
 *   missed      the date has come and gone past the horizon
 *   upcoming    the date has not come
 *   unknown     no date could be worked out
 */
export function planBooking(
  booking,
  {
    today = todayInClubZone(),
    now = new Date(),
    schedule = DEFAULT_SCHEDULE,
    tracking = null,
    operator = null,
    source = null,
    sent = new Set(),
    ownDomains = clubOwnDomains(),
  } = {},
) {
  const flow = flowFor(booking, { operator, source });
  const money = moneyState(booking, { tracking, operator });
  const blocker = workflowProblem(booking, operator);
  const chased = chaseable(operator);
  const steps = [];

  for (const step of stepsFor(schedule, flow)) {
    const dueOn = dueDateFor(step, booking, { schedule, operator });
    const to = recipientFor(step, booking, operator);
    const legacySentAt = step.legacyColumn ? booking[step.legacyColumn] : null;
    const entry = {
      step: step.id,
      label: step.label,
      trigger: step.trigger,
      group: step.group,
      action: step.action,
      condition: step.condition,
      to,
      dueOn,
      daysLate: dueOn ? dayGap(dueOn, today) : null,
      state: 'upcoming',
      reason: null,
    };

    if (sent.has(step.id)) {
      entry.state = 'sent';
      entry.reason = 'Already done';
    } else if (legacySentAt) {
      entry.state = 'sent';
      entry.reason = 'Already sent by the campaign that predates the workflow';
    } else if (blocker) {
      entry.state = 'blocked';
      entry.reason = blocker;
    } else if (!to) {
      entry.state = 'blocked';
      entry.reason = 'No guest email address';
    } else if (isClubsOwnAddress(to, ownDomains)) {
      entry.state = 'blocked';
      entry.reason = "Addressed to the club's own inbox. Add the guest's or the account's address to send this";
    } else if (step.group === 'payment' && !chased) {
      entry.state = 'skipped';
      entry.reason = operator?.active === false ? 'A retired account is not chased' : 'This account is not chased';
    } else if (!conditionHolds(step.condition, money)) {
      entry.state = 'skipped';
      entry.reason = money.tracked ? CONDITIONS[step.condition] : 'Outside the payment ledger';
    } else if (!dueOn) {
      entry.state = 'unknown';
      entry.reason = `No date to count ${step.anchor === 'play' ? 'back from' : 'from'}`;
    } else if (step.anchor === 'post_play' && now < postPlayDueAt(booking, step.days)) {
      entry.state = 'upcoming';
      entry.reason = 'The round has not finished';
    } else if (dueOn > today) {
      entry.state = 'upcoming';
      entry.reason = `Due ${dueOn}`;
    } else if (entry.daysLate > schedule.catchUpDays) {
      entry.state = 'missed';
      entry.reason = `${entry.daysLate} days past its date — too late to send unprompted`;
    } else {
      entry.state = 'due';
      entry.reason = entry.daysLate > 0 ? `${entry.daysLate} day(s) late` : 'Due today';
    }

    steps.push(entry);
  }

  // At most one email per booking per run. The furthest-advanced due rung
  // goes; the earlier ones it passed are climbed as superseded, so they never
  // fire a day later as a reminder about a deadline that has already expired.
  const due = steps.filter((entry) => entry.state === 'due');
  if (due.length > 1) {
    const winner = due[due.length - 1];
    for (const entry of due) {
      if (entry === winner) continue;
      entry.state = 'superseded';
      entry.reason = `Passed by "${winner.label}", which is due as well`;
    }
  }

  return {
    bookingId: booking.bookingId,
    club: booking.club ?? null,
    flow,
    guestName: booking.guestName || '',
    guestEmail: cleanEmail(booking.guestEmail),
    date: booking.date,
    teeTime: booking.teeTime,
    players: booking.players,
    status: booking.status,
    operatorName: operator?.name ?? booking.operatorName ?? null,
    /** Where the money emails go, when the account has an address of its own. */
    contactEmail: operator ? cleanEmail(operator.contactEmail) || null : null,
    chased,
    money,
    blocker,
    steps,
    /** What a run would do about this booking right now. */
    next: steps.find((entry) => entry.state === 'due') ?? null,
    superseded: steps.filter((entry) => entry.state === 'superseded'),
  };
}

/**
 * The whole table planned, with the bookings that have nothing to say left out.
 *
 * `scope: 'due'` keeps only the bookings a run would touch — something due, or
 * something to record as superseded. `scope: 'missed'` keeps the ones whose
 * rungs went past unsent, which is the list somebody reads after switching the
 * workflow on. `scope: 'all'` keeps every live booking.
 */
export function planBookings(bookings, { scope = 'due', sent = new Map(), ...options } = {}) {
  const plans = bookings
    .filter((booking) => booking.bookingId)
    .map((booking) =>
      planBooking(booking, {
        ...options,
        operator: options.operators?.get?.(booking.bookingId)?.operator ?? null,
        source: options.operators?.get?.(booking.bookingId)?.source ?? null,
        sent: sent.get(booking.bookingId) ?? new Set(),
      }),
    );

  const kept =
    scope === 'all'
      ? plans
      : scope === 'missed'
        ? plans.filter((plan) => plan.steps.some((entry) => entry.state === 'missed'))
        : plans.filter((plan) => plan.next || plan.superseded.length);

  // Soonest play date first: the round closest to happening is the one a
  // delayed email hurts most.
  return kept.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.bookingId.localeCompare(b.bookingId));
}

/** How the page summarises a planned run, without walking it itself. */
export function summarisePlans(plans) {
  const counts = {};
  let emails = 0;
  let cancellations = 0;
  for (const plan of plans) {
    for (const entry of plan.steps) {
      counts[entry.state] = (counts[entry.state] ?? 0) + 1;
    }
    if (plan.next) {
      if (plan.next.action === 'cancel') cancellations += 1;
      else emails += 1;
    }
  }
  return { bookings: plans.length, emails, cancellations, counts };
}

// --- helpers ----------------------------------------------------------------

function dayOf(value) {
  if (!value) return null;
  const text = String(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function dayInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function dayGap(from, to) {
  if (!from || !to) return 0;
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

function isOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function isOff(value) {
  return /^(0|false|no|off)$/i.test(String(value ?? '').trim());
}

/** A saved boolean wins over the environment; anything else inherits. */
function pick(saved, inherited) {
  return typeof saved === 'boolean' ? saved : inherited;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
