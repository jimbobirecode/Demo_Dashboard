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

      <div className="detail-grid">
        <Cell label="Total" value={formatCurrency(payment.gross)} />
        <Cell label="Paid" value={formatCurrency(payment.paid)} />
        <Cell label="Outstanding" value={formatCurrency(payment.outstanding)} accent />
        <Cell
          label={payment.stage === 'deposit' ? 'Deposit due' : 'Balance due'}
          value={payment.dueDate ? formatDate(payment.dueDate) : '—'}
        />
      </div>

      <div className="secondary" style={{ fontSize: '0.8125rem' }}>
        {describeStage(payment)} ·{' '}
        <span style={payment.overdue ? { color: OVERDUE, fontWeight: 600 } : undefined}>{describeDue(payment)}</span>
        {payment.depositAmount > 0 && (
          <>
            {' '}
            · deposit {formatCurrency(payment.depositAmount)} by{' '}
            {payment.depositDueDate ? formatDate(payment.depositDueDate) : 'the account terms'}
          </>
        )}
      </div>

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
