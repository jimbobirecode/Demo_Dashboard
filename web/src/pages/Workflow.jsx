import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatCurrency, formatDate, formatDateTime, formatNumber } from '../lib/format.js';
import KpiTile from '../components/KpiTile.jsx';
import BookingLadder from '../components/BookingLadder.jsx';

/**
 * The booking trigger workflow.
 *
 * Every booking climbs a ladder — ask for the deposit, chase it, warn, cancel;
 * or, once it is paid, confirm, remind, welcome, thank — and this page is where
 * the club watches it happen. Three views of the same plan:
 *
 *   Due now     what a run would send today, which is also what the schedule
 *               would send if it is switched on
 *   Missed      rungs whose date went past before anybody was sending. The
 *               list to read on the first day, and the one that explains why a
 *               booking has gone quiet
 *   Every booking   the whole ladder for each booking, so "where has this one
 *               got to" is a glance rather than a conversation
 *
 * Sending is explicit even where the schedule is on: rows are picked, previewed
 * with a dry run, then sent. The preview walks exactly the same path as the real
 * run — same selection, same rendered email, same payment-link decision — so
 * what it reports is what would happen.
 */

const SCOPES = [
  { id: 'due', label: 'Due now' },
  { id: 'missed', label: 'Missed' },
  { id: 'all', label: 'Every live booking' },
];

const OUTCOME_LABELS = {
  sent: 'Sent',
  cancelled: 'Cancelled',
  failed: 'Failed',
  skipped: 'Skipped',
  superseded: 'Superseded',
  cleared: 'Cleared',
  would_send: 'Would send',
  would_supersede: 'Would supersede',
  needs_review: 'Waiting on a person',
};

export default function Workflow({ embedded = false }) {
  const [scope, setScope] = useState('due');
  const [config, setConfig] = useState(null);
  const [pending, setPending] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [results, setResults] = useState(null);

  useEffect(() => {
    let live = true;
    api
      .triggerConfig()
      .then((payload) => live && setConfig(payload))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await api.triggersPending(scope);
      setPending(payload);
      // Pre-tick everything a run would touch. On the other two views nothing
      // is ticked: those are for reading, and a missed rung is a decision
      // somebody has to make rather than a batch to fire off.
      setSelected(
        scope === 'due' ? new Set(payload.bookings.filter((row) => row.next).map((r) => r.bookingId)) : new Set(),
      );
      setError(null);
    } catch (err) {
      setError(err.message);
      setPending(null);
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    setResults(null);
    setNotice(null);
    setExpanded(null);
    load();
  }, [load]);

  const bookings = useMemo(() => pending?.bookings ?? [], [pending]);
  const dueCount = useMemo(() => bookings.filter((row) => row.next).length, [bookings]);
  const stepsById = useMemo(() => new Map((config?.steps ?? []).map((step) => [step.id, step])), [config]);

  function toggle(bookingId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(bookingId)) next.delete(bookingId);
      else next.add(bookingId);
      return next;
    });
  }

  function toggleAll() {
    const selectable = bookings.filter((row) => row.next).map((row) => row.bookingId);
    setSelected((current) => (current.size === selectable.length ? new Set() : new Set(selectable)));
  }

  async function run({ dryRun }) {
    const ids = bookings.filter((row) => selected.has(row.bookingId) && row.next).map((row) => row.bookingId);
    if (!ids.length) {
      setNotice({ kind: 'error', text: 'Select at least one booking with something due.' });
      return;
    }
    if (!dryRun) {
      const cancellations = bookings.filter(
        (row) => selected.has(row.bookingId) && row.next?.action === 'cancel',
      ).length;
      const warning = cancellations
        ? `\n\n${cancellations} of them would be CANCELLED and their tee times released.`
        : '';
      if (!window.confirm(`Send the next step for ${ids.length} booking(s)?${warning}`)) return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const payload = await api.runTriggers({ bookingIds: ids, dryRun });
      setResults(payload);
      setNotice({
        kind: payload.failed && !payload.sent ? 'error' : 'success',
        text: dryRun
          ? `Preview: ${payload.results.filter((r) => r.status === 'would_send').length} email(s) would go out` +
            `${payload.skipped ? `, ${payload.skipped} rung(s) would be superseded` : ''}` +
            `${payload.needsReview ? `, ${payload.needsReview} waiting on a person` : ''}.`
          : `Sent ${payload.sent}${payload.cancelled ? `, cancelled ${payload.cancelled}` : ''}` +
            `${payload.failed ? `, ${payload.failed} failed` : ''}` +
            `${payload.needsReview ? `, ${payload.needsReview} waiting on a person` : ''}.`,
      });
      if (!dryRun) await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function clearStep(bookingId, step) {
    const label = stepsById.get(step)?.label ?? step;
    if (!window.confirm(`Take "${label}" off ${bookingId}'s list without emailing anybody?`)) return;
    setBusy(true);
    try {
      const payload = await api.clearTriggerSteps(bookingId, [step]);
      const outcome = payload.results[0];
      setNotice({
        kind: outcome?.status === 'cleared' ? 'success' : 'error',
        text: `${bookingId}: ${outcome?.message ?? 'nothing changed'}`,
      });
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const schedule = pending?.schedule ?? config?.schedule;

  return (
    <div className="stack">
      <div className="between">
        {/* Embedded, the page above has already said what this is: a second
            sentence saying it again is a line of screen nobody reads. */}
        {embedded ? (
          <span />
        ) : (
          <div>
            <h1>Booking Status</h1>
            <p className="muted" style={{ margin: '0.25rem 0 0' }}>
              The payment and communication steps each booking climbs, from deposit to thank you
            </p>
          </div>
        )}
        <button type="button" onClick={load} disabled={loading || busy}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {config && !config.enabled && (
        <div className="banner">
          Chasing is switched off, so nothing is sent and nothing is recorded. The plan below is what it <em>would</em>{' '}
          do.{' '}
          {config.locked ? (
            <>
              The environment has it off (<code>TRIGGER_WORKFLOW=false</code>).
            </>
          ) : (
            <>
              Turn it on under <Link to="/settings">Settings</Link>.
            </>
          )}
        </div>
      )}

      {config?.enabled && !config.ready && (
        <div className="banner error">
          The workflow cannot send. Set {config.missing.join(', ')} in the environment, then restart the dashboard.
        </div>
      )}

      {pending && !pending.paymentsTracked && pending.outsideLedger > 0 && (
        <div className="banner error">
          The club is not recording payments, so no booking has a balance and the whole deposit chase is silent —{' '}
          {formatNumber(pending.outsideLedger)} booked {pending.outsideLedger === 1 ? 'booking is' : 'bookings are'}{' '}
          outside the payment ledger. Set <code>PAYMENTS_TRACKED_FROM</code> to the day the club started recording them
          (or <code>all</code> for the whole history) and restart the dashboard. The confirmation and arrival emails run
          either way; only the chase needs a ledger.
        </div>
      )}

      {config?.enabled && config.ready && !config.automatic && (
        <div className="banner">
          Emails go out only when somebody presses Send on this page. Scheduled sending can be switched on under{' '}
          <Link to="/settings">Settings</Link>.
        </div>
      )}

      <div className="kpi-row">
        <KpiTile
          label="Due now"
          value={formatNumber(scope === 'due' ? dueCount : (pending?.summary?.emails ?? 0))}
          sub={scope === 'due' ? 'Bookings with a step to send' : 'In this view'}
          accent="var(--brand-gold)"
        />
        <KpiTile
          label="To cancel"
          value={formatNumber(pending?.summary?.cancellations ?? 0)}
          sub={config?.autoCancel ? 'Cancelled automatically' : 'Left for a person'}
          accent={pending?.summary?.cancellations ? 'var(--status-rejected)' : 'var(--links-green)'}
        />
        <KpiTile
          label="Missed"
          value={formatNumber(pending?.summary?.counts?.missed ?? 0)}
          sub={`Over ${schedule?.catchUpDays ?? '—'} days past their date`}
          accent="var(--north-sea)"
        />
        <KpiTile
          label="Deposit window"
          value={schedule ? `${schedule.depositDays} days` : '—'}
          sub={schedule ? `Then ${schedule.depositGraceDays} days to rescue it` : 'Not loaded'}
          accent="var(--links-green)"
        />
        <KpiTile
          label="Schedule"
          value={config?.automatic ? 'Running' : config?.enabled ? 'By hand' : 'Off'}
          sub={
            config?.lastRun
              ? `Last pass ${formatDateTime(config.lastRun.startedAt)}`
              : config?.automatic
                ? 'No pass yet since the last restart'
                : 'Nothing sends on its own'
          }
          accent={config?.automatic ? 'var(--status-booked)' : 'var(--muted, #8a8a8a)'}
        />
      </div>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Which bookings to list">
          {SCOPES.map((entry) => (
            <button key={entry.id} type="button" aria-pressed={scope === entry.id} onClick={() => setScope(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <button type="button" onClick={() => run({ dryRun: true })} disabled={busy || !dueCount}>
          Preview ({selected.size})
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => run({ dryRun: false })}
          disabled={busy || !config?.ready || !selected.size}
          title={config?.ready ? undefined : 'The workflow is not configured to send'}
        >
          {busy ? 'Sending…' : 'Send next step'}
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
                  checked={dueCount > 0 && selected.size === dueCount}
                  onChange={toggleAll}
                  disabled={!dueCount}
                />
              </th>
              <th>Booking</th>
              <th>Guest</th>
              <th>Flow</th>
              <th>Play date</th>
              <th className="num">Outstanding</th>
              <th>Next step</th>
              <th>Due</th>
              <th style={{ width: 90 }} />
            </tr>
          </thead>
          <tbody>
            {bookings.map((row) => (
              <TriggerRow
                key={row.bookingId}
                row={row}
                selected={selected.has(row.bookingId)}
                expanded={expanded === row.bookingId}
                busy={busy}
                onToggle={() => toggle(row.bookingId)}
                onExpand={() => setExpanded(expanded === row.bookingId ? null : row.bookingId)}
                onClear={clearStep}
              />
            ))}
          </tbody>
        </table>

        {!loading && !bookings.length && (
          <div className="empty">
            {scope === 'due'
              ? 'Nothing falls due today. Every booking is where it should be.'
              : scope === 'missed'
                ? 'No steps have gone past their date unsent.'
                : 'No bookings playing from last month onwards.'}
          </div>
        )}
        {loading && <div className="empty">Loading…</div>}
      </div>

      {results && (
        <div className="card stack">
          <h2>{results.dryRun ? 'Preview' : 'Run results'}</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Booking</th>
                  <th>Step</th>
                  <th>Email</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {results.results.map((line, index) => (
                  <tr key={`${line.bookingId}-${line.step}-${index}`}>
                    <td className="mono">{line.bookingId}</td>
                    <td>{stepsById.get(line.step)?.label ?? line.step}</td>
                    <td>{line.email ?? '—'}</td>
                    <td
                      style={{ color: line.status === 'failed' ? 'var(--status-rejected)' : undefined }}
                      className={line.status.startsWith('would') ? 'muted' : undefined}
                    >
                      {OUTCOME_LABELS[line.status] ?? line.status}
                    </td>
                    <td className="secondary">{line.message}</td>
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

/** One booking's row, with its whole ladder underneath when it is opened. */
function TriggerRow({ row, selected, expanded, busy, onToggle, onExpand, onClear }) {
  const next = row.next;
  return (
    <>
      <tr className={selected ? 'selected' : undefined}>
        <td>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            aria-label={`Select ${row.bookingId}`}
            checked={selected}
            onChange={onToggle}
            disabled={!next}
          />
        </td>
        <td className="mono">{row.bookingId}</td>
        <td>
          {row.guestName || <span className="muted">No name</span>}
          {row.guestEmail ? null : <span className="muted"> · no address</span>}
        </td>
        <td>{row.flow === 'tour_operator' ? row.operatorName || 'Tour operator' : 'Visitor'}</td>
        <td>{formatDate(row.date)}</td>
        <td className="num">
          {row.money.tracked ? formatCurrency(row.money.outstanding) : <span className="muted">—</span>}
        </td>
        <td style={{ color: next?.action === 'cancel' ? 'var(--status-rejected)' : undefined }}>
          {next ? next.label : <span className="muted">{row.blocker ?? 'Nothing due'}</span>}
        </td>
        <td className={next ? undefined : 'muted'}>{next ? `${formatDate(next.dueOn)} · ${next.reason}` : '—'}</td>
        <td>
          <button type="button" onClick={onExpand} aria-expanded={expanded}>
            {expanded ? 'Hide' : 'Ladder'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={9} style={{ background: 'var(--surface-1, rgba(0,0,0,0.02))' }}>
            <BookingLadder steps={row.steps} busy={busy} onClear={(step) => onClear(row.bookingId, step)} />
          </td>
        </tr>
      )}
    </>
  );
}
