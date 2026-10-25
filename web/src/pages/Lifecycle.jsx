import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatCurrency, formatDate, formatDateTime, formatNumber } from '../lib/format.js';
import { OVERDUE } from '../lib/palette.js';
import KpiTile from '../components/KpiTile.jsx';
import StatusPill from '../components/StatusPill.jsx';
import LadderDiagram, { rungTiming } from '../components/LadderDiagram.jsx';

/**
 * The booking lifecycle ladder.
 *
 * The page is laid out in the order the questions actually get asked:
 *
 *   1. Is anything waiting on me?   — the held list, first, because it is the
 *                                     one thing that fails silently if nobody
 *                                     looks at it.
 *   2. What would it do today?      — the dry run.
 *   3. Is it switched on, and how far? — the four steps, in plain words.
 *   4. What are the rungs?          — the ladder as the spreadsheet drew it.
 *
 * The switches live in the environment rather than in this page on purpose: a
 * mechanism that cancels bookings should not be one click away from being
 * turned on by whoever is looking at the screen. So the set-up card explains
 * the state and names the variable, and whoever deploys sets it.
 */
export default function Lifecycle() {
  const [config, setConfig] = useState(null);
  const [held, setHeld] = useState([]);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [configPayload, heldPayload] = await Promise.all([api.lifecycleConfig(), api.lifecycleHeld()]);
      setConfig(configPayload);
      setHeld(heldPayload.held ?? []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const switches = config?.switches ?? {};
  const ladder = useMemo(() => config?.ladder ?? [], [config]);
  const unconfigured = config?.unconfigured ?? [];

  async function runPreview() {
    setBusy(true);
    setNotice(null);
    try {
      const payload = await api.lifecyclePreview();
      setPreview(payload.preview);
      setNotice(
        payload.preview?.skipped === 'not enabled'
          ? { kind: 'error', text: 'The ladder is switched off, so there is nothing to preview.' }
          : {
              kind: 'success',
              text: `Dry run: ${formatNumber(payload.preview.sent)} email(s) would go out across ${formatNumber(
                payload.preview.considered,
              )} booking(s). Nothing was sent and nothing was recorded.`,
            },
      );
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function runForReal() {
    setBusy(true);
    setNotice(null);
    try {
      const payload = await api.lifecycleRun();
      setPreview(null);
      setNotice({
        kind: payload.run.failed && !payload.run.sent ? 'error' : 'success',
        text:
          `Sent ${formatNumber(payload.run.sent)} email(s)` +
          `${payload.run.held ? `, ${formatNumber(payload.run.held)} waiting on a decision` : ''}` +
          `${payload.run.cancelled ? `, ${formatNumber(payload.run.cancelled)} booking(s) cancelled` : ''}` +
          `${payload.run.failed ? `, ${formatNumber(payload.run.failed)} failed` : ''}.`,
      });
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  if (loading && !config) return <div className="empty">Loading the lifecycle…</div>;

  return (
    <div className="stack">
      <div className="between">
        <div>
          <h1>Booking Lifecycle</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Deposits chased, balances chased, and the run-up to the tee — one email per booking per run.
          </p>
        </div>
        <button type="button" onClick={load} disabled={loading || busy}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      <StateBanner switches={switches} heldCount={held.length} unconfigured={unconfigured} />

      <div className="kpi-row">
        <KpiTile
          label="Waiting on you"
          value={formatNumber(held.length)}
          sub={held.length ? 'Bookings the ladder stopped at' : 'Nothing needs a decision'}
          accent={held.length ? OVERDUE : 'var(--status-booked)'}
        />
        <KpiTile
          label="Rungs ready"
          value={`${ladder.length - unconfigured.length} of ${ladder.length}`}
          sub={unconfigured.length ? `${unconfigured.length} have no email template` : 'Every rung has a template'}
          accent={unconfigured.length ? 'var(--brand-gold)' : 'var(--status-booked)'}
        />
        <KpiTile
          label="Runs"
          value={switches.scheduled ? `Every ${config.everyMinutes} min` : 'When you ask'}
          sub={switches.scheduled ? 'Unattended' : 'Nothing happens on its own'}
          accent="var(--north-sea)"
        />
        <KpiTile
          label="Cancels bookings"
          value={switches.autoCancel ? 'Yes' : 'No'}
          sub={switches.autoCancel ? 'A lapse is cancelled automatically' : 'A lapse waits for a person'}
          accent={switches.autoCancel ? OVERDUE : 'var(--status-booked)'}
        />
        <KpiTile
          label="Catch-up limit"
          value={config?.catchUpDays == null ? '—' : `${config.catchUpDays} days`}
          sub="Older deadlines are written off, never emailed late"
          accent="var(--links-green)"
        />
      </div>

      <div className="toolbar">
        <span className="grow" />
        <button type="button" onClick={runPreview} disabled={busy || !switches.enabled}>
          {busy ? 'Working…' : 'Preview today'}
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={runForReal}
          disabled={busy || !switches.enabled || !config?.emailReady}
          title={config?.emailReady ? undefined : 'SendGrid is not configured'}
        >
          Run now
        </button>
      </div>

      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}

      <HeldTable held={held} />

      {preview && <PreviewTable preview={preview} ladder={ladder} />}

      <section className="card stack">
        <div>
          <h2 style={{ margin: 0 }}>The ladder</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            A booking climbs one of two ladders depending on whether the money has arrived. Paying moves it across on
            its own — there is no step to press.
          </p>
        </div>
        <LadderDiagram ladder={ladder} />
      </section>

      <LastRun run={config?.lastRun} />
    </div>
  );
}

/**
 * Where the club has got to, in words, with the next step named.
 *
 * The four switches nest, so the useful thing to say is not which booleans
 * are set but what that combination means and what is still not happening.
 */
function StateBanner({ switches, heldCount, unconfigured }) {
  const steps = [
    {
      on: switches.enabled,
      title: 'Evaluating bookings',
      env: 'BOOKING_TRIGGERS_ENABLED',
      off: 'Nothing is evaluated, sent or recorded. The ladder below is inert.',
      on_: 'The ladder works out where each booking stands.',
    },
    {
      on: switches.deadlines,
      title: 'Deadlines count',
      env: 'BOOKING_TRIGGERS_DEADLINES',
      off: 'No rung that cancels a booking is in the ladder at all.',
      on_: 'Overdue and cancellation rungs can fall due.',
    },
    {
      on: switches.scheduled,
      title: 'Runs unattended',
      env: 'BOOKING_TRIGGERS_SCHEDULE',
      off: 'The ladder only runs when somebody presses Run now.',
      on_: 'The ladder runs on a timer.',
    },
    {
      on: switches.autoCancel,
      title: 'Cancels on a lapse',
      env: 'BOOKING_TRIGGERS_AUTO_CANCEL',
      off: 'A booking that runs out of road waits for a person. Nothing is emailed.',
      on_: 'A booking that runs out of road is cancelled and told so.',
    },
  ];

  const reached = steps.filter((step) => step.on).length;

  return (
    <section className="card stack" style={{ gap: '0.75rem' }}>
      <div className="between">
        <div>
          <h2 style={{ margin: 0 }}>Set-up</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Four steps, each one safe to stop at. Read a dry run before taking the next.
          </p>
        </div>
        <span className="tag">
          Step {reached} of {steps.length}
        </span>
      </div>

      {!switches.enabled && (
        <div className="banner">
          The lifecycle ladder is <strong>off</strong>. Nothing is being chased and no guest is hearing from it.
        </div>
      )}

      {switches.enabled && !switches.scheduled && (
        <div className="banner">
          The ladder is on but <strong>nothing runs by itself</strong> — press <em>Run now</em>, or set{' '}
          <span className="mono">BOOKING_TRIGGERS_SCHEDULE=true</span> once a dry run looks right.
        </div>
      )}

      {switches.enabled && !switches.autoCancel && heldCount > 0 && (
        <div className="banner error">
          {formatNumber(heldCount)} booking{heldCount === 1 ? '' : 's'} ran out of road and{' '}
          <strong>{heldCount === 1 ? 'needs' : 'need'} a decision</strong>. Nothing was emailed to{' '}
          {heldCount === 1 ? 'them' : 'any of them'}.
        </div>
      )}

      {switches.enabled && unconfigured.length > 0 && (
        <div className="banner">
          {formatNumber(unconfigured.length)} rung{unconfigured.length === 1 ? '' : 's'} have no email template, so they
          are skipped. They start working the next run after a template is set — nothing is lost in the meantime.
        </div>
      )}

      <ol className="stack" style={{ gap: '0.5rem', margin: 0, paddingLeft: '1.1rem' }}>
        {steps.map((step) => (
          <li key={step.env}>
            <span style={{ fontWeight: 600 }}>
              <span aria-hidden="true" style={{ color: step.on ? 'var(--status-booked)' : 'var(--text-muted)' }}>
                {step.on ? '●' : '○'}
              </span>{' '}
              {step.title}
            </span>
            <span className="sr-only">{step.on ? ' (on)' : ' (off)'}</span>
            <div className="muted" style={{ fontSize: '0.8125rem' }}>
              {step.on ? step.on_ : step.off} {!step.on && <span className="mono">{step.env}=true</span>}
            </div>
          </li>
        ))}
      </ol>

      {switches.enabled && !switches.visitorDunning && (
        <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>
          Visitor chasing is switched off: trade bookings are chased for their deposit, visitors are not. Visitors still
          get their receipt and their arrival details. The spreadsheet left the visitor chasing columns blank, so that
          cadence was an extrapolation either way.
        </p>
      )}
    </section>
  );
}

/** The bookings the ladder stopped at, which is the page's real job. */
function HeldTable({ held }) {
  if (!held.length) return null;

  return (
    <section className="card stack">
      <div>
        <h2 style={{ margin: 0 }}>Waiting on you</h2>
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          These bookings reached a rung that would cancel them. Nothing has been emailed and nothing has been cancelled.
          Open one to see where it stands, then decide — take the payment, give it longer, or cancel it yourself.
        </p>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Booking</th>
              <th>Guest</th>
              <th>Plays</th>
              <th>Why it stopped</th>
              <th className="num">Paid</th>
              <th className="num">Of</th>
              <th>Status</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {held.map((row) => (
              <tr key={`${row.bookingId}-${row.rung}`}>
                <td className="mono">
                  <Link to={`/bookings?ref=${encodeURIComponent(row.bookingId)}`}>{row.bookingId}</Link>
                </td>
                <td>
                  {row.guestName || '—'}
                  {row.guestEmail && (
                    <div className="muted" style={{ fontSize: '0.75rem' }}>
                      {row.guestEmail}
                    </div>
                  )}
                </td>
                <td>{formatDate(row.playDate)}</td>
                <td>{reasonFor(row.rung)}</td>
                <td className="num">{formatCurrency(row.amountPaid)}</td>
                <td className="num">{formatCurrency(row.total)}</td>
                <td>
                  <StatusPill status={row.status} />
                </td>
                <td className="muted">{formatDateTime(row.heldAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** What a run would do today, before it does it. */
function PreviewTable({ preview, ladder }) {
  const byKey = new Map(ladder.map((rung) => [rung.key, rung]));
  const actions = preview.actions ?? [];

  return (
    <section className="card stack">
      <div>
        <h2 style={{ margin: 0 }}>What would happen today</h2>
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          {formatNumber(preview.considered)} booking(s) walked for {formatDate(preview.today)}. Nothing was sent and
          nothing was written down.
        </p>
      </div>

      {!actions.length ? (
        <p className="muted" style={{ margin: 0 }}>
          Nothing is due today.{' '}
          {preview.superseded
            ? `${formatNumber(preview.superseded)} rung(s) were too old to send — see the catch-up limit.`
            : ''}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Booking</th>
                <th>Email</th>
                <th>Falls due</th>
                <th>On</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((action) => {
                const rung = byKey.get(action.rung);
                return (
                  <tr key={`${action.bookingId}-${action.rung}`}>
                    <td className="mono">{action.bookingId}</td>
                    <td>
                      {rung?.label ?? action.rung}
                      {rung?.cancels && (
                        <span className="tag" style={{ marginLeft: '0.4rem', color: 'var(--status-rejected)' }}>
                          cancels
                        </span>
                      )}
                    </td>
                    <td className="muted">{rung ? rungTiming(rung) : '—'}</td>
                    <td>{formatDate(action.dueOn)}</td>
                    <td>{action.outcome === 'held' ? 'Would wait for a person' : 'Would send'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LastRun({ run }) {
  if (!run || run.skipped) return null;

  return (
    <p className="muted" style={{ fontSize: '0.75rem' }}>
      Last run {formatDateTime(run.finishedAt ?? run.startedAt)} ({run.reason}): {formatNumber(run.considered)}{' '}
      considered, {formatNumber(run.sent)} sent, {formatNumber(run.held)} held, {formatNumber(run.cancelled)} cancelled,{' '}
      {formatNumber(run.failed)} failed.
    </p>
  );
}

/** Why a booking stopped, in the words a person would use. */
function reasonFor(rung) {
  if (rung === 'deposit_cancelled') return 'No deposit arrived within the payment window';
  if (rung === 'balance_cancelled') return 'The balance was still outstanding at the deadline';
  return rung;
}
