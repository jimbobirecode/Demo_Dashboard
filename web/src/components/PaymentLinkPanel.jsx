import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatCurrency, formatDateTime } from '../lib/format.js';

/**
 * Fetched each time the panel opens rather than once per page: it carries the
 * recent webhook deliveries, which are the thing somebody is looking for when
 * a payment has not shown up.
 */
function loadConfig() {
  return api.paymentConfig();
}

/**
 * Email the guest a Stripe payment link.
 *
 * Sending marks the booking's payment Pending; Stripe's webhook marks it Paid
 * (or Deposit paid for a part payment) once the guest pays. Nothing here marks
 * a booking paid — only Stripe does.
 */
export default function PaymentLinkPanel({ booking, onSend, onSendReceipt, onCheck }) {
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

  // Opening a booking that is still awaiting payment asks Stripe directly, so
  // a payment whose webhook never arrived is picked up the moment anyone looks.
  const awaitingNow = Boolean(booking.paymentLinkSentAt) && booking.paymentStatus === 'Pending';
  useEffect(() => {
    if (!awaitingNow || !onCheck) return;
    let live = true;
    onCheck(booking, { quiet: true })
      .then((result) => live && result?.found && setMessage({ kind: 'success', text: result.message }))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.bookingId, awaitingNow]);

  if (configError) return null;
  if (!config) return null;

  const closed = ['Rejected', 'Cancelled'].includes(booking.status);
  const sent = Boolean(booking.paymentLinkSentAt);
  const awaiting = sent && booking.paymentStatus === 'Pending';

  const paidViaStripe = Boolean(booking.stripePaidAt) && !awaiting;

  async function checkStripe() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await onCheck(booking);
      setMessage({ kind: result.found ? 'success' : 'info', text: result.message });
      setConfig(await loadConfig());
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

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
          {awaiting && onCheck && (
            <>
              {' '}·{' '}
              <button
                type="button"
                className="btn-sm"
                onClick={checkStripe}
                disabled={busy}
                style={{ padding: '0.1rem 0.5rem' }}
              >
                Check Stripe for payment
              </button>
            </>
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

      {awaiting && <WebhookStatus webhooks={config.webhooks} />}
      {(awaiting || !config.configured) && <SetupCheck />}

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

      {!config.configured ? (
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

/**
 * Whether Stripe's webhook is reaching this server, in words. A payment that
 * has not shown up is almost always one of: no endpoint in Stripe, the wrong
 * signing secret, or the endpoint in the other mode (test vs live).
 */
function WebhookStatus({ webhooks }) {
  if (!webhooks) return null;
  const [last] = webhooks.entries;
  const style = { fontSize: '0.8125rem' };

  if (!last) {
    return (
      <div className="secondary" style={style}>
        No webhook from Stripe since the server started ({formatDateTime(webhooks.startedAt)}). If the guest has
        paid, check Stripe → Developers → Webhooks has an endpoint for <code>/api/stripe/webhook</code> in the same
        mode (test or live) as the payment.
      </div>
    );
  }

  const problem = last.outcome === 'rejected' || last.outcome === 'failed';
  return (
    <div className={problem ? 'banner error' : 'secondary'} style={style}>
      Last Stripe webhook {formatDateTime(last.at)}: <strong>{last.outcome}</strong>
      {last.type ? ` (${last.type})` : ''}
      {last.bookingId ? ` for ${last.bookingId}` : ''}
      {last.detail ? ` — ${last.detail}` : ''}
    </div>
  );
}

/**
 * Every link from "guest pays" to "booking shows Paid", checked for real —
 * including asking Stripe which webhook endpoints it has. Each failed step
 * says what to change.
 */
function SetupCheck() {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.paymentDiagnostics());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!result) {
    return (
      <div>
        <button type="button" className="btn-sm" onClick={run} disabled={busy} style={{ padding: '0.1rem 0.6rem' }}>
          {busy ? 'Checking…' : 'Check payment setup'}
        </button>
        {error && <div className="banner error" style={{ marginTop: '0.4rem' }}>{error}</div>}
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: '0.35rem', fontSize: '0.8125rem' }}>
      <div className="between">
        <span className="label">Payment setup</span>
        <button type="button" className="btn-sm" onClick={run} disabled={busy} style={{ padding: '0.1rem 0.6rem' }}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {result.checks.map((check) => (
        <div key={check.id} style={{ display: 'grid', gridTemplateColumns: '1.2rem 1fr', gap: '0.4rem' }}>
          <span aria-hidden="true" style={{ color: check.ok === false ? 'var(--status-rejected, #DB4F7D)' : check.ok ? 'var(--brand-gold-bright)' : 'var(--text-muted)' }}>
            {check.ok === false ? '✗' : check.ok ? '✓' : '?'}
          </span>
          <div>
            <strong>{check.label}</strong> <span className="secondary">— {check.detail}</span>
            {check.fix && <div style={{ color: 'var(--text-primary)' }}>→ {check.fix}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function defaultAmount(booking) {
  const outstanding = booking.payment?.outstanding;
  const value = Number.isFinite(outstanding) && outstanding > 0 ? outstanding : Number(booking.total) || 0;
  return String(Math.round(value * 100) / 100);
}
