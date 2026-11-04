import { useEffect, useState } from 'react';
import PaymentPill from './PaymentPill.jsx';
import PaymentLinkPanel from './PaymentLinkPanel.jsx';
import { formatCurrency, formatDate } from '../lib/format.js';
import { OVERDUE } from '../lib/palette.js';
import { PAYMENT_STATUSES, describeDue, describeStage, statusDisagrees } from '../lib/payments.js';

/**
 * The money on one booking: which account it sits on, what is owed, and when.
 *
 * The due dates are shown as the account's terms resolve them, and the two
 * date fields below only exist to override that for the one booking that was
 * agreed differently — clearing a field hands it back to the terms rather than
 * leaving a blank.
 */
export default function PaymentPanel({
  booking,
  operators,
  onSave,
  onAssign,
  onSendLink,
  onSendReceipt,
  onCheckPayment,
}) {
  const payment = booking.payment;
  const [form, setForm] = useState(() => toForm(booking));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    setForm(toForm(booking));
    setMessage(null);
    // Reset only when the stored payment fields change, so a re-render with a
    // fresh booking object does not throw away what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    booking.bookingId,
    booking.paymentStatus,
    booking.amountPaid,
    booking.invoiceNumber,
    booking.invoicedAt,
    booking.depositDueDate,
    booking.balanceDueDate,
  ]);

  if (!payment) return null;

  // A booking from before the club began recording payments has a value and
  // no ledger position. Showing it "Paid €0 · Outstanding €0 · Settled" reads
  // as though the money had been collected.
  const tracked = payment.tracked !== false;

  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(booking));

  async function run(action, successMessage) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      if (successMessage) setMessage({ kind: 'success', text: successMessage });
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack" style={{ background: 'var(--surface-0)', gap: '0.75rem' }}>
      <div className="between">
        <div className="label">Trade account &amp; payment</div>
        <PaymentPill payment={payment} />
      </div>

      {message && <div className={`banner ${message.kind}`}>{message.text}</div>}

      {payment.tracked === false && (
        <div className="secondary" style={{ fontSize: '0.8125rem' }}>
          Taken before the club began recording payments, so this booking carries its value and no balance. The
          account&rsquo;s terms still apply: sending a deposit link below brings it into the ledger, and the balance
          follows from there.
        </div>
      )}

      {/* Whose terms these figures come from. On a trade booking the account's
          terms are what decide the deposit and both due dates, and staff were
          reading the numbers with no way to see the rule behind them. */}
      {payment.terms && (
        <div className="secondary" style={{ fontSize: '0.8125rem' }}>
          {payment.terms.source === 'operator' ? (
            <>
              <strong>{payment.terms.operatorName}</strong> terms: {payment.terms.summary}
            </>
          ) : (
            <>Direct booking · {payment.terms.summary === 'No account terms' ? 'net 30 days' : payment.terms.summary}</>
          )}
        </div>
      )}

      <div className="detail-grid">
        <Cell label={tracked ? 'Total' : 'Value'} value={formatCurrency(payment.gross)} accent={!tracked} />
        {tracked && <Cell label="Paid" value={formatCurrency(payment.paid)} />}
        {tracked && <Cell label="Outstanding" value={formatCurrency(payment.outstanding)} accent />}
        {tracked && (
          <Cell
            label={payment.stage === 'deposit' ? 'Deposit due' : 'Balance due'}
            value={payment.dueDate ? formatDate(payment.dueDate) : '—'}
          />
        )}
      </div>

      {/* Stage by stage, because that is how the money is taken: the deposit
          first, the balance after. What has been paid fills the deposit
          before the balance, so each line owes what it actually owes. */}
      {tracked && payment.stages?.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Stage</th>
                <th className="num">Amount</th>
                <th className="num">Paid</th>
                <th className="num">Outstanding</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {payment.stages.map((stage) => (
                <tr key={stage.id} style={stage.settled ? { opacity: 0.65 } : undefined}>
                  <td>
                    {stage.label}
                    {!stage.settled && payment.stage === stage.id && (
                      <span className="muted" style={{ fontSize: '0.75rem' }}>
                        {' '}
                        · next
                      </span>
                    )}
                  </td>
                  <td className="num">{formatCurrency(stage.amount)}</td>
                  <td className="num">{formatCurrency(stage.paid)}</td>
                  <td className="num" style={stage.outstanding > 0 ? { fontWeight: 600 } : undefined}>
                    {formatCurrency(stage.outstanding)}
                  </td>
                  <td style={{ fontSize: '0.8125rem' }}>
                    {stage.settled ? (
                      <span className="muted">Settled</span>
                    ) : (
                      <>
                        <span style={stage.overdue ? { color: OVERDUE, fontWeight: 600 } : undefined}>
                          {stage.dueDate ? formatDate(stage.dueDate) : 'No due date'}
                        </span>
                        <div className={stage.overdue ? undefined : 'muted'} style={{ fontSize: '0.75rem' }}>
                          {stage.overdue
                            ? `${stage.daysOverdue} day${stage.daysOverdue === 1 ? '' : 's'} overdue`
                            : stage.daysUntilDue === 0
                              ? 'Due today'
                              : `in ${stage.daysUntilDue} day${stage.daysUntilDue === 1 ? '' : 's'}`}
                          {/* A date agreed for this booking alone, not one the
                              account's terms produced: say so, so nobody
                              "corrects" it back to the terms. */}
                          {stage.overridden ? ' · set on this booking' : ''}
                        </div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tracked && (
        <div className="secondary" style={{ fontSize: '0.8125rem' }}>
          {describeStage(payment)} ·{' '}
          <span style={payment.overdue ? { color: OVERDUE, fontWeight: 600 } : undefined}>{describeDue(payment)}</span>
        </div>
      )}

      {statusDisagrees(payment) && (
        <div className="banner">
          The money recorded here reads as <strong>{payment.derivedStatus}</strong>, but the booking is marked{' '}
          <strong>{payment.status}</strong>. Nothing has been changed — the club&apos;s own record of what was agreed is
          not overwritten automatically.
        </div>
      )}

      {onSendLink && (
        <PaymentLinkPanel
          booking={booking}
          onSend={onSendLink}
          onSendReceipt={onSendReceipt}
          onCheck={onCheckPayment}
        />
      )}

      {onAssign && (
        <div className="stack" style={{ gap: '0.25rem' }}>
          <span className="label">Account</span>
          <select
            aria-label="Tour operator"
            value={booking.tourOperatorId ?? ''}
            disabled={busy}
            onChange={(event) =>
              run(
                () => onAssign(booking, event.target.value === '' ? null : Number(event.target.value)),
                'Account updated',
              )
            }
          >
            <option value="">Direct booking</option>
            {operators.map((operator) => (
              <option key={operator.id} value={operator.id}>
                {operator.name}
                {operator.onHold ? ' (on hold)' : ''}
              </option>
            ))}
          </select>
          {booking.operatorName && booking.operatorMatch === 'domain' && !booking.tourOperatorId && (
            <span className="secondary" style={{ fontSize: '0.75rem' }}>
              Currently matched to {booking.operatorName} on its sending domain. Choosing an account here pins it,
              whatever address the next enquiry comes from.
            </span>
          )}
        </div>
      )}

      <div className="detail-grid">
        <Field label="Payment status">
          <select value={form.paymentStatus} onChange={set('paymentStatus')} disabled={busy}>
            {PAYMENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount paid">
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.amountPaid}
            onChange={set('amountPaid')}
            disabled={busy}
          />
        </Field>
        <Field label="Invoice number">
          <input value={form.invoiceNumber} onChange={set('invoiceNumber')} disabled={busy} />
        </Field>
        <Field label="Invoiced on">
          <input type="date" value={form.invoicedAt} onChange={set('invoicedAt')} disabled={busy} />
        </Field>
        <Field label="Deposit due (override)">
          <input type="date" value={form.depositDueDate} onChange={set('depositDueDate')} disabled={busy} />
        </Field>
        <Field label="Balance due (override)">
          <input type="date" value={form.balanceDueDate} onChange={set('balanceDueDate')} disabled={busy} />
        </Field>
      </div>

      <div className="row">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !dirty}
          onClick={() => run(() => onSave(booking, toPayload(form)), 'Payment saved')}
        >
          {busy ? 'Saving…' : 'Save payment'}
        </button>
        {dirty && (
          <button type="button" onClick={() => setForm(toForm(booking))} disabled={busy}>
            Discard
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="stack" style={{ gap: '0.25rem' }}>
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

function Cell({ label, value, accent }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div
        style={{
          fontSize: accent ? '1.125rem' : '0.9375rem',
          fontWeight: accent ? 700 : 600,
          color: accent ? 'var(--brand-gold-bright)' : 'var(--text-primary)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function toForm(booking) {
  return {
    paymentStatus: booking.paymentStatus ?? 'Unpaid',
    amountPaid: String(booking.amountPaid ?? 0),
    invoiceNumber: booking.invoiceNumber ?? '',
    invoicedAt: booking.invoicedAt ?? '',
    depositDueDate: booking.depositDueDate ?? '',
    balanceDueDate: booking.balanceDueDate ?? '',
  };
}

/** An emptied date is sent as null, which clears the override on the server. */
function toPayload(form) {
  return {
    paymentStatus: form.paymentStatus,
    amountPaid: Number(form.amountPaid) || 0,
    invoiceNumber: form.invoiceNumber,
    invoicedAt: form.invoicedAt || null,
    depositDueDate: form.depositDueDate || null,
    balanceDueDate: form.balanceDueDate || null,
  };
}
