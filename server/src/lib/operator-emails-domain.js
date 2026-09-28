/**
 * Reminder emails to tour operators.
 *
 * The guest campaigns in `email-domain.js` write to one guest about one round.
 * These two write to one *account* about everything of theirs that needs an
 * answer, because that is how a trade partner reads their post: an operator
 * with eleven bookings wants one email listing eleven lines, not eleven emails.
 *
 *   booking_status   what of theirs is not confirmed yet, before the tee sheet
 *                    is given away
 *   payment_due      what they owe, what is already late, and under which terms
 *
 * Everything is pure. Candidate selection, the grouping and the SendGrid
 * template payload are all derived from serialised bookings and operator rows,
 * so the rules are tested without a database or an API key.
 */
import { BRAND } from './brand.js';
import { brandTemplateData } from './email-layout.js';
import {
  COMMITTED_STATUSES,
  buildOperatorIndex,
  describeTerms,
  identify,
  paymentState,
  summarise,
} from './operators-domain.js';

/**
 * Both campaigns look forward from today, unlike the guest ones which sit on a
 * single target date. An operator chase is not a scheduled birthday card — it
 * covers a window, and everything in the window goes in the one email.
 */
export const OPERATOR_CAMPAIGNS = {
  booking_status: {
    id: 'booking_status',
    label: 'Booking status reminder',
    /** What it is asking the operator to do. */
    purpose: 'Confirm the bookings that are still open',
    defaultDays: 21,
    daysEnv: 'OPERATOR_STATUS_REMINDER_DAYS',
    templateEnv: 'SENDGRID_TEMPLATE_OPERATOR_STATUS',
    column: 'operator_status_email_sent_at',
    field: 'operatorStatusEmailSentAt',
  },
  payment_due: {
    id: 'payment_due',
    label: 'Payment reminder',
    purpose: 'Chase the money that is due or already late',
    defaultDays: 7,
    daysEnv: 'OPERATOR_PAYMENT_REMINDER_DAYS',
    templateEnv: 'SENDGRID_TEMPLATE_OPERATOR_PAYMENT',
    column: 'operator_payment_email_sent_at',
    field: 'operatorPaymentEmailSentAt',
  },
};

export const OPERATOR_CAMPAIGN_IDS = Object.keys(OPERATOR_CAMPAIGNS);

/** A booking is only ever in one reminder per this many days. */
export const RESEND_GUARD_DAYS = 7;

export function getOperatorCampaign(id) {
  return OPERATOR_CAMPAIGNS[id] ?? null;
}

/**
 * The reminder settings from the environment, with the secret reduced to a
 * yes/no — this shape goes to the browser.
 *
 * The sender credentials are shared with the guest campaigns on purpose: a club
 * that has configured SendGrid once should not have to do it again to chase an
 * invoice. Only the template ids are separate.
 */
export function readReminderConfig(env = process.env) {
  const campaigns = {};
  for (const campaign of Object.values(OPERATOR_CAMPAIGNS)) {
    campaigns[campaign.id] = {
      id: campaign.id,
      label: campaign.label,
      purpose: campaign.purpose,
      days: positiveInt(env[campaign.daysEnv], campaign.defaultDays),
      templateId: env[campaign.templateEnv] ?? null,
      templateEnv: campaign.templateEnv,
      configured: Boolean(env[campaign.templateEnv]),
    };
  }

  const missing = [];
  if (!env.SENDGRID_API_KEY) missing.push('SENDGRID_API_KEY');
  if (!env.FROM_EMAIL) missing.push('FROM_EMAIL');
  for (const campaign of Object.values(campaigns)) {
    if (!campaign.configured) missing.push(campaign.templateEnv);
  }

  return {
    hasApiKey: Boolean(env.SENDGRID_API_KEY),
    apiKey: env.SENDGRID_API_KEY ?? null,
    fromEmail: env.FROM_EMAIL ?? null,
    fromName: env.FROM_NAME ?? BRAND.fromName,
    /** Where an operator without a contact address sends its reminder, if set. */
    fallbackEmail: env.OPERATOR_REMINDER_FALLBACK_EMAIL ?? null,
    campaigns,
    missing,
    configured: missing.length === 0,
  };
}

export function publicReminderConfig(config) {
  const { apiKey, ...rest } = config;
  return rest;
}

export function reminderReady(config, campaignId) {
  return (
    config.hasApiKey && Boolean(config.fromEmail) && Boolean(config.campaigns[campaignId]?.configured)
  );
}

/**
 * Which of an operator's bookings belong in this campaign's email today.
 *
 * `booking_status` takes everything of theirs playing inside the window that
 * has not reached `Booked` — an enquiry nobody has answered is a problem to an
 * operator holding a tee sheet.
 *
 * `payment_due` takes the committed bookings with money outstanding whose next
 * milestone falls inside the window, plus everything already late however old.
 */
export function bookingMatchesCampaign(booking, operator, { campaign, days, today }) {
  if (campaign.id === 'booking_status') {
    if (!booking.date || booking.date < today) return null;
    if (booking.status === 'Booked') return null;
    if (!['Inquiry', 'Requested'].includes(booking.status)) return null;
    const horizon = shift(today, days);
    if (booking.date > horizon) return null;

    return {
      reason: 'Awaiting confirmation',
      daysToPlay: dayGap(today, booking.date),
    };
  }

  // payment_due
  if (!COMMITTED_STATUSES.includes(booking.status)) return null;
  const state = paymentState(booking, operator, { today });
  if (!state.chaseable || state.outstanding <= 0) return null;
  if (!state.dueDate) return null;
  if (!state.overdue && state.dueDate > shift(today, days)) return null;

  return {
    reason: state.overdue
      ? `${state.daysOverdue} day${state.daysOverdue === 1 ? '' : 's'} overdue`
      : state.daysUntilDue === 0
        ? 'Due today'
        : `Due in ${state.daysUntilDue} day${state.daysUntilDue === 1 ? '' : 's'}`,
    state,
  };
}

/**
 * The reminders that would go out today, one entry per operator.
 *
 * An operator with no bookings in the window does not appear at all — a chase
 * with nothing in it is worse than no chase. An operator who *has* bookings but
 * no contact address does appear, marked unsendable, because that is a gap in
 * the account somebody needs to fix rather than a silence.
 */
export function selectReminders(operators, bookings, { campaign, days, today, scope = 'due' } = {}) {
  const index = buildOperatorIndex(operators);
  const byOperator = new Map(operators.map((operator) => [operator.id, []]));

  for (const booking of bookings) {
    const match = identify(booking, index);
    // Only the evidence the club can stand behind: an assignment or a
    // registered sending domain. Nobody is invoiced on a name that turned up
    // in the body of an email.
    if (!match.operator || match.source === 'name') continue;
    byOperator.get(match.operator.id).push(booking);
  }

  const reminders = [];

  for (const operator of operators) {
    if (!operator.active) continue;

    const theirs = byOperator.get(operator.id);
    const lines = [];

    for (const booking of theirs) {
      const hit = bookingMatchesCampaign(booking, operator, { campaign, days, today });
      if (!hit) continue;

      const state = hit.state ?? paymentState(booking, operator, { today });
      const sentAt = booking[campaign.field] ?? null;
      lines.push({
        bookingId: booking.bookingId,
        guestName: booking.guestName || '',
        guestEmail: booking.guestEmail || '',
        date: booking.date,
        teeTime: booking.teeTime,
        players: booking.players,
        status: booking.status,
        reason: hit.reason,
        daysToPlay: hit.daysToPlay ?? dayGap(today, booking.date),
        total: state.gross,
        paid: state.paid,
        outstanding: state.outstanding,
        dueDate: state.dueDate,
        daysOverdue: state.daysOverdue,
        overdue: state.overdue,
        paymentStatus: state.status,
        sentAt,
        // Not "has it ever been sent" but "was it sent recently". A booking
        // legitimately appears in next month's chase as well; it must not
        // appear in tomorrow's.
        recentlyReminded: withinDays(sentAt, today, RESEND_GUARD_DAYS),
      });
    }

    if (!lines.length) continue;

    const fresh = lines.filter((line) => !line.recentlyReminded);
    // 'due' is the run the page exists for: only the operators with something
    // that has not just been chased. 'all' is the deliberate catch-up.
    if (scope !== 'all' && !fresh.length) continue;

    lines.sort(sortLines(campaign));

    reminders.push({
      operatorId: operator.id,
      operatorName: operator.name,
      contactName: operator.contactName,
      contactEmail: operator.contactEmail,
      terms: describeTerms(operator),
      onHold: operator.onHold,
      account: summarise(operator, theirs, { today }),
      bookings: lines,
      freshCount: fresh.length,
      totalOutstanding: round2(lines.reduce((sum, line) => sum + line.outstanding, 0)),
      totalOverdue: round2(
        lines.filter((line) => line.overdue).reduce((sum, line) => sum + line.outstanding, 0),
      ),
      maxDaysOverdue: lines.reduce((worst, line) => Math.max(worst, line.daysOverdue), 0),
      sendable: Boolean(operator.contactEmail),
      blocker: operator.contactEmail ? null : 'No contact email on the account',
    });
  }

  // The loudest account first: how late, then how much.
  return reminders.sort(
    (a, b) =>
      b.maxDaysOverdue - a.maxDaysOverdue ||
      b.totalOutstanding - a.totalOutstanding ||
      a.operatorName.localeCompare(b.operatorName),
  );
}

function sortLines(campaign) {
  if (campaign.id === 'payment_due') {
    return (a, b) => b.daysOverdue - a.daysOverdue || String(a.dueDate).localeCompare(String(b.dueDate));
  }
  return (a, b) => String(a.date).localeCompare(String(b.date));
}

/**
 * The dynamic-template data an operator reminder carries.
 *
 * The line items go in twice on purpose. `bookings` is the array a handlebars
 * `{{#each}}` walks to build a real table; `booking_lines` is the same content
 * as one preformatted block, so a template written before this feature existed
 * — or a plain-text part — still says something useful.
 */
export function buildReminderTemplateData(reminder, { campaign, fromEmail, days, today, now = new Date() } = {}) {
  const lines = reminder.bookings;

  return {
    // Logo, colours and contact details, so the SendGrid template can carry
    // the same branding as the emails the dashboard builds itself.
    ...brandTemplateData(),
    operator_name: reminder.operatorName,
    contact_name: reminder.contactName || reminder.operatorName,
    account_reference: reminder.operatorId ? `OP-${reminder.operatorId}` : '',
    credit_terms: reminder.terms,

    campaign: campaign.id,
    campaign_label: campaign.label,
    window_days: String(days ?? ''),
    reminder_date: formatLongDate(today),

    booking_count: String(lines.length),
    player_count: String(lines.reduce((sum, line) => sum + (Number(line.players) || 0), 0)),
    booking_total: formatMoney(lines.reduce((sum, line) => sum + (Number(line.total) || 0), 0)),

    total_outstanding: formatMoney(reminder.totalOutstanding),
    total_overdue: formatMoney(reminder.totalOverdue),
    has_overdue: reminder.totalOverdue > 0,
    days_overdue: String(reminder.maxDaysOverdue),
    earliest_due_date: formatLongDate(
      lines.map((line) => line.dueDate).filter(Boolean).sort()[0] ?? null,
    ),
    account_outstanding: formatMoney(reminder.account.outstanding),
    credit_limit: reminder.account.creditLimit == null ? '' : formatMoney(reminder.account.creditLimit),
    credit_headroom: reminder.account.headroom == null ? '' : formatMoney(reminder.account.headroom),
    account_on_hold: Boolean(reminder.onHold),

    bookings: lines.map((line) => ({
      booking_reference: line.bookingId,
      guest_name: line.guestName,
      booking_date: formatLongDate(line.date),
      tee_time: line.teeTime || 'TBD',
      player_count: String(line.players ?? 0),
      status: line.status,
      payment_status: line.paymentStatus,
      total: formatMoney(line.total),
      paid: formatMoney(line.paid),
      outstanding: formatMoney(line.outstanding),
      due_date: formatLongDate(line.dueDate),
      days_overdue: String(line.daysOverdue),
      note: line.reason,
    })),
    booking_lines: lines.map((line) => renderLine(line, campaign)).join('\n'),

    club_name: BRAND.fullName,
    club_email: fromEmail ?? '',
    current_year: String(now.getFullYear()),
  };
}

function renderLine(line, campaign) {
  const head = `${line.bookingId} · ${formatLongDate(line.date)} ${line.teeTime || ''} · ${line.players} player${
    line.players === 1 ? '' : 's'
  }`;
  if (campaign.id === 'payment_due') {
    return `${head} · ${formatMoney(line.outstanding)} outstanding · ${line.reason}`;
  }
  return `${head} · ${line.status} · ${line.reason}`;
}

/** Why a reminder cannot go out, or null when it can. */
export function validateReminder(reminder) {
  if (!reminder.contactEmail) return 'No contact email on the account';
  if (!String(reminder.contactEmail).includes('@')) return 'Contact email is not an address';
  if (!reminder.bookings.length) return 'Nothing to remind them about';
  return null;
}

// --- helpers ----------------------------------------------------------------

function shift(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayGap(from, to) {
  if (!from || !to) return 0;
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/** Was this stamp written within the last `days` days of the club's today? */
function withinDays(sentAt, today, days) {
  if (!sentAt) return false;
  const sentDay = String(new Date(sentAt).toISOString()).slice(0, 10);
  if (sentDay > today) return true;
  return dayGap(sentDay, today) < days;
}

const LONG_DATE_PARTS = new Intl.DateTimeFormat(BRAND.locale, {
  weekday: 'long',
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** 'Wednesday 18 March 2026' — assembled to match the guest templates exactly. */
function formatLongDate(isoDate) {
  if (!isoDate) return '';
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(isoDate);
  const parts = Object.fromEntries(
    LONG_DATE_PARTS.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}`;
}

function formatMoney(value) {
  const amount = Number(value);
  return new Intl.NumberFormat(BRAND.locale, {
    style: 'currency',
    currency: BRAND.currency,
  }).format(Number.isFinite(amount) ? amount : 0);
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
