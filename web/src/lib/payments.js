/**
 * The money side of a booking, as the SPA sees it.
 *
 * The arithmetic all happens on the server (`server/src/lib/operators-domain.js`)
 * and arrives on every booking as `booking.payment`. This module only holds the
 * vocabulary the screen needs: what each state is called, what colour carries
 * it, and how a due date is put into words.
 */
import { INK_MUTED, OVERDUE, PAYMENT_COLORS } from './palette.js';

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
