import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { formatCurrency, formatDate, formatDateTime, formatNumber } from '../lib/format.js';
import { OVERDUE } from '../lib/palette.js';
import KpiTile from '../components/KpiTile.jsx';
import StatusPill from '../components/StatusPill.jsx';

const CAMPAIGNS = [
  {
    id: 'booking_status',
    label: 'Booking status',
    blurb: 'Bookings of theirs that are not confirmed yet, before the tee sheet is given away',
    empty: 'Every operator booking in the window is confirmed.',
  },
  {
    id: 'payment_due',
    label: 'Payment due',
    blurb: 'What each account owes, what is already late, and under which terms',
    empty: 'Nothing is due or overdue on any trade account in this window.',
  },
];

/**
 * Reminder emails to tour operators.
 *
 * One email per account, not per booking: an operator with eleven open
 * bookings gets one message listing eleven lines, which is how a trade partner
 * reads their post.
 *
 * Sending is always explicit — accounts are picked, previewed with a dry run
 * that renders exactly what would go out, then sent. Every booking that went
 * into an email is stamped, so the same line is not chased again tomorrow; a
 * booking that has only just fallen due still pulls its account back into the
 * list on its own.
 */
export default function Reminders() {
  const [campaignId, setCampaignId] = useState(CAMPAIGNS[0].id);
  const [scope, setScope] = useState('due');
  const [config, setConfig] = useState(null);
  const [pending, setPending] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [expanded, setExpanded] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [results, setResults] = useState(null);

  const campaign = CAMPAIGNS.find((entry) => entry.id === campaignId);

  useEffect(() => {
    let live = true;
    api
      .reminderConfig()
      .then((payload) => live && setConfig(payload))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await api.remindersPending(campaignId, scope);
      setPending(payload);
      // Pre-tick the accounts that can actually be written to and have
      // something that has not just been chased.
      setSelected(
        new Set(
          payload.reminders
            .filter((reminder) => reminder.sendable && reminder.freshCount > 0)
            .map((reminder) => reminder.operatorId),
        ),
      );
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
    setExpanded(new Set());
    load();
  }, [load]);

  const reminders = useMemo(() => pending?.reminders ?? [], [pending]);
  const ready = Boolean(config?.campaigns?.[campaignId]?.configured && config?.hasApiKey && config?.fromEmail);

  const totals = useMemo(
    () =>
      reminders.reduce(
        (sum, reminder) => ({
          bookings: sum.bookings + reminder.bookings.length,
          outstanding: sum.outstanding + reminder.totalOutstanding,
          overdue: sum.overdue + reminder.totalOverdue,
          unsendable: sum.unsendable + (reminder.sendable ? 0 : 1),
        }),
        { bookings: 0, outstanding: 0, overdue: 0, unsendable: 0 },
      ),
    [reminders],
  );

  function toggle(operatorId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(operatorId)) next.delete(operatorId);
      else next.add(operatorId);
      return next;
    });
  }

  function toggleExpanded(operatorId) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(operatorId)) next.delete(operatorId);
      else next.add(operatorId);
      return next;
    });
  }

  function toggleAll() {
    const sendable = reminders.filter((reminder) => reminder.sendable);
    setSelected((current) =>
      current.size === sendable.length ? new Set() : new Set(sendable.map((r) => r.operatorId)),
    );
  }

  async function run({ dryRun }) {
    const ids = reminders
      .filter((reminder) => selected.has(reminder.operatorId))
      .map((reminder) => reminder.operatorId);

    if (!ids.length) {
      setNotice({ kind: 'error', text: 'Select at least one account first.' });
      return;
    }

    if (!dryRun) {
      const repeats = reminders
        .filter((reminder) => selected.has(reminder.operatorId))
        .reduce((sum, reminder) => sum + (reminder.bookings.length - reminder.freshCount), 0);
      const warning = repeats
        ? `\n\n${repeats} booking(s) in these emails were already chased in the last ${
            pending?.resendGuardDays ?? 7
          } days.`
        : '';
      if (!window.confirm(`Send the ${campaign.label.toLowerCase()} reminder to ${ids.length} account(s)?${warning}`)) {
        return;
      }
    }

    setBusy(true);
    setNotice(null);
    try {
      const payload = await api.sendReminders(campaignId, ids, { dryRun, scope });
      setResults(payload);

      if (dryRun) {
        setNotice({
          kind: 'success',
          text: `Preview: ${payload.results.filter((r) => r.status === 'would_send').length} email(s) would be sent, ${payload.failed} would fail.`,
        });
      } else {
        setNotice({
          kind: payload.failed && !payload.sent ? 'error' : 'success',
          text: `Sent ${payload.sent} reminder(s)${payload.failed ? `, ${payload.failed} failed` : ''}.`,
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

  return (
    <div className="stack">
      <div className="between">
        <div>
          <h1>Operator Reminders</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            {campaign.blurb}
          </p>
        </div>
        <button type="button" onClick={load} disabled={loading || busy}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {config && !config.configured && (
        <div className="banner error">
          Reminder email is not configured. Set {config.missing.join(', ')} in the environment, then restart the
          dashboard. The list below still shows who is due.
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
          label="Accounts due"
          value={formatNumber(reminders.length)}
          sub={totals.unsendable ? `${totals.unsendable} with no contact email` : 'All have a contact address'}
          accent="var(--brand-gold)"
        />
        <KpiTile
          label="Bookings listed"
          value={formatNumber(totals.bookings)}
          sub="Across every reminder in this run"
          accent="var(--north-sea)"
        />
        <KpiTile
          label={campaignId === 'payment_due' ? 'Outstanding' : 'Value at risk'}
          value={formatCurrency(totals.outstanding)}
          sub={campaignId === 'payment_due' ? 'Money these emails are chasing' : 'Not yet confirmed'}
          accent="var(--links-green)"
        />
        <KpiTile
          label="Overdue"
          value={formatCurrency(totals.overdue)}
          sub="Already past the due date"
          accent={totals.overdue > 0 ? OVERDUE : 'var(--muted, #8a8a8a)'}
        />
        <KpiTile
          label="Window"
          value={days === undefined ? '—' : `${days} days`}
          sub={
            campaignId === 'booking_status'
              ? 'Play dates looked ahead to'
              : 'Due dates looked ahead to, plus everything already late'
          }
          accent={ready ? 'var(--status-booked)' : 'var(--status-rejected)'}
        />
      </div>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Which accounts to list">
          <button type="button" aria-pressed={scope === 'due'} onClick={() => setScope('due')}>
            Due now
          </button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            Include recently chased
          </button>
        </div>
        <span className="grow" />
        <button type="button" onClick={() => run({ dryRun: true })} disabled={busy || !reminders.length}>
          Preview ({selected.size})
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => run({ dryRun: false })}
          disabled={busy || !ready || !selected.size}
          title={ready ? undefined : 'SendGrid is not configured'}
        >
          {busy ? 'Sending…' : `Send ${campaign.label.toLowerCase()} reminder`}
        </button>
      </div>

      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  style={{ width: 'auto' }}
                  checked={reminders.length > 0 && selected.size === reminders.filter((r) => r.sendable).length}
                  onChange={toggleAll}
                  disabled={!reminders.length}
                />
              </th>
              <th>Account</th>
              <th>Credit terms</th>
              <th className="num">Bookings</th>
              <th className="num">{campaignId === 'payment_due' ? 'Outstanding' : 'Value'}</th>
              <th>Worst line</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {reminders.map((reminder) => (
              <Fragmentish key={reminder.operatorId}>
                <tr className={selected.has(reminder.operatorId) ? 'selected' : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      aria-label={`Select ${reminder.operatorName}`}
                      checked={selected.has(reminder.operatorId)}
                      onChange={() => toggle(reminder.operatorId)}
                      disabled={!reminder.sendable}
                    />
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{reminder.operatorName}</div>
                    <div
                      className={reminder.sendable ? 'muted' : undefined}
                      style={{ fontSize: '0.75rem', color: reminder.sendable ? undefined : OVERDUE }}
                    >
                      {reminder.sendable
                        ? `${reminder.contactName ? `${reminder.contactName} · ` : ''}${reminder.contactEmail}`
                        : reminder.blocker}
                    </div>
                    {reminder.onHold && (
                      <div style={{ fontSize: '0.75rem', color: OVERDUE, fontWeight: 600 }}>On hold</div>
                    )}
                  </td>
                  <td className="secondary" style={{ fontSize: '0.8125rem' }}>
                    {reminder.terms}
                  </td>
                  <td className="num">
                    {formatNumber(reminder.bookings.length)}
                    {reminder.freshCount < reminder.bookings.length && (
                      <div className="muted" style={{ fontSize: '0.75rem' }}>
                        {reminder.bookings.length - reminder.freshCount} recently chased
                      </div>
                    )}
                  </td>
                  <td className="num">{formatCurrency(reminder.totalOutstanding)}</td>
                  <td style={reminder.maxDaysOverdue > 0 ? { color: OVERDUE, fontWeight: 600 } : undefined}>
                    {reminder.maxDaysOverdue > 0
                      ? `${reminder.maxDaysOverdue} days overdue`
                      : (reminder.bookings[0]?.reason ?? '—')}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-sm"
                      onClick={() => toggleExpanded(reminder.operatorId)}
                      aria-expanded={expanded.has(reminder.operatorId)}
                    >
                      {expanded.has(reminder.operatorId) ? 'Hide lines' : 'Show lines'}
                    </button>
                  </td>
                </tr>

                {expanded.has(reminder.operatorId) && (
                  <tr>
                    <td />
                    <td colSpan={6}>
                      <LineItems lines={reminder.bookings} campaignId={campaignId} />
                    </td>
                  </tr>
                )}
              </Fragmentish>
            ))}
          </tbody>
        </table>

        {!loading && !reminders.length && (
          <div className="empty">
            {campaign.empty}
            {scope === 'due' && ' Accounts chased in the last few days are hidden — widen the window above.'}
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
                  <th>Account</th>
                  <th>Email</th>
                  <th className="num">Lines</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {results.results.map((row) => (
                  <tr key={row.operatorId}>
                    <td>{row.operatorName ?? '—'}</td>
                    <td>{row.email ?? '—'}</td>
                    <td className="num">{formatNumber(row.bookings)}</td>
                    <td style={{ color: row.status === 'failed' ? 'var(--status-rejected)' : undefined }}>
                      {OUTCOME_LABELS[row.status] ?? row.status}
                    </td>
                    <td className="secondary">{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {results.dryRun && results.results[0]?.preview && (
            <details>
              <summary className="label" style={{ cursor: 'pointer' }}>
                What {results.results[0].operatorName} would receive
              </summary>
              <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem', marginTop: '0.5rem' }}>
                {results.results[0].preview.booking_lines}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function LineItems({ lines, campaignId }) {
  return (
    <table className="data" style={{ margin: 0 }}>
      <thead>
        <tr>
          <th>Booking</th>
          <th>Guest</th>
          <th>Tee date</th>
          <th className="num">Players</th>
          <th>Status</th>
          {campaignId === 'payment_due' && <th className="num">Outstanding</th>}
          {campaignId === 'payment_due' && <th>Due</th>}
          <th>Why it is listed</th>
          <th>Last chased</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.bookingId}>
            <td className="mono">{line.bookingId}</td>
            <td>{line.guestName || '—'}</td>
            <td>{formatDate(line.date)}</td>
            <td className="num">{formatNumber(line.players)}</td>
            <td>
              <StatusPill status={line.status} />
            </td>
            {campaignId === 'payment_due' && <td className="num">{formatCurrency(line.outstanding)}</td>}
            {campaignId === 'payment_due' && (
              <td>{line.dueDate ? formatDate(line.dueDate) : <span className="muted">—</span>}</td>
            )}
            <td style={line.overdue ? { color: OVERDUE, fontWeight: 600 } : undefined}>{line.reason}</td>
            <td className={line.sentAt ? undefined : 'muted'} style={{ fontSize: '0.8125rem' }}>
              {line.sentAt ? formatDateTime(line.sentAt) : 'Never'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A keyed pair of sibling rows; <tbody> will not take a <div> between them. */
function Fragmentish({ children }) {
  return <>{children}</>;
}

const OUTCOME_LABELS = {
  sent: 'Sent',
  failed: 'Failed',
  would_send: 'Would send',
};
