import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { formatDate, formatDateTime, formatNumber } from '../lib/format.js';
import StatusPill from '../components/StatusPill.jsx';
import KpiTile from '../components/KpiTile.jsx';

/** The API caps one run; a wide catch-up window can hold more than that. */
const BATCH_SIZE = 200;

const CAMPAIGNS = [
  { id: 'pre_arrival', label: 'Pre-arrival welcome', sentLabel: 'Welcome sent' },
  { id: 'post_play', label: 'Post-play thank you', sentLabel: 'Thank you sent' },
];

/**
 * Customer-journey email campaigns.
 *
 * Two sends run off the tee sheet — a welcome before arrival and a thank you
 * after play. The page lists who is due, and sending is always explicit: rows
 * are picked, previewed with a dry run, then sent. Guests already emailed stay
 * in the list, unticked and stamped with when they were written to, so a
 * deliberate resend is possible and an accidental one is not.
 *
 * Where Club Vero is connected, the thank-you also carries that guest's survey
 * link. The page says so rather than leaving it to the environment: a campaign
 * whose emails carry a link behaves differently when Vero cannot be reached —
 * the send is held rather than going out with a dead button — and somebody
 * reading a run's results needs to know which mode they are in.
 */
export default function Emails() {
  const [campaignId, setCampaignId] = useState(CAMPAIGNS[0].id);
  const [scope, setScope] = useState('due');
  const [config, setConfig] = useState(null);
  const [pending, setPending] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [results, setResults] = useState(null);

  const campaign = CAMPAIGNS.find((entry) => entry.id === campaignId);

  useEffect(() => {
    let live = true;
    api
      .emailConfig()
      .then((payload) => live && setConfig(payload))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await api.emailPending(campaignId, scope);
      setPending(payload);
      // Pre-tick everyone who has not been written to yet: that is the run the
      // page exists for, and a resend has to be asked for by hand.
      setSelected(new Set(payload.bookings.filter((b) => !b.sentAt).map((b) => b.bookingId)));
      setError(null);
    } catch (err) {
      setError(err.message);
      setPending(null);
    } finally {
      setLoading(false);
    }
  }, [campaignId, scope]);

  useEffect(() => {
    setResults(null);
    setNotice(null);
    load();
  }, [load]);

  const bookings = useMemo(() => pending?.bookings ?? [], [pending]);
  const unsentCount = useMemo(() => bookings.filter((b) => !b.sentAt).length, [bookings]);
  const ready = Boolean(config?.campaigns?.[campaignId]?.configured && config?.hasApiKey && config?.fromEmail);
  const vero = config?.vero ?? null;
  // Connected AND switched on for the campaign on screen. Those are different
  // questions: pre-arrival deliberately carries no survey link even when the
  // integration is running.
  const veroOn = Boolean(vero?.enabled && vero.campaigns?.includes(campaignId));

  function toggle(bookingId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(bookingId)) next.delete(bookingId);
      else next.add(bookingId);
      return next;
    });
  }

  function toggleAll() {
    setSelected((current) =>
      current.size === bookings.length ? new Set() : new Set(bookings.map((b) => b.bookingId)),
    );
  }

  async function run({ dryRun }) {
    const ids = bookings.filter((b) => selected.has(b.bookingId)).map((b) => b.bookingId);
    if (!ids.length) {
      setNotice({ kind: 'error', text: 'Select at least one booking first.' });
      return;
    }
    if (!dryRun) {
      const resends = bookings.filter((b) => selected.has(b.bookingId) && b.sentAt).length;
      const warning = resends
        ? `\n\n${resends} of them already received this email — they will get it again.`
        : '';
      if (!window.confirm(`Send the ${campaign.label.toLowerCase()} to ${ids.length} guest(s)?${warning}`)) {
        return;
      }
    }

    setBusy(true);
    setNotice(null);
    try {
      const payload = await sendInBatches(campaignId, ids, dryRun);
      setResults(payload);

      if (dryRun) {
        setNotice({
          kind: 'success',
          text: `Preview: ${payload.results.filter((r) => r.status === 'would_send').length} email(s) would be sent, ${
            payload.failed
          } would fail${payload.skipped ? `, ${payload.skipped} would be skipped (unsubscribed)` : ''}.`,
        });
      } else {
        setNotice({
          kind: payload.failed && !payload.sent ? 'error' : 'success',
          text: `Sent ${payload.sent} email(s)${payload.failed ? `, ${payload.failed} failed` : ''}${
            // Named separately from the failures, because it is not one: these
            // guests asked not to be contacted and were not.
            payload.skipped ? `, ${payload.skipped} skipped (unsubscribed)` : ''
          }.`,
        });
        await load();
      }
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const days = config?.campaigns?.[campaignId]?.days;
  const timing =
    days === undefined
      ? '—'
      : `${days} day${days === 1 ? '' : 's'} ${campaignId === 'pre_arrival' ? 'before' : 'after'} play`;

  return (
    <div className="stack">
      <div className="between">
        <div>
          <h1>Guest Emails</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Welcome and thank-you emails for confirmed visitor bookings
          </p>
        </div>
        <button type="button" onClick={load} disabled={loading || busy}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {config && !config.configured && (
        <div className="banner error">
          Email sending is not configured. Set {config.missing.join(', ')} in the environment,
          then restart the dashboard.
        </div>
      )}

      {vero?.enabled === false && vero.campaigns?.includes(campaignId) === true && (
        <div className="banner error">
          Club Vero is meant to carry the survey link on this campaign, but it is not configured.
          Set {vero.missing.join(', ')} in the environment, then restart the dashboard.
        </div>
      )}

      <div className="segmented" role="group" aria-label="Campaign">
        {CAMPAIGNS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={entry.id === campaignId}
            onClick={() => setCampaignId(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="kpi-row">
        <KpiTile
          label="Due now"
          value={formatNumber(unsentCount)}
          sub={`Not yet ${campaignId === 'pre_arrival' ? 'welcomed' : 'thanked'}`}
          accent="var(--brand-gold)"
        />
        <KpiTile
          label="In this window"
          value={formatNumber(bookings.length)}
          sub={
            scope !== 'due'
              ? 'Wider catch-up window'
              : pending?.startsOnPayment
                ? `Paid, playing in the next ${pending.days} days`
                : 'Play date due today'
          }
          accent="var(--north-sea)"
        />
        <KpiTile
          label={scope === 'due' ? (pending?.startsOnPayment ? 'Playing by' : 'Target play date') : 'Campaign timing'}
          value={scope === 'due' ? (pending ? formatDate(pending.targetDate) : '—') : timing}
          sub={
            scope === 'due'
              ? timing
              : `Normally sent on ${pending ? formatDate(pending.targetDate) : 'the due date'}`
          }
          accent="var(--links-green)"
        />
        <KpiTile
          label="Template"
          value={ready ? 'Ready' : 'Not set'}
          sub={config?.fromEmail ? `From ${config.fromEmail}` : 'No sender address'}
          accent={ready ? 'var(--status-booked)' : 'var(--status-rejected)'}
        />
        <KpiTile
          label="Club Vero"
          value={veroOn ? 'Linked' : 'Not linked'}
          sub={
            veroOn
              ? 'Each email carries that guest’s survey link'
              : vero?.enabled
                ? 'Connected, but not on this campaign'
                : 'Feedback is not collected anywhere'
          }
          accent={veroOn ? 'var(--links-green)' : 'var(--muted, #8a8a8a)'}
        />
      </div>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Which bookings to list">
          <button type="button" aria-pressed={scope === 'due'} onClick={() => setScope('due')}>
            Due now
          </button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            {campaignId === 'pre_arrival' ? 'All upcoming' : 'Last 30 days'}
          </button>
        </div>
        <span className="grow" />
        <button type="button" onClick={() => run({ dryRun: true })} disabled={busy || !bookings.length}>
          Preview ({selected.size})
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => run({ dryRun: false })}
          disabled={busy || !ready || !selected.size}
          title={ready ? undefined : 'SendGrid is not configured'}
        >
          {busy ? 'Sending…' : `Send ${campaign.label.toLowerCase()}`}
        </button>
      </div>

      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}

      {pending?.startsOnPayment && pending.awaitingPayment > 0 && (
        <div className="banner">
          {formatNumber(pending.awaitingPayment)} booked {pending.awaitingPayment === 1 ? 'guest is' : 'guests are'} not
          listed because no payment has been received yet. Payment starts a guest&rsquo;s pre-play emails
          &mdash; a Stripe payment, or marking the payment Paid or Deposit paid in the booking.
        </div>
      )}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  style={{ width: 'auto' }}
                  checked={bookings.length > 0 && selected.size === bookings.length}
                  onChange={toggleAll}
                  disabled={!bookings.length}
                />
              </th>
              <th>Booking</th>
              <th>Guest</th>
              <th>Email</th>
              <th>Play date</th>
              <th>Tee time</th>
              <th className="num">Players</th>
              <th>Status</th>
              {pending?.startsOnPayment && <th>Paid</th>}
              <th>{campaign.sentLabel}</th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((booking) => (
              <tr key={booking.bookingId} className={selected.has(booking.bookingId) ? 'selected' : undefined}>
                <td>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    aria-label={`Select ${booking.bookingId}`}
                    checked={selected.has(booking.bookingId)}
                    onChange={() => toggle(booking.bookingId)}
                  />
                </td>
                <td className="mono">{booking.bookingId}</td>
                <td>{booking.guestName || '—'}</td>
                <td>{booking.guestEmail || <span className="muted">No address</span>}</td>
                <td>{formatDate(booking.date)}</td>
                <td>{booking.teeTime}</td>
                <td className="num">{formatNumber(booking.players)}</td>
                <td>
                  <StatusPill status={booking.status} />
                </td>
                {pending?.startsOnPayment && (
                  <td className={booking.clockStartedAt ? undefined : 'muted'}>
                    {!booking.clockStartedAt
                      ? 'Not paid'
                      : booking.clockStartedAt === 'before-tracking'
                        ? booking.paymentStatus
                        : formatDateTime(booking.clockStartedAt)}
                  </td>
                )}
                <td className={booking.sentAt ? undefined : 'muted'}>
                  {booking.sentAt ? formatDateTime(booking.sentAt) : 'Not sent'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && !bookings.length && (
          <div className="empty">
            No booked guests {campaignId === 'pre_arrival' ? 'are due a welcome' : 'are due a thank you'} in
            this window.
            {scope === 'due' && ' Try the wider window above.'}
          </div>
        )}
        {loading && <div className="empty">Loading…</div>}
      </div>

      {results && (
        <div className="card stack">
          <h2>{results.dryRun ? 'Preview' : 'Send results'}</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Booking</th>
                  <th>Email</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {results.results.map((row) => (
                  <tr key={row.bookingId}>
                    <td className="mono">{row.bookingId}</td>
                    <td>{row.email ?? '—'}</td>
                    <td style={{ color: row.status === 'failed' ? 'var(--status-rejected)' : undefined }} className={row.status === 'skipped' ? 'muted' : undefined}>
                      {OUTCOME_LABELS[row.status] ?? row.status}
                    </td>
                    <td className="secondary">{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Walks the selection in batches the API will accept, merging the runs into one
 * result. Batches run in sequence: a campaign should stop at the first refusal
 * rather than push the rest at SendGrid anyway.
 */
async function sendInBatches(campaignId, ids, dryRun) {
  const merged = { dryRun, sent: 0, failed: 0, skipped: 0, results: [] };

  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    const payload = await api.sendCampaign(campaignId, ids.slice(index, index + BATCH_SIZE), { dryRun });
    merged.sent += payload.sent;
    merged.failed += payload.failed;
    merged.skipped += payload.skipped ?? 0;
    merged.results.push(...payload.results);
  }

  return merged;
}

const OUTCOME_LABELS = {
  sent: 'Sent',
  failed: 'Failed',
  would_send: 'Would send',
  // Not a failure. The guest unsubscribed from feedback requests, and Club Vero
  // said so before the email went out.
  skipped: 'Skipped',
};
