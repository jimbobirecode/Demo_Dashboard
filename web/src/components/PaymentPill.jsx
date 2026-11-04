import { paymentColor } from '../lib/payments.js';
import { OVERDUE } from '../lib/palette.js';

/**
 * The payment state, written out, with the lateness beside it.
 *
 * Colour is reinforcement only: the status is always spelled, and an overdue
 * balance says how many days late it is in words rather than turning red and
 * leaving the reader to infer it.
 *
 * A booking taken before the club began recording payments has no payment
 * state to show. Calling it "Unpaid" would be a claim about money nobody
 * tracked, so it says plainly that it is not tracked.
 */
export default function PaymentPill({ payment, status }) {
  if (payment?.tracked === false) {
    return (
      <span
        className="muted"
        style={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}
        title="Taken before the club started recording payments"
      >
        Not tracked
      </span>
    );
  }
  const label = payment?.status ?? status ?? 'Unpaid';

  return (
    <span className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
      <span className="status-pill" style={{ '--pill-color': paymentColor(label) }}>
        {label}
      </span>
      {payment?.overdue && (
        <span style={{ color: OVERDUE, fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
          <span aria-hidden="true">▲ </span>
          {payment.daysOverdue}d late
        </span>
      )}
    </span>
  );
}
