import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatCurrency, formatDateTime } from '../lib/format.js';

/** Fetched once per page load: whether the server can send links at all. */
let configRequest = null;
function loadConfig() {
  configRequest ??= api.paymentConfig().catch((err) => {
    configRequest = null;
    throw err;
  });
  return configRequest;
}

/**
 * Email the guest a Stripe payment link.
 *
 * Sending marks the booking's payment Pending; Stripe's webhook marks it Paid
 * (or Deposit paid for a part payment) once the guest pays. Nothing here marks
 * a booking paid — only Stripe does.
 */
export default function PaymentLinkPanel({ booking, onSend, onSendReceipt }) {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [amount, setAmount] = useState(() => defaultAmount(booking));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    let live = true;
    loadConfig()
      .then((value) => live && setConfig(value))
      .catch((err) => live && setConfigError(err.message));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    setAmount(defaultAmount(booking));
    setMessage(null);
  }, [booking.bookingId, booking.payment?.outstanding]);

  if (configError) return null;
  if (!config) return null;

  const closed = ['Rejected', 'Cancelled'].includes(booking.status);
  const sent = Boolean(booking.paymentLinkSentAt);
  const awaiting = sent && booking.paymentStatus === 'Pending';

  const paidViaStripe = Boolean(booking.stripePaidAt) && !awaiting;

  async function resendReceipt() {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ kind: 'success', text: await onSendReceipt(booking) });
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const value = Number(amount);
    const confirmText =
      `Email a ${formatCurrency(value)} payment link to ${booking.guestEmail}?` +
      (awaiting ? '\n\nThe link already sent will stop working.' : '');
    if (!window.confirm(confirmText)) return;

    setBusy(true);
    setMessage(null);
    try {
      const text = await onSend(booking, value);
      setMessage({ kind: 'success', text });
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
      <div className="between">
        <span className="label">Card payment link</span>
        {config.testMode && (
          <span className="secondary" style={{ fontSize: '0.75rem' }}>Stripe test mode</span>
        )}
      </div>

      {message && <div className={`banner ${message.kind}`}>{message.text}</div>}

      {sent && (
        <div className="secondary" style={{ fontSize: '0.8125rem' }}>
          {formatCurrency(booking.paymentLinkAmount)} link emailed {formatDateTime(booking.paymentLinkSentAt)}
          {booking.paymentLinkSentBy ? ` by ${booking.paymentLinkSentBy}` : ''} ·{' '}
          {paidViaStripe ? (
            <strong>paid via Stripe {formatDateTime(booking.stripePaidAt)}</strong>
          ) : awaiting ? (
            <strong>awaiting payment</strong>
          ) : (
            `payment now marked ${booking.paymentStatus}`
          )}
          {booking.paymentLinkUrl && awaiting && (
            <>
              {' '}·{' '}
              <button
                type="button"
                className="btn-sm"
                onClick={() => navigator.clipboard?.writeText(booking.paymentLinkUrl)}
                style={{ padding: '0.1rem 0.5rem' }}
              >
                Copy link
              </button>
            </>
          )}
        </div>
      )}

      {paidViaStripe && (
        <div className="secondary" style={{ fontSize: '0.8125rem' }}>
          {booking.lastPaymentAmount != null && <>{formatCurrency(booking.lastPaymentAmount)} received · </>}
          {booking.paymentReceiptSentAt ? (
            <>receipt emailed {formatDateTime(booking.paymentReceiptSentAt)}</>
          ) : (
            <strong style={{ color: 'var(--status-rejected, #DB4F7D)' }}>receipt not sent</strong>
          )}
          {onSendReceipt && (
            <>
              {' '}·{' '}
              <button
                type="button"
                className="btn-sm"
                onClick={resendReceipt}
                disabled={busy}
                style={{ padding: '0.1rem 0.5rem' }}
              >
                {booking.paymentReceiptSentAt ? 'Resend receipt' : 'Send receipt'}
              </button>
            </>
          )}
        </div>
      )}

      {booking.prePlayClockStartedAt && (
        <div className="secondary" style={{ fontSize: '0.8125rem' }}>
          Pre-play emails started {formatDateTime(booking.prePlayClockStartedAt)}
          {booking.preArrivalEmailSentAt
            ? ` · welcome sent ${formatDateTime(booking.preArrivalEmailSentAt)}`
            : ' · welcome listed on Guest Emails when due'}
        </div>
      )}

      {!config.migrated ? (
        <div className="secondary" style={{ fontSize: '0.8125rem' }}>
          Run <code>{config.migration}</code> on the database to enable payment links.
        </div>
      ) : !config.configured ? (
        <div className="secondary" style={{ fontSize: '0.8125rem' }}>
          Payment links are not set up. The server needs: {config.missing.join(', ')}.
        </div>
      ) : closed ? (
        <div className="secondary" style={{ fontSize: '0.8125rem' }}>
          A {booking.status.toLowerCase()} booking cannot be sent a payment link.
        </div>
      ) : !booking.guestEmail ? (
        <div className="secondary" style={{ fontSize: '0.8125rem' }}>
          This booking has no guest email address.
        </div>
      ) : (
        <div className="row" style={{ alignItems: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' }}>
          <label className="stack" style={{ gap: '0.25rem' }}>
            <span className="label">Amount ({config.currency})</span>
            <input
              type="number"
              min="0.5"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              disabled={busy}
              style={{ width: '9rem' }}
            />
          </label>
          <button
            type="button"
            className="btn-primary"
            onClick={send}
            disabled={busy || !(Number(amount) > 0)}
          >
            {busy ? 'Sending…' : sent ? 'Resend payment link' : 'Email payment link'}
          </button>
        </div>
      )}
    </div>
  );
}

function defaultAmount(booking) {
  const outstanding = booking.payment?.outstanding;
  const value = Number.isFinite(outstanding) && outstanding > 0 ? outstanding : Number(booking.total) || 0;
  return String(Math.round(value * 100) / 100);
}
