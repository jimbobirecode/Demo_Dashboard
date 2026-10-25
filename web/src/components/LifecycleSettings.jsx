import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import LifecycleTimeline from './LifecycleTimeline.jsx';

/**
 * Chasing unpaid bookings, as a club sets it up.
 *
 * One switch and one choice. The switch turns chasing on; the choice says what
 * happens to a booking that never pays — stop and ask, or cancel. Everything
 * else is a timing with its units written into the sentence around it.
 *
 * Underneath, the server still takes four booleans. `enabled`, `deadlines`
 * and `scheduled` move together with the switch; `autoCancel` is the choice.
 * A dry run needs none of them, so "preview" is a button on the Booking
 * Lifecycle page rather than a mode here.
 */
const PICKER = { width: 'auto', flex: '0 0 auto', margin: 0 };
const NUMBER = { width: '4.5rem', textAlign: 'center' };

export default function LifecycleSettings({ onSaved }) {
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .lifecycleSettings()
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

  const canEdit = state.canEdit;
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
    setDraft((current) => ({ ...current, enabled: value, deadlines: value, scheduled: value }));
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
      const payload = await api.saveLifecycleSettings(patch);
      setState((current) => ({ ...current, saved: payload.saved, settings: { ...current.settings, ...patch } }));
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

      {!canEdit && <div className="banner">Only an administrator can change these.</div>}

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
          Nothing is sent. You can still see what would be — <Link to="/lifecycle">Preview today</Link>.
        </p>
      )}

      {on && (
        <>
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
              <h3 style={{ margin: 0, fontSize: '1rem' }}>Visitors</h3>
              <p className="muted" style={{ margin: '0.2rem 0 0', fontSize: '0.8125rem' }}>
                Pay in full. Counted from the booking date. Emails go to the guest.
              </p>
            </div>

            <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={Boolean(draft.visitorDunning)}
                onChange={(event) => set('visitorDunning', event.target.checked)}
                disabled={!canEdit}
                style={PICKER}
              />
              <span>Chase visitors for payment</span>
            </label>

            {draft.visitorDunning && (
              <>
                <Sentence disabled={!canEdit}>Payment due within {num('depositWindowDays')} days of booking.</Sentence>
                <Sentence disabled={!canEdit}>
                  First reminder on day {num('depositReminderDay')}, another the day before the deadline.
                </Sentence>
                <Sentence disabled={!canEdit}>
                  Final deadline on day {num('depositRescueDay')}, with 48- and 24-hour warnings before it.
                </Sentence>
                {wrongOrder && <div className="banner error">{wrongOrder}</div>}
              </>
            )}
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
              Default balance due {num('balanceDueDaysBeforePlay')} days before play, first notice{' '}
              {num('balanceNoticeLeadDays')} days before that.
            </Sentence>
            <p className="muted" style={{ margin: '-0.5rem 0 0', fontSize: '0.8125rem' }}>
              Deposits and per-account dates are set under <Link to="/operators">Tour Operators</Link>.
            </p>
          </div>

          <div className="divider" />

          {/* ---------------------------------------------------------- */}
          <div className="stack" style={{ gap: '0.9rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>Once paid</h3>
            <Sentence disabled={!canEdit}>
              Confirmation {num('confirmationDaysBeforePlay')} days before play, arrival details{' '}
              {num('finalDetailsDaysBeforePlay')} days before.
            </Sentence>
            <Sentence disabled={!canEdit}>
              Thank-you {num('postPlayDaysAfterPlay')} {Number(draft.postPlayDaysAfterPlay) === 1 ? 'day' : 'days'}{' '}
              after the round.
            </Sentence>
          </div>

          <div className="divider" />

          {/* ---------------------------------------------------------- */}
          <div className="stack" style={{ gap: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>What a visitor receives</h3>
            <LifecycleTimeline settings={draft} />
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
      aria-label={LABELS[id] ?? id}
      style={NUMBER}
      onChange={(event) => {
        const next = Number.parseInt(event.target.value, 10);
        onChange(id, Number.isFinite(next) ? next : '');
      }}
    />
  );
}

const LABELS = {
  depositWindowDays: 'Days to pay',
  depositReminderDay: 'Days before the first reminder',
  depositRescueDay: 'Day the booking stops',
  balanceDueDaysBeforePlay: 'Days before play the balance is due',
  balanceNoticeLeadDays: 'Days before that for the first notice',
  confirmationDaysBeforePlay: 'Days before play to confirm',
  finalDetailsDaysBeforePlay: 'Days before play to send arrival details',
  postPlayDaysAfterPlay: 'Days after play to say thank you',
  catchUpDays: 'Ignore anything older than this many days',
};

function badOrder(settings) {
  const window = Number(settings.depositWindowDays);
  const reminder = Number(settings.depositReminderDay);
  const rescue = Number(settings.depositRescueDay);
  if (![window, reminder, rescue].every(Number.isFinite)) return null;
  if (reminder >= window) return 'The reminder must come before the deadline.';
  if (rescue <= window) return 'The final deadline must come after the payment deadline.';
  if (rescue - window < 2) return 'Leave at least two days between the deadlines for the 48- and 24-hour warnings.';
  return null;
}
