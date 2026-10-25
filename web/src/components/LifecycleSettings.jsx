import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * The booking lifecycle, as the club's own settings.
 *
 * Four things this form has to get right, none of them about inputs:
 *
 * The switches nest, so a club reading the form must see that turning one on
 * does nothing until the one above it is. They are drawn as a sequence and
 * the ones that cannot yet take effect say so, rather than sitting there
 * looking live.
 *
 * Auto-cancel emails somebody that their booking is gone. It is the only
 * field here that asks twice.
 *
 * The day counts are a cadence, not eight numbers. The sequence is written
 * out underneath as it is edited, so a club sees "day 5, day 6, day 7, day 10"
 * rather than four inputs that each look fine alone.
 *
 * And a club that has set nothing is inheriting, not choosing. Those fields
 * say so, because an inherited default presented as a decision is how a club
 * ends up believing it picked a cadence it has never looked at.
 */
/**
 * The stylesheet gives every input `width: 100%`, which is right for the text
 * fields it was written for and wrong for a checkbox: it stretches across the
 * whole row and pushes its own label onto the next line. Overridden here
 * rather than in the stylesheet, which other screens are laid out against.
 */
const CHECKBOX = { width: 'auto', flex: '0 0 auto', margin: 0 };

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

  const saved = useMemo(() => new Set(state?.saved ?? []), [state]);

  if (error && !state) return <div className="banner error">{error}</div>;
  if (!state) return <div className="empty">Loading settings…</div>;

  const canEdit = state.canEdit;
  const changed = Object.keys(draft).filter((key) => draft[key] !== state.settings[key]);

  function set(key, value) {
    setNotice(null);
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const patch = Object.fromEntries(changed.map((key) => [key, draft[key]]));
      const payload = await api.saveLifecycleSettings(patch);
      setState((current) => ({ ...current, saved: payload.saved, settings: { ...current.settings, ...patch } }));
      setConfirmCancel(false);
      setNotice({ kind: 'success', text: 'Saved. The next run uses these.' });
      onSaved?.();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setDraft(state.settings);
    setConfirmCancel(false);
    setNotice(null);
  }

  // Turning auto-cancel on is the one change that asks twice.
  const turningOnAutoCancel = draft.autoCancel && !state.settings.autoCancel;
  const blocked = turningOnAutoCancel && !confirmCancel;

  return (
    <section className="card stack">
      <div>
        <h2 style={{ margin: 0 }}>Booking lifecycle</h2>
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          How this club chases a deposit, chases a balance, and talks to a guest in the run-up to the tee. Changes apply
          from the next run — nothing is sent retrospectively.
        </p>
      </div>

      {!canEdit && <div className="banner">You can read these, but only an administrator can change them.</div>}

      <div className="stack" style={{ gap: '0.75rem' }}>
        <span className="label">What it is allowed to do</span>

        <Switch
          id="enabled"
          label="Work out where each booking stands"
          hint="Off, nothing is evaluated, sent or recorded."
          draft={draft}
          saved={saved}
          onChange={set}
          disabled={!canEdit}
        />
        <Switch
          id="deadlines"
          label="Let deadlines count"
          hint="Off, no rung that would cancel a booking is in the ladder at all."
          draft={draft}
          saved={saved}
          onChange={set}
          disabled={!canEdit || !draft.enabled}
          inert={!draft.enabled && 'Needs the setting above'}
        />
        <Switch
          id="scheduled"
          label="Run by itself"
          hint="Off, the ladder only runs when somebody presses Run now."
          draft={draft}
          saved={saved}
          onChange={set}
          disabled={!canEdit || !draft.deadlines}
          inert={!draft.deadlines && 'Needs deadlines'}
        />
        <Switch
          id="autoCancel"
          label="Cancel a booking that runs out of road"
          hint="Off, it waits for a person and nothing is emailed. This is the safe setting."
          draft={draft}
          saved={saved}
          onChange={set}
          disabled={!canEdit || !draft.deadlines}
          inert={!draft.deadlines && 'Needs deadlines'}
          danger
        />

        {turningOnAutoCancel && (
          <div className="banner error stack" style={{ gap: '0.5rem' }}>
            <div>
              With this on, a booking that reaches the end of the ladder is{' '}
              <strong>cancelled and told so by email</strong>, without anybody seeing it first. Nothing is deleted — the
              booking becomes Cancelled with a note saying why — but the guest has been written to by then.
            </div>
            <label className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={confirmCancel}
                onChange={(event) => setConfirmCancel(event.target.checked)}
                style={CHECKBOX}
              />
              I understand, and the dry run looks right
            </label>
          </div>
        )}

        <Switch
          id="visitorDunning"
          label="Chase visitors for a deposit, not only trade bookings"
          hint="The spreadsheet left the visitor chasing columns blank, so this half is our reading of it. Off, visitors still get their receipt and arrival details."
          draft={draft}
          saved={saved}
          onChange={set}
          disabled={!canEdit || !draft.enabled}
          inert={!draft.enabled && 'Needs the ladder on'}
        />
      </div>

      <div className="divider" />

      <div className="stack" style={{ gap: '0.75rem' }}>
        <div>
          <span className="label">Chasing a deposit</span>
          <p className="muted" style={{ margin: '0.15rem 0 0', fontSize: '0.8125rem' }}>
            Counted from the day the booking was taken.
          </p>
        </div>

        <div className="row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
          <Days
            id="depositReminderDay"
            label="First reminder"
            draft={draft}
            state={state}
            saved={saved}
            onChange={set}
            disabled={!canEdit}
          />
          <Days
            id="depositWindowDays"
            label="Window closes"
            draft={draft}
            state={state}
            saved={saved}
            onChange={set}
            disabled={!canEdit}
          />
          <Days
            id="depositRescueDay"
            label="Final deadline"
            draft={draft}
            state={state}
            saved={saved}
            onChange={set}
            disabled={!canEdit}
          />
        </div>

        <Cadence draft={draft} />
      </div>

      <div className="divider" />

      <div className="stack" style={{ gap: '0.75rem' }}>
        <div>
          <span className="label">Chasing a balance</span>
          <p className="muted" style={{ margin: '0.15rem 0 0', fontSize: '0.8125rem' }}>
            Trade bookings only. Where a trade account has a balance deadline of its own, that is used instead of this
            one.
          </p>
        </div>
        <div className="row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
          <Days
            id="balanceDueDaysBeforePlay"
            label="Balance due, days before play"
            draft={draft}
            state={state}
            saved={saved}
            onChange={set}
            disabled={!canEdit}
          />
          <Days
            id="balanceNoticeLeadDays"
            label="First notice, days before that"
            draft={draft}
            state={state}
            saved={saved}
            onChange={set}
            disabled={!canEdit}
          />
        </div>
      </div>

      <div className="divider" />

      <div className="stack" style={{ gap: '0.75rem' }}>
        <span className="label">The run-up to the tee</span>
        <div className="row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
          <Days
            id="confirmationDaysBeforePlay"
            label="Confirmation, days before play"
            draft={draft}
            state={state}
            saved={saved}
            onChange={set}
            disabled={!canEdit}
          />
          <Days
            id="finalDetailsDaysBeforePlay"
            label="Final details, days before play"
            draft={draft}
            state={state}
            saved={saved}
            onChange={set}
            disabled={!canEdit}
          />
          <Days
            id="postPlayDaysAfterPlay"
            label="Thank you, days after play"
            draft={draft}
            state={state}
            saved={saved}
            onChange={set}
            disabled={!canEdit}
          />
        </div>
      </div>

      <div className="divider" />

      <div className="stack" style={{ gap: '0.5rem' }}>
        <span className="label">Catching up</span>
        <div className="row" style={{ gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Days
            id="catchUpDays"
            label="Act on deadlines up to this many days old"
            draft={draft}
            state={state}
            saved={saved}
            onChange={set}
            disabled={!canEdit}
          />
          <p className="muted" style={{ margin: 0, fontSize: '0.8125rem', maxWidth: '34rem' }}>
            Anything older is written down and never sent, so switching the ladder on cannot email a year of history its
            own deadlines. Raise it only to catch up deliberately.
          </p>
        </div>
      </div>

      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}

      {canEdit && (
        <div className="toolbar">
          <span className="muted" style={{ fontSize: '0.8125rem' }}>
            {changed.length ? `${changed.length} change${changed.length === 1 ? '' : 's'} not saved` : 'No changes'}
          </span>
          <span className="grow" />
          <button type="button" onClick={reset} disabled={busy || !changed.length}>
            Discard
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={save}
            disabled={busy || !changed.length || blocked}
            title={blocked ? 'Confirm the auto-cancel warning first' : undefined}
          >
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      )}
    </section>
  );
}

/** One switch, with what it means and whether it can take effect yet. */
function Switch({ id, label, hint, draft, saved, onChange, disabled, inert, danger }) {
  return (
    <label className="stack" style={{ gap: '0.15rem', opacity: inert ? 0.55 : 1 }}>
      <span className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={Boolean(draft[id])}
          onChange={(event) => onChange(id, event.target.checked)}
          disabled={disabled}
          style={CHECKBOX}
        />
        <span style={{ fontWeight: 600, color: danger && draft[id] ? 'var(--status-rejected)' : undefined }}>
          {label}
        </span>
        {!saved.has(id) && <Inherited />}
        {inert && <span className="tag">{inert}</span>}
      </span>
      <span className="muted" style={{ fontSize: '0.8125rem', paddingLeft: '1.6rem' }}>
        {hint}
      </span>
    </label>
  );
}

/** One day count, bounded by what the server will accept. */
function Days({ id, label, draft, state, saved, onChange, disabled }) {
  const bounds = state.bounds?.[id] ?? { min: 0, max: 365 };
  return (
    <label className="stack" style={{ gap: '0.2rem' }}>
      <span className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
        <span className="label" style={{ margin: 0 }}>
          {label}
        </span>
        {!saved.has(id) && <Inherited />}
      </span>
      <input
        type="number"
        inputMode="numeric"
        min={bounds.min}
        max={bounds.max}
        value={draft[id] ?? ''}
        disabled={disabled}
        aria-label={label}
        style={{ width: '7rem' }}
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          onChange(id, Number.isFinite(next) ? next : '');
        }}
      />
    </label>
  );
}

/**
 * Said rather than implied: this club has not chosen this, it is inheriting
 * it. An inherited default presented as a decision is how a club ends up
 * believing it picked a cadence it has never looked at.
 */
function Inherited() {
  return (
    <span className="tag" title="Not set by this club — inherited from the server's defaults">
      inherited
    </span>
  );
}

/** The deposit cadence as a sentence, so eight inputs read as one sequence. */
function Cadence({ draft }) {
  const reminder = Number(draft.depositReminderDay);
  const window = Number(draft.depositWindowDays);
  const rescue = Number(draft.depositRescueDay);
  if (![reminder, window, rescue].every(Number.isFinite)) return null;

  const steps = [
    'Day 0: payment link',
    `Day ${reminder}: reminder`,
    `Day ${window - 1}: 24 hours left`,
    `Day ${window}: window closed, offer the rescue`,
    `Day ${rescue - 2}: 48 hours left`,
    `Day ${rescue - 1}: 24 hours left`,
    `Day ${rescue}: cancelled`,
  ];

  const broken = reminder >= window || rescue - window < 2;

  return (
    <p className={broken ? 'banner error' : 'muted'} style={{ margin: 0, fontSize: '0.8125rem' }}>
      {broken
        ? 'That order does not work: the reminder must come before the window closes, and the final deadline at least two days after it.'
        : steps.join(' · ')}
    </p>
  );
}
