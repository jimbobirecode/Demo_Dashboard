import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import TriggerTimeline from './TriggerTimeline.jsx';

/**
 * Chasing unpaid bookings, as a club sets it up.
 *
 * Two switches and one choice. The first switch turns chasing on: the ladder
 * is worked out and Booking Status shows what is due. The second says whether
 * what is due goes out by itself each morning or waits for somebody to press
 * Send. The choice says what happens to a booking that never pays — stop and
 * ask, or cancel. Everything else is a timing with its units written into the
 * sentence around it.
 *
 * The two switches used to be one. They were separated the week the ladder
 * sent twenty-nine wrong demands before anybody saw one: a club that wants to
 * read each email before it goes should be able to say so, and sending on its
 * own is now something a club turns on, not something chasing implies.
 */
const PICKER = { width: 'auto', flex: '0 0 auto', margin: 0 };
const NUMBER = { width: '4.5rem', textAlign: 'center' };

export default function TriggerSettings({ onSaved }) {
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .triggerSettings()
      .then((payload) => {
        if (!live) return;
        setState(payload);
        setDraft(payload.settings);
      })
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, []);

  if (error && !state) return <div className="banner error">{error}</div>;
  if (!state) return <div className="empty">Loading…</div>;

  const canEdit = state.canEdit && !state.locked;
  const trade = state.trade ?? { accounts: 0, ownDepositTerm: 0, ownBalanceTerm: 0, notChased: 0, noContactEmail: 0 };
  const on = Boolean(draft.enabled);
  const changed = Object.keys(draft).filter((key) => draft[key] !== state.settings[key]);
  const wrongOrder = badOrder(draft);
  const turningOnCancel = draft.autoCancel && !state.settings.autoCancel;
  const blocked = (turningOnCancel && !confirmCancel) || Boolean(wrongOrder);

  function set(key, value) {
    setNotice(null);
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function setChasing(value) {
    setNotice(null);
    if (!value) setConfirmCancel(false);
    // Turning chasing off takes scheduled sending with it; turning it on
    // does not bring it back. Sending on its own is a separate decision.
    setDraft((current) => ({ ...current, enabled: value, automatic: value ? current.automatic : false }));
  }

  function setEnding(cancel) {
    setNotice(null);
    if (!cancel) setConfirmCancel(false);
    setDraft((current) => ({ ...current, autoCancel: cancel }));
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const patch = Object.fromEntries(changed.map((key) => [key, draft[key]]));
      const payload = await api.saveTriggerSettings(patch);
      setState((current) => ({ ...current, saved: payload.saved, settings: payload.settings }));
      setDraft(payload.settings);
      setConfirmCancel(false);
      setNotice({ kind: 'success', text: 'Saved.' });
      onSaved?.();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const num = (id) => <Num id={id} draft={draft} state={state} onChange={set} disabled={!canEdit} />;

  return (
    <section className="card stack" style={{ gap: '1.5rem' }}>
      <div>
        <h2 style={{ margin: 0 }}>Chasing unpaid bookings</h2>
        <p className="muted" style={{ margin: '0.35rem 0 0' }}>
          Payment link, reminders, a warning; then confirmation, arrival details and a thank-you once paid.
        </p>
      </div>

      {state.locked && (
        <div className="banner">
          Switched off in the environment (<code>TRIGGER_WORKFLOW=false</code>), so nothing here can turn it on.
        </div>
      )}
      {!state.locked && !state.canEdit && <div className="banner">Only an administrator can change these.</div>}
      {on && state.missing?.length > 0 && (
        <div className="banner error">
          Nothing can be sent until {state.missing.join(' and ')} {state.missing.length === 1 ? 'is' : 'are'} set in the
          environment.
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      <label className="row" style={{ gap: '0.6rem', alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={on}
          onChange={(event) => setChasing(event.target.checked)}
          disabled={!canEdit}
          style={PICKER}
        />
        <span style={{ fontWeight: 600, fontSize: '1rem' }}>Chase unpaid bookings</span>
      </label>

      {!on && (
        <p className="muted" style={{ margin: '-0.75rem 0 0 1.6rem', fontSize: '0.8125rem' }}>
          Nothing is sent. You can still see what would be — <Link to="/booking-status">Preview today</Link>.
        </p>
      )}

      {on && (
        <>
          <div className="stack" style={{ gap: '0.5rem', paddingLeft: '1.6rem' }}>
            <label className="row" style={{ gap: '0.6rem', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={Boolean(draft.automatic)}
                onChange={(event) => set('automatic', event.target.checked)}
                disabled={!canEdit}
                style={PICKER}
              />
              <span style={{ fontWeight: 600 }}>Send on a schedule, without asking</span>
            </label>
            <p className="muted" style={{ margin: '-0.25rem 0 0 1.6rem', fontSize: '0.8125rem' }}>
              {draft.automatic
                ? 'Whatever is due goes out each morning by itself.'
                : 'Nothing goes out by itself. What is due waits on '}
              {!draft.automatic && <Link to="/booking-status">Booking Status</Link>}
              {!draft.automatic && ' until somebody reads it and presses Send.'}
            </p>
          </div>

          <div className="stack" style={{ gap: '0.5rem', paddingLeft: '1.6rem' }}>
            <span className="label">When a booking never pays</span>
            <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="radio"
                name="ending"
                checked={!draft.autoCancel}
                onChange={() => setEnding(false)}
                disabled={!canEdit}
                style={PICKER}
              />
              <span>
                Stop and ask me <span className="tag">recommended</span>
              </span>
            </label>
            <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="radio"
                name="ending"
                checked={Boolean(draft.autoCancel)}
                onChange={() => setEnding(true)}
                disabled={!canEdit}
                style={PICKER}
              />
              <span>Cancel it and tell them</span>
            </label>

            {turningOnCancel && (
              <div className="banner error stack" style={{ gap: '0.5rem' }}>
                <div>The guest is emailed that the booking is cancelled before anyone here sees it.</div>
                <label className="row" style={{ gap: '0.45rem', alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={confirmCancel}
                    onChange={(event) => setConfirmCancel(event.target.checked)}
                    style={PICKER}
                  />
                  I understand
                </label>
              </div>
            )}
          </div>

          <div className="divider" />

          {/* ---------------------------------------------------------- */}
          <div className="stack" style={{ gap: '0.9rem' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>Paying for a booking</h3>
              <p className="muted" style={{ margin: '0.2rem 0 0', fontSize: '0.8125rem' }}>
                Counted from the day the booking is made. Visitors are emailed directly.
              </p>
            </div>
            <Sentence disabled={!canEdit}>Deposit due within {num('depositDays')} days of booking.</Sentence>
            <Sentence disabled={!canEdit}>
              First reminder on day {num('depositReminderDay')}, another the day before the deadline.
            </Sentence>
            <Sentence disabled={!canEdit}>
              {draft.autoCancel ? 'Cancelled' : 'Stops'} {num('depositGraceDays')} days after the deadline, with 48- and
              24-hour warnings before that.
            </Sentence>
            {wrongOrder && <div className="banner error">{wrongOrder}</div>}
          </div>

          <div className="divider" />

          {/* ---------------------------------------------------------- */}
          <div className="stack" style={{ gap: '0.9rem' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>Tour operators</h3>
              <p className="muted" style={{ margin: '0.2rem 0 0', fontSize: '0.8125rem' }}>
                Chased on each account&apos;s own terms. Money emails go to the account; the rest to the guest.
              </p>
            </div>

            <TradeSummary trade={trade} />

            <Sentence disabled={!canEdit}>
              Default balance due {num('balanceDeadlineDays')} days before play, first notice {num('balanceNoticeDays')}{' '}
              days before play.
            </Sentence>
            <p className="muted" style={{ margin: '-0.5rem 0 0', fontSize: '0.8125rem' }}>
              Per-account dates and whether an account is chased at all are set under{' '}
              <Link to="/operators">Tour Operators</Link>.
            </p>
          </div>

          <div className="divider" />

          {/* ---------------------------------------------------------- */}
          <div className="stack" style={{ gap: '0.9rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>Once paid</h3>
            <Sentence disabled={!canEdit}>
              Confirmation {num('confirmationDays')} days before play, arrival details {num('finalDetailsDays')} days
              before.
            </Sentence>
            <Sentence disabled={!canEdit}>Thank-you {num('postPlayHours')} hours after the tee time.</Sentence>
          </div>

          <div className="divider" />

          {/* ---------------------------------------------------------- */}
          <div className="stack" style={{ gap: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>What a visitor receives</h3>
            <TriggerTimeline settings={draft} />
          </div>

          <div className="divider" />

          <Sentence disabled={!canEdit}>
            Ignore deadlines more than {num('catchUpDays')} days old, so switching on cannot email old bookings.
          </Sentence>
        </>
      )}

      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}

      {canEdit && (
        <div className="toolbar">
          <span className="muted" style={{ fontSize: '0.8125rem' }}>
            {changed.length ? 'Not saved yet' : 'Saved'}
          </span>
          <span className="grow" />
          <button
            type="button"
            onClick={() => {
              setDraft(state.settings);
              setConfirmCancel(false);
              setNotice(null);
            }}
            disabled={busy || !changed.length}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={save}
            disabled={busy || !changed.length || blocked}
            title={blocked ? wrongOrder || 'Confirm the warning first' : undefined}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </section>
  );
}

/** The trade book as the ladder sees it, in as few lines as it takes. */
function TradeSummary({ trade }) {
  if (!trade.accounts) {
    return (
      <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>
        No accounts yet — <Link to="/operators">add one</Link>.
      </p>
    );
  }
  const usingDefault = trade.accounts - trade.ownBalanceTerm;
  return (
    <div className="stack" style={{ gap: '0.4rem' }}>
      <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>
        {trade.accounts} active {trade.accounts === 1 ? 'account' : 'accounts'} · {trade.ownDepositTerm} with own
        deposit date · {usingDefault} on the default balance date
        {trade.notChased ? ` · ${trade.notChased} not chased` : ''}
      </p>
      {trade.noContactEmail > 0 && (
        <div className="banner error">
          {trade.noContactEmail} {trade.noContactEmail === 1 ? 'account has' : 'accounts have'} no contact email —
          reminders will go to the guest instead. <Link to="/operators">Fix under Tour Operators.</Link>
        </div>
      )}
    </div>
  );
}

function Sentence({ children, disabled }) {
  return <p style={{ margin: 0, lineHeight: 2.1, maxWidth: '46rem', opacity: disabled ? 0.7 : 1 }}>{children}</p>;
}

function Num({ id, draft, state, onChange, disabled }) {
  const bounds = state.bounds?.[id] ?? { min: 0, max: 365 };
  return (
    <input
      type="number"
      inputMode="numeric"
      min={bounds.min}
      max={bounds.max}
      value={draft[id] ?? ''}
      disabled={disabled}
      aria-label={bounds.label ?? id}
      style={NUMBER}
      onChange={(event) => {
        const next = Number.parseInt(event.target.value, 10);
        onChange(id, Number.isFinite(next) ? next : '');
      }}
    />
  );
}

/** The same orderings the server refuses, said before the round trip. */
function badOrder(settings) {
  const window = Number(settings.depositDays);
  const reminder = Number(settings.depositReminderDay);
  const grace = Number(settings.depositGraceDays);
  const notice = Number(settings.balanceNoticeDays);
  const deadline = Number(settings.balanceDeadlineDays);
  const confirmation = Number(settings.confirmationDays);
  const details = Number(settings.finalDetailsDays);
  if (![window, reminder, grace, notice, deadline, confirmation, details].every(Number.isFinite)) return null;
  if (reminder >= window) return 'The reminder must come before the deadline.';
  if (grace < 2) return 'Leave at least two days after the deadline for the 48- and 24-hour warnings.';
  if (notice <= deadline) return 'The balance notice must go out before the balance is due.';
  if (details >= confirmation) return 'Arrival details must go out after the confirmation, nearer the play date.';
  return null;
}
