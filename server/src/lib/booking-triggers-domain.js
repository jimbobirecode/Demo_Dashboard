/**
 * The booking lifecycle, as rules rather than as a mailing schedule.
 *
 * The club's spreadsheet draws a grid: five triggers across, three lanes down
 * (the dunning, its resolution, then the run-up to the tee), and every cell
 * headed "If Paid" or "If not Paid". What it describes is not a calendar of
 * emails but a branching lifecycle — a booking is taken, a payment link goes
 * out, and what happens next depends on whether the money arrives and when.
 * Paid, it climbs a ladder of confirmations to the tee. Unpaid, a different
 * one towards cancellation.
 *
 * So the ladder is written as rungs, each with a condition, and the branch
 * falls out of evaluating them. The sheet's "if payment made revert to the if
 * Paid process" needs no jump and no state machine: the unpaid rungs simply
 * stop matching once the money is in, and the paid ones start.
 *
 * Everything here is pure, like `email-domain.js` next to it: the decisions
 * worth being sure about — which rung is due, on what day, for which booking,
 * and whether it may send — should be testable without a database, an API key
 * or a clock.
 */
import { CLOSED_PAYMENT_STATUSES, DEFAULT_TERMS, paymentState } from './operators-domain.js';
import { addDays, todayInClubZone } from './email-domain.js';

/** The lanes of the sheet, in the order a booking meets them. */
export const PHASES = ['payment', 'balance', 'communication'];

/**
 * How many days of history a first run may act on.
 *
 * Without this the first run after switching on would work through a year of
 * bookings whose own deadlines passed long ago, and email all of them at once
 * — a year of "your booking is cancelled" in one morning. A rung that fell
 * due longer ago than this is recorded as superseded and never sent.
 */
export const DEFAULT_CATCH_UP_DAYS = 3;

/** The sheet's own numbers, every one of them overridable. */
export const LADDER_DEFAULTS = {
  /** Days from the booking to the deposit deadline: "within 7 days of booking". */
  depositWindowDays: 7,
  /** The first nudge, "after 5 days of booking". */
  depositReminderDay: 5,
  /** The second chance the sheet gives after the window closes, ending here. */
  depositRescueDay: 10,
  /** Days before play the balance is due, absent terms of the operator's own. */
  balanceDueDaysBeforePlay: 60,
  /** "70 day out, reminder that 10 days remaining": 10 days before the deadline. */
  balanceNoticeLeadDays: 10,
  /** The confirmation and the final details, from the sheet's columns. */
  confirmationDaysBeforePlay: 30,
  finalDetailsDaysBeforePlay: 10,
  /** "Post play 24 hours after tee time of play day". */
  postPlayDaysAfterPlay: 1,
};

/**
 * The money, read once, the way the rest of the dashboard reads it.
 *
 * `paymentState` already knows each operator's terms and the per-booking
 * overrides, and the Bookings drawer and the operator statement both bill off
 * it. The ladder uses the same function so that an email saying the balance is
 * due on the 12th cannot contradict the date on the screen beside it.
 */
export function moneyState(booking, operator, today) {
  return paymentState(booking, operator, { today, fallbackTerms: DEFAULT_TERMS });
}

/**
 * Has anything been paid at all?
 *
 * The distinction the sheet draws in every column header. A deposit counts:
 * the unpaid ladder is about a booking nobody has put money behind, and a part
 * payment takes a booking off it — which is the sheet's "revert to the if Paid
 * process", reached by paying rather than by any jump in the code.
 */
export function hasPayment(booking, money) {
  if (CLOSED_PAYMENT_STATUSES.includes(money.status ?? booking.paymentStatus)) return true;
  return money.paid > 0.005;
}

/** Is everything owed in? */
export function paidInFull(money) {
  return money.outstanding <= 0.005;
}

/**
 * The ladder.
 *
 * Each rung names the day it falls due and the condition under which it
 * sends. `anchor` says which date the offset is measured from:
 *
 *   'lifecycle' — the day the ladder took an interest in the booking, which
 *                 for the payment phase is the day the booking was taken.
 *                 Not `created_at`: a booking can sit as an enquiry for
 *                 months, and not `updated_at`, which moves.
 *   'balanceDue' — the balance deadline, which is the operator's own term
 *                 where they have one and 60 days before play otherwise.
 *   'play'      — the play date.
 *
 * The visitor flow runs the same rungs. The sheet writes the dunning out only
 * for the operator columns and leaves the visitor ones blank — the headers are
 * there, the cells are empty — so the cadence for a visitor is an
 * extrapolation, and `flows` is what makes it one you can switch off.
 */
export function buildLadder(config = LADDER_DEFAULTS) {
  const c = { ...LADDER_DEFAULTS, ...config };

  return [
    // ---------------------------------------------------------------------
    // Payment phase. "Payment link requesting payment within 7 days of
    // booking to secure booking", and what follows if it does not arrive.
    // ---------------------------------------------------------------------
    {
      key: 'deposit_request',
      phase: 'payment',
      label: 'Deposit request',
      anchor: 'lifecycle',
      offset: 0,
      flows: ['operator', 'visitor'],
      // The one rung that does not care about the money: it is what asks for
      // it. Skipped only where somebody has already paid or already been
      // asked by hand.
      when: ({ money, booking }) => !hasPayment(booking, money) && !booking.paymentLinkSentAt,
      cancels: false,
    },
    {
      key: 'deposit_reminder_1',
      phase: 'payment',
      label: 'Deposit reminder',
      anchor: 'lifecycle',
      offset: c.depositReminderDay,
      flows: ['operator', 'visitor'],
      when: ({ money, booking }) => !hasPayment(booking, money),
      cancels: false,
    },
    {
      key: 'deposit_reminder_2',
      phase: 'payment',
      label: 'Deposit reminder (24 hours before the deadline)',
      anchor: 'lifecycle',
      // "an additional reminder 24 hours before". In this sheet the 48- and
      // 24-hour reminders always sit before a deadline, never after it.
      offset: c.depositWindowDays - 1,
      flows: ['operator', 'visitor'],
      when: ({ money, booking }) => !hasPayment(booking, money),
      cancels: false,
    },
    {
      key: 'deposit_overdue',
      phase: 'payment',
      label: 'Deposit window closed — cancellation warning',
      anchor: 'lifecycle',
      offset: c.depositWindowDays,
      flows: ['operator', 'visitor'],
      // "email sent highlighting cancellation of booking. Offer chance to
      // rescue cancellation by paying NOW."
      when: ({ money, booking }) => !hasPayment(booking, money),
      cancels: false,
    },
    {
      key: 'deposit_rescue_48h',
      phase: 'payment',
      label: 'Final notice (48 hours)',
      anchor: 'lifecycle',
      offset: c.depositRescueDay - 2,
      flows: ['operator', 'visitor'],
      when: ({ money, booking }) => !hasPayment(booking, money),
      cancels: false,
    },
    {
      key: 'deposit_rescue_24h',
      phase: 'payment',
      label: 'Final notice (24 hours)',
      anchor: 'lifecycle',
      offset: c.depositRescueDay - 1,
      flows: ['operator', 'visitor'],
      when: ({ money, booking }) => !hasPayment(booking, money),
      cancels: false,
    },
    {
      key: 'deposit_cancelled',
      phase: 'payment',
      label: 'Cancellation',
      anchor: 'lifecycle',
      offset: c.depositRescueDay,
      flows: ['operator', 'visitor'],
      when: ({ money, booking }) => !hasPayment(booking, money),
      // "If not paid then notification of cancellation issued and booking
      // removed." Removed is a status and a note, never a delete: the row is
      // the evidence behind the cancellation.
      cancels: true,
      cancelReason: 'no deposit was received within the payment window',
    },
    {
      key: 'deposit_receipt',
      phase: 'payment',
      label: 'Payment received — terms for the next stage',
      // "Thank you email for payment - outline T&C for next stage." It falls
      // due the day the money lands, so it is anchored on the payment rather
      // than on the ladder's own clock.
      anchor: 'paidOn',
      offset: 0,
      flows: ['operator', 'visitor'],
      when: ({ money, booking }) => hasPayment(booking, money),
      cancels: false,
    },

    // ---------------------------------------------------------------------
    // Balance phase. Trade only: the sheet gives the visitor flow no balance
    // column, because a visitor pays once.
    // ---------------------------------------------------------------------
    {
      key: 'balance_notice',
      phase: 'balance',
      label: 'Balance due — polite reminder',
      anchor: 'balanceDue',
      // "If deposit paid, 70 day out, reminder that 10 days remaining to
      // secure booking as per terms and conditions."
      offset: -c.balanceNoticeLeadDays,
      flows: ['operator'],
      when: ({ money, booking }) => hasPayment(booking, money) && !paidInFull(money),
      cancels: false,
    },
    {
      key: 'balance_reminder_48h',
      phase: 'balance',
      label: 'Balance reminder (48 hours)',
      anchor: 'balanceDue',
      offset: -2,
      flows: ['operator'],
      when: ({ money, booking }) => hasPayment(booking, money) && !paidInFull(money),
      cancels: false,
    },
    {
      key: 'balance_reminder_24h',
      phase: 'balance',
      label: 'Balance reminder (24 hours)',
      anchor: 'balanceDue',
      offset: -1,
      flows: ['operator'],
      when: ({ money, booking }) => hasPayment(booking, money) && !paidInFull(money),
      cancels: false,
    },
    {
      key: 'balance_cancelled',
      phase: 'balance',
      label: 'Balance unpaid — cancellation',
      anchor: 'balanceDue',
      offset: 0,
      flows: ['operator'],
      when: ({ money, booking }) => hasPayment(booking, money) && !paidInFull(money),
      cancels: true,
      cancelReason: 'the balance was still outstanding at the deadline',
    },
    {
      key: 'balance_receipt',
      phase: 'balance',
      label: 'Paid in full — booking details',
      // "Thank you for payment and details of booking at point of 60 days
      // ahead of play - Payment trigger closes and communication trigger
      // commences." The rung that closes the payment phase.
      anchor: 'balanceDue',
      offset: 0,
      flows: ['operator'],
      when: ({ money }) => paidInFull(money),
      cancels: false,
    },

    // ---------------------------------------------------------------------
    // Communication phase, both flows.
    // ---------------------------------------------------------------------
    {
      key: 'confirmation',
      phase: 'communication',
      label: 'Confirmation',
      anchor: 'play',
      offset: -c.confirmationDaysBeforePlay,
      flows: ['operator', 'visitor'],
      // A payment, not full payment: a part-paid booking still needs to know
      // where to turn up. The sheet's column header says "If Paid" and does
      // not distinguish, and the cost of reading it the other way is a guest
      // arriving without arrival information.
      when: ({ money, booking }) => hasPayment(booking, money),
      cancels: false,
      /** The existing pre-arrival campaign is this same email. */
      campaign: 'pre_arrival',
    },
    {
      key: 'final_details',
      phase: 'communication',
      label: 'Final details',
      anchor: 'play',
      offset: -c.finalDetailsDaysBeforePlay,
      flows: ['operator', 'visitor'],
      when: ({ money, booking }) => hasPayment(booking, money),
      cancels: false,
    },
    {
      key: 'post_play',
      phase: 'communication',
      label: 'Post-play thank you',
      anchor: 'play',
      offset: c.postPlayDaysAfterPlay,
      flows: ['operator', 'visitor'],
      // Everyone who played gets one, whatever the ledger says about the
      // money: chasing an invoice is not a reason to skip the thank you.
      when: () => true,
      cancels: false,
      campaign: 'post_play',
    },
  ];
}

/**
 * Which flow a booking is on.
 *
 * An operator booking is one the dashboard has identified as a trade account's
 * — the same identification the Bookings list and the statement use, passed in
 * rather than redone here.
 */
export function flowFor(booking, operator) {
  return operator ? 'operator' : 'visitor';
}

/**
 * The balance deadline the ladder measures from.
 *
 * Not `paymentState.balanceDueDate` directly. That falls back to the invoice
 * terms — the play date plus 30 days — for an account with no
 * `balanceDueDaysBeforePlay` of its own, which is the right answer for billing
 * and the wrong one here: it would put the balance deadline a month *after*
 * the round. So an explicit date wins, then the operator's own term, and the
 * sheet's 60 days before play is the fallback.
 *
 * Where the operator does set a term, theirs is used and the sheet's number is
 * ignored, because the Bookings drawer and the operator statement already show
 * that date. An email saying the balance is due on the 12th must not sit
 * beside a screen saying the 2nd.
 */
export function balanceDueOn(booking, operator, config = LADDER_DEFAULTS) {
  if (booking.balanceDueDate) return booking.balanceDueDate;
  if (!booking.date) return null;
  const term = operator?.balanceDueDaysBeforePlay;
  const days = term == null ? (config.balanceDueDaysBeforePlay ?? LADDER_DEFAULTS.balanceDueDaysBeforePlay) : term;
  return addDays(booking.date, -days);
}

/**
 * The day a rung falls due for one booking, or null where it cannot be dated.
 *
 * A rung with no anchor date is not due and never becomes overdue: a booking
 * with no play date cannot have a balance deadline, and one the ladder has not
 * started has no payment clock.
 */
export function rungDueOn(rung, { booking, lifecycleStartedOn, paidOn, balanceDue }) {
  const anchor = {
    lifecycle: lifecycleStartedOn,
    paidOn,
    play: booking.date ?? null,
    balanceDue: balanceDue ?? null,
  }[rung.anchor];

  if (!anchor) return null;
  return addDays(anchor, rung.offset);
}

/**
 * Every rung of the ladder for one booking, dated and decided.
 *
 * This is the whole of the branching: a rung is `due` when its day has come
 * and its condition holds, `waiting` when its day has not, and `skipped` when
 * the day has come and gone with the condition false — which is what the
 * sheet's two ladders amount to. A booking that pays on day 6 finds the day-7
 * warning skipped and the receipt due, with nothing anywhere that knows it
 * "reverted".
 */
export function evaluateLadder({
  booking,
  operator = null,
  ladder,
  today,
  lifecycleStartedOn,
  paidOn = null,
  already = new Map(),
  catchUpDays = DEFAULT_CATCH_UP_DAYS,
  ladderConfig = LADDER_DEFAULTS,
}) {
  const money = moneyState(booking, operator, today);
  const flow = flowFor(booking, operator);
  const horizon = addDays(today, -catchUpDays);
  const balanceDue = balanceDueOn(booking, operator, ladderConfig);

  return ladder
    .filter((rung) => rung.flows.includes(flow))
    .map((rung) => {
      const dueOn = rungDueOn(rung, { booking, lifecycleStartedOn, paidOn, balanceDue });
      const settled = already.get(rung.key) ?? null;
      const matches = dueOn ? rung.when({ booking, money, operator, today }) : false;

      let state;
      if (settled) state = 'settled';
      else if (!dueOn) state = 'undated';
      else if (dueOn > today) state = 'waiting';
      else if (!matches) state = 'skipped';
      else if (dueOn < horizon) state = 'stale';
      else state = 'due';

      return { rung, dueOn, state, settled, flow, money };
    });
}

/**
 * The one rung to act on for a booking this run, and what to write off.
 *
 * At most one email per booking per run. A booking switched on mid-ladder, or
 * one whose run was missed for a week, has several rungs behind it; sending
 * all of them would deliver a reminder, a warning and a cancellation in the
 * same breath. The furthest-along rung is the only true one — it is the
 * booking's actual situation — so that one is chosen and the rest are
 * recorded as superseded, which also stops an expired warning arriving a day
 * late once the run catches up.
 *
 * `stale` rungs are written off the same way: that is the catch-up horizon,
 * and the record of it is a ledger row rather than silence.
 */
export function planForBooking(evaluated) {
  // Furthest-along means the latest day that has actually fallen due, not the
  // furthest down the list: the rungs are only roughly chronological, and a
  // club that widens the deposit window can push a payment rung past a
  // communication one. Ties — a deadline and the receipt that closes it share
  // a day — break on the ladder's own order, which is phase order.
  const order = new Map(evaluated.map((entry, index) => [entry, index]));
  const actionable = evaluated
    .filter((entry) => entry.state === 'due')
    .sort((a, b) => (a.dueOn === b.dueOn ? order.get(a) - order.get(b) : a.dueOn.localeCompare(b.dueOn)));

  const chosen = actionable.length ? actionable[actionable.length - 1] : null;

  const superseded = [
    // Everything the chosen rung has overtaken.
    ...actionable.slice(0, Math.max(actionable.length - 1, 0)),
    // And everything the horizon put out of reach.
    ...evaluated.filter((entry) => entry.state === 'stale'),
  ];

  const skipped = evaluated.filter((entry) => entry.state === 'skipped');

  return { send: chosen, superseded, skipped };
}

/**
 * The day counts a club can set, with the bounds each one is allowed.
 *
 * The bounds are not arithmetic fussiness. A deposit window of 0 days asks
 * for money before the guest has read the email; one of 400 means the ladder
 * never chases anybody. Both are mistakes a form should refuse rather than
 * carry out, and a club that genuinely wants either is asking for something
 * this ladder is the wrong shape for.
 */
export const DAY_SETTINGS = {
  depositWindowDays: { min: 1, max: 120, label: 'Deposit window' },
  depositReminderDay: { min: 1, max: 120, label: 'First deposit reminder' },
  depositRescueDay: { min: 2, max: 180, label: 'Final deadline' },
  balanceDueDaysBeforePlay: { min: 1, max: 365, label: 'Balance due before play' },
  balanceNoticeLeadDays: { min: 1, max: 180, label: 'Balance notice lead time' },
  confirmationDaysBeforePlay: { min: 1, max: 365, label: 'Confirmation before play' },
  finalDetailsDaysBeforePlay: { min: 0, max: 365, label: 'Final details before play' },
  postPlayDaysAfterPlay: { min: 0, max: 60, label: 'Thank you after play' },
};

/** The switches a club can set, each one a plain boolean. */
export const SWITCH_SETTINGS = ['enabled', 'deadlines', 'scheduled', 'autoCancel', 'visitorDunning'];

/**
 * The ladder as this club has it: its own saved settings over the
 * environment's, over the spreadsheet's defaults.
 *
 * That order is what keeps an existing install working. Before the settings
 * were a club's own they were the deployment's, so a club that has never
 * saved anything inherits exactly the environment it was already running on,
 * and only starts diverging when somebody edits it in the dashboard.
 *
 * The switches still nest, whichever layer they came from: deadlines do
 * nothing until the ladder is on, the schedule nothing until deadlines are,
 * and nothing is cancelled until auto-cancel is. A club can therefore watch
 * what the ladder would do for a week before it does any of it, which is the
 * only safe way to turn on something that emails cancellations.
 */
export function readTriggerConfig(env = process.env, stored = null) {
  const saved = stored && typeof stored === 'object' ? stored : {};
  const pick = (key, fromEnv) => (saved[key] === undefined ? fromEnv : Boolean(saved[key]));

  const enabled = pick('enabled', isOn(env.BOOKING_TRIGGERS_ENABLED));
  const deadlines = enabled && pick('deadlines', isOn(env.BOOKING_TRIGGERS_DEADLINES));
  const unattended = deadlines && pick('scheduled', isOn(env.BOOKING_TRIGGERS_SCHEDULE));
  const autoCancel = deadlines && pick('autoCancel', isOn(env.BOOKING_TRIGGERS_AUTO_CANCEL));

  const day = (key, fromEnv) => (saved[key] === undefined ? positiveInt(fromEnv, LADDER_DEFAULTS[key]) : saved[key]);

  const ladderConfig = {
    depositWindowDays: day('depositWindowDays', env.BOOKING_DEPOSIT_WINDOW_DAYS),
    depositReminderDay: day('depositReminderDay', env.BOOKING_DEPOSIT_REMINDER_DAY),
    depositRescueDay: day('depositRescueDay', env.BOOKING_DEPOSIT_RESCUE_DAY),
    balanceDueDaysBeforePlay: day('balanceDueDaysBeforePlay', env.BOOKING_BALANCE_DUE_DAYS),
    balanceNoticeLeadDays: day('balanceNoticeLeadDays', env.BOOKING_BALANCE_NOTICE_LEAD_DAYS),
    confirmationDaysBeforePlay: day('confirmationDaysBeforePlay', env.BOOKING_CONFIRMATION_DAYS),
    finalDetailsDaysBeforePlay: day('finalDetailsDaysBeforePlay', env.BOOKING_FINAL_DETAILS_DAYS),
    postPlayDaysAfterPlay: day('postPlayDaysAfterPlay', env.BOOKING_POST_PLAY_DAYS),
  };

  return {
    enabled,
    deadlines,
    unattended,
    autoCancel,
    /** Whether the visitor flow runs the dunning the sheet left unwritten. */
    visitorDunning: pick('visitorDunning', !isOff(env.BOOKING_TRIGGERS_VISITOR_DUNNING)),
    catchUpDays:
      saved.catchUpDays === undefined
        ? positiveInt(env.BOOKING_TRIGGERS_CATCH_UP_DAYS, DEFAULT_CATCH_UP_DAYS)
        : saved.catchUpDays,
    // Not a club's to set: how hard one run leans on the database, and how
    // often the process wakes, belong to whoever runs the server.
    batch: positiveInt(env.BOOKING_TRIGGERS_BATCH, 200),
    minutes: Math.max(Number.parseFloat(env.BOOKING_TRIGGERS_MINUTES ?? '15') || 15, 1),
    ladder: ladderConfig,
    /** Which keys this club has actually saved, for the settings form. */
    saved: Object.keys(saved),
  };
}

/**
 * Check what a club is trying to save, and return only what it may.
 *
 * Shaped like `validateMembershipSettings` next door: `{ ok, errors, value }`,
 * with `value` holding the keys that passed. An absent key means "inherit",
 * so a patch of one field leaves the rest alone.
 *
 * The orderings are the part worth having. Each one is a cadence that reads
 * fine field by field and is nonsense as a sequence — a reminder after the
 * deadline it is reminding about, a final notice before the window it
 * rescues. A form cannot catch those one input at a time.
 */
export function validateLifecycleSettings(input, { current = {} } = {}) {
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
      errors.push(`${labelForSwitch(key)} must be true or false`);
      continue;
    }
    value[key] = raw;
  }

  for (const [key, bounds] of Object.entries({
    ...DAY_SETTINGS,
    catchUpDays: { min: 0, max: 365, label: 'Catch-up limit' },
  })) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      errors.push(`${bounds.label} must be a whole number of days`);
      continue;
    }
    if (raw < bounds.min || raw > bounds.max) {
      errors.push(`${bounds.label} must be between ${bounds.min} and ${bounds.max} days`);
      continue;
    }
    value[key] = raw;
  }

  // The orderings are checked against the settings as they would be after
  // this save, not against the patch alone: a club changing one field must
  // not be told its other, untouched fields are wrong — nor allowed to break
  // the sequence by moving one end of it.
  const after = { ...LADDER_DEFAULTS, catchUpDays: DEFAULT_CATCH_UP_DAYS, ...current, ...value };

  if (after.depositReminderDay >= after.depositWindowDays) {
    errors.push('The first deposit reminder must come before the deposit window closes');
  }
  if (after.depositRescueDay <= after.depositWindowDays) {
    errors.push('The final deadline must come after the deposit window closes');
  }
  if (after.depositRescueDay - after.depositWindowDays < 2) {
    errors.push(
      'Leave at least two days between the window closing and the final deadline, for the 48- and 24-hour notices',
    );
  }
  if (after.balanceNoticeLeadDays >= after.balanceDueDaysBeforePlay) {
    errors.push('The balance notice must fall after the booking was made, not before the play date it is counted from');
  }
  if (after.finalDetailsDaysBeforePlay >= after.confirmationDaysBeforePlay) {
    errors.push('The final details must go out after the confirmation, nearer the play date');
  }

  return { ok: errors.length === 0, errors, value };
}

function labelForSwitch(key) {
  return (
    {
      enabled: 'Evaluating bookings',
      deadlines: 'Deadlines count',
      scheduled: 'Runs unattended',
      autoCancel: 'Cancels on a lapse',
      visitorDunning: 'Chase visitors',
    }[key] ?? key
  );
}

/**
 * The rungs that may actually send under this configuration.
 *
 * Two subtractions, both deliberate:
 *
 * With deadlines off, no rung that cancels a booking is in the ladder at all,
 * so a club can run it and read what it would do without a single guest
 * hearing from it.
 *
 * With the visitor dunning off, the payment-phase rungs keep the operator
 * flow and lose the visitor one — a trade account is chased and a visitor is
 * not. That is the switch for the half of the sheet that was left blank: the
 * cadence is an extrapolation, and this is how a club declines it without
 * losing the visitor's receipt or their arrival details, which the sheet does
 * spell out.
 */
export function sendableLadder(config) {
  return buildLadder(config.ladder)
    .filter((rung) => config.deadlines || !rung.cancels)
    .map((rung) => {
      if (config.visitorDunning || rung.phase !== 'payment' || rung.key === 'deposit_receipt') return rung;
      return { ...rung, flows: rung.flows.filter((flow) => flow !== 'visitor') };
    })
    .filter((rung) => rung.flows.length > 0);
}

/** Today in the club's zone — the only clock the ladder reads. */
export function ladderToday(now = new Date()) {
  return todayInClubZone(now);
}

function isOn(value) {
  return /^(true|1|yes|on)$/i.test(String(value ?? '').trim());
}

function isOff(value) {
  return /^(false|0|no|off)$/i.test(String(value ?? '').trim());
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
