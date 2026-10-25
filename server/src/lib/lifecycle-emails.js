/**
 * What each rung of the lifecycle actually says to the guest.
 *
 * Sixteen emails, written here rather than as sixteen SendGrid templates. A
 * club that wants its own wording still sets one — `templateFor` prefers it —
 * but the ladder is not useless until somebody has built sixteen templates,
 * which is what it was before this file existed.
 *
 * Everything is pure: a booking and its money in, `{ subject, text, html }`
 * out. So the copy can be read in a test, and a change to what a guest is told
 * does not need an API key to check.
 *
 * Two rules the copy keeps throughout:
 *
 * It never threatens more than the club has actually switched on. The warnings
 * only exist in the modes that can stop a booking (see `sendableLadder`), so
 * nothing here promises a cancellation that cannot happen.
 *
 * It always says what to do next, and gives the one link that does it. An
 * email that says a booking is at risk and offers no way to pay is a
 * complaint, not a reminder.
 */
import { BRAND } from './brand.js';
import { emailShell, escapeHtml } from './email-layout.js';
import { formatMoney } from './payment-link-domain.js';
import { manageUrlFor } from './change-request-domain.js';

/**
 * Who to greet.
 *
 * A guest gets their first name. A trade account does not: "Highland Golf
 * Tours" split on whitespace reads "Hi Highland," which is nobody's name and
 * sounds like a mailshot. So an account is greeted by its contact's first
 * name where it has one, and by its own name in full where it does not.
 */
function greetingName(booking, operator) {
  if (operator) {
    const contact = String(operator.contactName ?? '').trim();
    if (contact) return contact.split(/\s+/)[0];
    const account = String(operator.name ?? '').trim();
    if (account) return account;
  }
  const name = String(booking.guestName ?? '').trim();
  return name ? name.split(/\s+/)[0] : 'there';
}

function longDate(date) {
  if (!date) return '';
  const value = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(value.getTime())) return String(date);
  return new Intl.DateTimeFormat(BRAND.locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value);
}

function shortDate(date) {
  if (!date) return '';
  const value = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(value.getTime())) return String(date);
  return new Intl.DateTimeFormat(BRAND.locale, {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(value);
}

/**
 * "Deposit" or "payment", whichever this booking is actually asking for.
 *
 * A trade account with a deposit percentage owes part of the total up front,
 * and "deposit" is right. A visitor with no percentage set owes all of it, and
 * being asked for "a deposit of €1,000" on a €1,000 round reads as a mistake —
 * which is how somebody ends up paying twice, or ringing to ask.
 */
function amountWord(money) {
  const deposit = Number(money?.depositAmount) || 0;
  const gross = Number(money?.gross) || 0;
  return deposit > 0 && deposit < gross ? 'deposit' : 'payment';
}

/** The round, as a table a guest can check at a glance. */
function roundDetails(booking) {
  return [
    ['Booking reference', booking.bookingId],
    ['Date', longDate(booking.date)],
    ['Tee time', booking.teeTime && booking.teeTime !== 'Not Specified' ? booking.teeTime : ''],
    ['Course', booking.golfCourses ?? ''],
    ['Players', booking.players == null ? '' : String(booking.players)],
  ].filter(([, value]) => value !== '' && value != null);
}

function moneyDetails(money) {
  return [
    ['Booking total', formatMoney(money.gross)],
    ['Paid so far', formatMoney(money.paid)],
    ['Still to pay', formatMoney(money.outstanding)],
  ];
}

/**
 * The copy for every rung.
 *
 * Each returns the pieces the shell wants. `lead` is the opening line, `body`
 * the rest, `button` the one thing to do, `details` the table, and `footer`
 * the quiet line underneath. Plain text is derived from the same pieces, so
 * the two versions cannot drift.
 */
const COPY = {
  // -------------------------------------------------------------------------
  // Chasing the deposit
  // -------------------------------------------------------------------------
  deposit_request: ({ booking, money, due }) => ({
    subject: `Secure your booking at ${BRAND.fullName} — ${booking.bookingId}`,
    lead: `Thank you for booking with us. To hold your tee time we need a ${amountWord(money)} of ${formatMoney(money.dueAmount || money.outstanding)}, by ${shortDate(due)}.`,
    body: ['You can pay online in a couple of minutes using the button below.'],
    button: payButton(booking),
    details: roundDetails(booking),
    footer: 'If you have already paid, thank you — please ignore this email.',
  }),

  deposit_reminder_1: ({ booking, money, due }) => ({
    subject: `A reminder about your ${amountWord(money)} — ${booking.bookingId}`,
    lead: `We have not yet received the ${amountWord(money)} for your round on ${longDate(booking.date)}.`,
    body: [
      `${formatMoney(money.outstanding)} is outstanding, and it is due by ${shortDate(due)}. Your tee time is held until then.`,
    ],
    button: payButton(booking),
    details: roundDetails(booking),
    footer: 'If you have paid in the last day or two, our records may not have caught up — do let us know.',
  }),

  deposit_reminder_2: ({ booking, money, due }) => ({
    subject: `24 hours left to secure ${booking.bookingId}`,
    lead: `A short note: the ${amountWord(money)} for your round on ${longDate(booking.date)} is due tomorrow, ${shortDate(due)}.`,
    body: [
      `There is ${formatMoney(money.outstanding)} outstanding. After tomorrow we may have to release the tee time.`,
    ],
    button: payButton(booking),
    details: roundDetails(booking),
    footer: 'If something has changed, reply to this email and we will do what we can.',
  }),

  deposit_overdue: ({ booking, money, due }) => ({
    subject: `Your booking ${booking.bookingId} is at risk`,
    lead: `The ${amountWord(money)} for your round on ${longDate(booking.date)} was due on ${shortDate(due)} and we have not received it.`,
    body: [
      `Your tee time has not been released yet. If you pay the outstanding ${formatMoney(money.outstanding)} now, the booking carries on exactly as it was.`,
    ],
    button: payButton(booking, 'Pay now and keep my booking'),
    details: roundDetails(booking),
    footer: 'If you no longer need the tee time, a quick reply helps us offer it to somebody else.',
  }),

  deposit_rescue_48h: ({ booking, money, due }) => ({
    subject: `48 hours before we release your tee time — ${booking.bookingId}`,
    lead: `We still have not received the ${amountWord(money)} for your round on ${longDate(booking.date)}.`,
    body: [
      `Unless ${formatMoney(money.outstanding)} reaches us by ${shortDate(due)}, we will have to release the tee time.`,
      'Paying now stops that happening.',
    ],
    button: payButton(booking, 'Pay now and keep my booking'),
    details: roundDetails(booking),
    footer: 'Already paid, or need longer? Reply and we will sort it out.',
  }),

  deposit_rescue_24h: ({ booking, money, due }) => ({
    subject: `Final notice — ${booking.bookingId}`,
    lead: `This is the last reminder before we release the tee time for your round on ${longDate(booking.date)}.`,
    body: [
      `${formatMoney(money.outstanding)} is outstanding and due by ${shortDate(due)}.`,
      'If it arrives before then, nothing changes and we will see you as planned.',
    ],
    button: payButton(booking, 'Pay now and keep my booking'),
    details: roundDetails(booking),
    footer: 'If you would rather cancel, replying is enough — there is nothing to fill in.',
  }),

  deposit_cancelled: ({ booking, money }) => ({
    subject: `Booking ${booking.bookingId} has been cancelled`,
    lead: `We did not receive the ${amountWord(money)} for your round on ${longDate(booking.date)}, so the booking has been cancelled and the tee time released.`,
    body: [
      'Nothing is owed and there is nothing further to do.',
      'If this is not what you intended, please reply — we would rather sort it out than lose you, though we cannot promise the same tee time.',
    ],
    details: roundDetails(booking),
    footer: 'We would be glad to see you another time.',
  }),

  deposit_receipt: ({ booking, money }) => ({
    subject: `Payment received — ${booking.bookingId}`,
    lead: `Thank you — we have received ${formatMoney(money.paid)} and your tee time is secure.`,
    body: paidInFull(money)
      ? ['Your booking is paid in full. We will be in touch nearer the time with everything you need.']
      : [
          `A balance of ${formatMoney(money.outstanding)} remains${money.balanceDueDate ? `, due by ${shortDate(money.balanceDueDate)}` : ''}. We will remind you nearer the time.`,
        ],
    details: [...roundDetails(booking), ...moneyDetails(money)],
    footer: 'Please keep this email as your receipt.',
  }),

  // -------------------------------------------------------------------------
  // Chasing the balance (trade bookings)
  // -------------------------------------------------------------------------
  balance_notice: ({ booking, money, due }) => ({
    subject: `Balance due ${shortDate(due)} — ${booking.bookingId}`,
    lead: `A reminder that the balance for this booking falls due on ${shortDate(due)}.`,
    body: [`${formatMoney(money.outstanding)} is outstanding on a total of ${formatMoney(money.gross)}.`],
    button: payButton(booking, 'Pay the balance'),
    details: [...roundDetails(booking), ...moneyDetails(money)],
    footer: 'If this is already scheduled for payment, there is nothing to do.',
  }),

  balance_reminder_48h: ({ booking, money, due }) => ({
    subject: `Balance due in 48 hours — ${booking.bookingId}`,
    lead: `The balance of ${formatMoney(money.outstanding)} is due on ${shortDate(due)}.`,
    body: ['We are sending this a little ahead so there is time to arrange it.'],
    button: payButton(booking, 'Pay the balance'),
    details: [...roundDetails(booking), ...moneyDetails(money)],
    footer: 'If the booking has changed, let us know and we will re-issue the invoice.',
  }),

  balance_reminder_24h: ({ booking, money, due }) => ({
    subject: `Balance due tomorrow — ${booking.bookingId}`,
    lead: `The balance of ${formatMoney(money.outstanding)} is due tomorrow, ${shortDate(due)}.`,
    body: ['After that we may have to release the tee times on this booking.'],
    button: payButton(booking, 'Pay the balance'),
    details: [...roundDetails(booking), ...moneyDetails(money)],
    footer: 'If there is a problem with the invoice, reply today and we will hold it.',
  }),

  balance_cancelled: ({ booking, money }) => ({
    subject: `Booking ${booking.bookingId} cancelled — balance not received`,
    lead: `The balance of ${formatMoney(money.outstanding)} was not received by the due date, so this booking has been cancelled and the tee times released.`,
    body: [
      'Any deposit already paid will be dealt with under the terms of the booking.',
      'If this has gone wrong at our end, please reply and we will look into it straight away.',
    ],
    details: [...roundDetails(booking), ...moneyDetails(money)],
    footer: 'We would much rather have the booking than the cancellation — do get in touch.',
  }),

  balance_receipt: ({ booking, money }) => ({
    subject: `Paid in full — ${booking.bookingId}`,
    lead: `Thank you — this booking is now paid in full (${formatMoney(money.paid)}).`,
    body: ['Everything is settled. Nearer the time we will send the final arrival details.'],
    details: [...roundDetails(booking), ['Total paid', formatMoney(money.paid)]],
    footer: 'Please keep this email for your records.',
  }),

  // -------------------------------------------------------------------------
  // The run-up to the tee
  // -------------------------------------------------------------------------
  confirmation: ({ booking }) => ({
    subject: `Your round at ${BRAND.fullName} — ${longDate(booking.date)}`,
    lead: `Your booking is confirmed for ${longDate(booking.date)}. We are looking forward to seeing you.`,
    body: [
      'Everything below is as we have it. If anything needs changing, there is a link at the bottom of this email.',
      ...(booking.caddieRequirements ? [`We have you down for: ${escapeHtml(booking.caddieRequirements)}.`] : []),
    ],
    details: roundDetails(booking),
    footer: 'We will send your arrival details nearer the time.',
  }),

  final_details: ({ booking }) => ({
    subject: `Getting here — your round on ${shortDate(booking.date)}`,
    lead: `Your round is nearly here. Everything you need for the day is below.`,
    body: [
      'Please arrive in good time to check in at the professional shop and get to the first tee without rushing.',
      ...(booking.caddieRequirements ? [`Caddies: ${escapeHtml(booking.caddieRequirements)}.`] : []),
      ...(booking.specialRequests ? ['We have your notes on file and the team has them.'] : []),
    ],
    details: roundDetails(booking),
    footer: 'If anything has changed, please tell us today rather than on the morning.',
  }),

  post_play: ({ booking }) => ({
    subject: `Thank you for playing ${booking.golfCourses?.trim() || BRAND.defaultCourse}`,
    lead: `Thank you for joining us on ${longDate(booking.date)}. We hope you enjoyed the round.`,
    body: [
      'If anything was not as it should have been, we would genuinely like to know — a reply to this email reaches the team directly.',
      'We would be delighted to see you again.',
    ],
    details: [],
    footer: 'To book another round, just reply and we will find you a time.',
  }),
};

function paidInFull(money) {
  return (money?.outstanding ?? 0) <= 0.005;
}

/** The one thing to do, where there is a link that does it. */
function payButton(booking, label = 'Pay now') {
  return booking.paymentLinkUrl ? { href: booking.paymentLinkUrl, label } : null;
}

/** Every rung this file can write, for the settings page and for tests. */
export const WRITTEN_RUNGS = Object.keys(COPY);

export function hasBuiltInEmail(rungKey) {
  return Object.prototype.hasOwnProperty.call(COPY, rungKey);
}

/**
 * Write one rung's email.
 *
 * Returns `null` for a rung nobody has written copy for, which is how a new
 * rung added to the ladder fails: visibly, and without sending a blank email.
 */
export function buildLifecycleEmail(rungKey, { booking, money, dueOn = null, operator = null } = {}) {
  const write = COPY[rungKey];
  if (!write) return null;

  const copy = write({ booking, money: money ?? {}, due: dueOn });
  const manageUrl = manageUrlFor(booking) ?? '';
  const greeting = `Hi ${greetingName(booking, operator)},`;

  const footer =
    copy.footer +
    (manageUrl
      ? `<br><br>Need to change or cancel? <a href="${escapeHtml(manageUrl)}" style="color:#1a5e58;font-weight:600;">Manage your booking</a>.`
      : '');

  const html = emailShell({
    clubName: BRAND.fullName,
    paragraphs: [escapeHtml(greeting), escapeHtml(copy.lead), ...copy.body],
    button: copy.button,
    details: copy.details,
    footer,
  });

  const text = [
    greeting,
    '',
    copy.lead,
    ...(copy.body.length ? ['', ...copy.body.map(stripTags)] : []),
    ...(copy.button ? ['', `${copy.button.label}: ${copy.button.href}`] : []),
    ...(copy.details.length ? ['', ...copy.details.map(([label, value]) => `${label}: ${value}`)] : []),
    '',
    stripTags(copy.footer),
    ...(manageUrl ? ['', `Change or cancel: ${manageUrl}`] : []),
    '',
    BRAND.fullName,
  ].join('\n');

  return { subject: copy.subject, text, html };
}

/**
 * The same copy as merge fields, for a club that has built its own SendGrid
 * template and wants our words in it.
 */
export function lifecycleTemplateData(rungKey, context) {
  const built = buildLifecycleEmail(rungKey, context);
  if (!built) return null;
  const copy = COPY[rungKey]({ booking: context.booking, money: context.money ?? {}, due: context.dueOn });
  return {
    subject: built.subject,
    headline: copy.lead,
    body_text: built.text,
    button_url: copy.button?.href ?? '',
    button_label: copy.button?.label ?? '',
  };
}

const stripTags = (value) => String(value ?? '').replace(/<[^>]+>/g, '');
