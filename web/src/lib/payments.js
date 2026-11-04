/**
 * The money side of a booking, as the SPA sees it.
 *
 * The arithmetic all happens on the server (`server/src/lib/operators-domain.js`)
 * and arrives on every booking as `booking.payment`. This module only holds the
 * vocabulary the screen needs: what each state is called, what colour carries
 * it, and how a due date is put into words.
 */
import { INK_MUTED, OVERDUE, PAYMENT_COLORS } from './palette.js';
import { normaliseStatus } from './status.js';

/** 'Pending': a Stripe payment link has been emailed and not yet paid. */
export const PAYMENT_STATUSES = ['Unpaid', 'Pending', 'Deposit paid', 'Paid', 'Refunded', 'Written off'];

/** Neither owes money nor counts toward an operator's exposure. */
export const CLOSED_PAYMENT_STATUSES = ['Refunded', 'Written off'];

export function paymentColor(status) {
  return PAYMENT_COLORS[status] ?? INK_MUTED;
}

export { OVERDUE };

/**
 * A due date in words: how late, or how soon.
 *
 * Always a sentence rather than a colour, because "overdue" is the one state on
 * this page somebody has to act on and it must survive being printed, forwarded
 * or read by somebody who cannot tell the rose from the gold.
 */
export function describeDue(payment) {
  if (!payment) return '—';
  if (payment.settled) return 'Settled';
  if (!payment.dueDate) return 'No due date';
  if (payment.overdue) {
    return `${payment.daysOverdue} day${payment.daysOverdue === 1 ? '' : 's'} overdue`;
  }
  if (payment.daysUntilDue === 0) return 'Due today';
  return `Due in ${payment.daysUntilDue} day${payment.daysUntilDue === 1 ? '' : 's'}`;
}

/** Which milestone the money is sitting at, spelled out. */
export function describeStage(payment) {
  if (!payment || payment.settled) return 'Nothing outstanding';
  return payment.stage === 'deposit' ? 'Deposit outstanding' : 'Balance outstanding';
}

/**
 * Whether the typed status and the money disagree — a booking marked Unpaid
 * that is fully paid up, say. Worth a quiet hint, never an automatic rewrite:
 * the club's own record of what it agreed is not the dashboard's to overwrite.
 */
export function statusDisagrees(payment) {
  // Pending is a state of the link, not of the money: it is expected to disagree.
  return (
    Boolean(payment) && !payment.settled && payment.status !== 'Pending' && payment.status !== payment.derivedStatus
  );
}

/**
 * What to ask for, worked out rather than left to the person sending it.
 *
 * The account's terms already say the deposit is 25% and when it falls due,
 * so the box opens on the stage that is actually next — the deposit while one
 * is owed, the balance once it is paid. Staff were reading the percentage off
 * the operator page and doing the sum themselves, which is both a waste and a
 * way to email a guest the wrong figure.
 */
export function nextStage(booking) {
  const payment = booking.payment;
  const stages = payment?.stages ?? [];
  // A booking from before the club began recording payments has a plan but no
  // ledger position, so `stage` is null while a deposit is still the thing to
  // ask for. Falling back to the first unsettled stage is what lets staff
  // take a deposit on an older booking - which is what brings it in.
  return (
    stages.find((stage) => stage.id === payment?.stage && !stage.settled) ?? stages.find((s) => !s.settled) ?? null
  );
}

export function defaultAmount(booking) {
  const stage = nextStage(booking);
  const outstanding = stage ? stage.outstanding : booking.payment?.outstanding;
  const value = Number.isFinite(outstanding) && outstanding > 0 ? outstanding : Number(booking.total) || 0;
  return String(Math.round(value * 100) / 100);
}

/** The amounts worth one click: each unsettled stage, and the lot. */
export function stageChoices(booking) {
  const payment = booking.payment;
  const list = (payment?.stages ?? [])
    .filter((stage) => !stage.settled && stage.outstanding > 0)
    .map((stage) => ({ id: stage.id, label: stage.label, amount: stage.outstanding, dueDate: stage.dueDate }));
  // Untracked: nothing is "outstanding" in ledger terms, so the whole value
  // is what "everything" means.
  const everything = Number(payment?.outstanding) || (payment?.tracked === false ? Number(payment?.gross) || 0 : 0);
  if (everything > 0 && !list.some((entry) => Math.abs(entry.amount - everything) < 0.005)) {
    list.push({ id: 'full', label: 'Everything outstanding', amount: everything, dueDate: null });
  }
  return list;
}

/**
 * Booked, and the club is still owed money on it.
 *
 * `outstanding` is the whole test. A booking taken before the club started
 * recording payments comes back settled with nothing outstanding -- a value,
 * not a balance -- so the back catalogue stays out of this on its own, without
 * this module having to know anything about the cutover.
 */
export function awaitingPayment(booking) {
  return normaliseStatus(booking?.status) === 'Booked' && Number(booking?.payment?.outstanding) > 0;
}

/**
 * A payment status, spelled as this module spells it.
 *
 * Deliberately not status.js's normaliseStatus: that one reads 'Pending' as
 * the Streamlit-era spelling of 'Inquiry', and here 'Pending' is a payment
 * link sent and not yet paid. The two vocabularies share a word and mean
 * different things by it.
 */
export function paymentStatusOf(status) {
  const text = String(status ?? '').trim();
  return PAYMENT_STATUSES.find((known) => known.toLowerCase() === text.toLowerCase()) ?? text;
}

/**
 * Where a payment status sits in the order staff work them.
 *
 * Sorting a column of words alphabetically puts "Deposit paid" above "Unpaid"
 * and tells nobody anything. This is the order money actually moves in, so
 * sorting by it puts the ones needing a call at one end.
 */
export function paymentRank(status) {
  const index = PAYMENT_STATUSES.indexOf(paymentStatusOf(status));
  return index === -1 ? PAYMENT_STATUSES.length : index;
}

/** How a booking's money stands, for filtering a list down to one kind. */
export const PAYMENT_VIEWS = [
  { id: '', label: 'Any payment state', match: () => true },
  { id: 'overdue', label: 'Overdue', match: (payment) => Boolean(payment?.overdue) },
  { id: 'due-soon', label: 'Due, not yet late', match: (payment) => !payment?.overdue && Boolean(payment?.dueDate) },
  { id: 'no-due-date', label: 'No due date set', match: (payment) => !payment?.dueDate },
  ...PAYMENT_STATUSES.map((status) => ({
    id: `status:${status}`,
    label: status,
    match: (payment) => paymentStatusOf(payment?.status) === status,
  })),
];

export function matchesPaymentView(booking, viewId) {
  if (!viewId) return true;
  const view = PAYMENT_VIEWS.find((entry) => entry.id === viewId);
  return view ? view.match(booking?.payment ?? null) : true;
}
