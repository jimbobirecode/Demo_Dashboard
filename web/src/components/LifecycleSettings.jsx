import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import LifecycleTimeline from './LifecycleTimeline.jsx';

/**
 * Chasing unpaid bookings, as a club sets it up.
 *
 * An earlier version of this screen offered four switches that nested, and a
 * grid of numbered boxes. Both were honest about how the thing is built and
 * neither matched the question somebody actually arrives with, which is "how
 * far do I want this to go, and when does the guest hear from us?". So:
 *
 *   - one choice, in five steps, each named by what the guest gets rather
 *     than by which flag it sets;
 *   - the timings written as sentences with the units in them, because
 *     "First reminder: 5" means nothing without "days after booking";
 *   - and the whole schedule drawn out beside it, updating as it is edited,
 *     since that is the only part that really explains it.
 *
 * The five steps map onto the same four booleans the server has always taken.
 * The flags are the implementation; this is the decision.
 */
const MODES = [
  {
    id: 'off',
    title: 'Off',
    blurb: 'Nobody is chased and nothing is recorded.',
    flags: { enabled: false, deadlines: false, scheduled: false, autoCancel: false },
  },
  {
    id: 'preview',
    title: 'Show me what you would send, but send nothing',
    blurb: 'Good for a week or two. You can see every email it wants to send without a guest receiving one.',
    flags: { enabled: true, deadlines: false, scheduled: false, autoCancel: false },
  },
  {
    id: 'chase_forever',
    title: 'Send reminders, but never cancel',
    blurb: 'Reminders and confirmations go out on their own. An unpaid booking is chased and then simply left alone.',
    flags: { enabled: true, deadlines: false, scheduled: true, autoCancel: false },
  },
  {
    id: 'chase_and_ask',
    title: 'Send reminders, then stop and ask me',
    blurb:
      'Adds the final warnings. A booking that still has not paid stops and waits for you on the Booking Lifecycle page — nothing is cancelled and nothing more is emailed.',
    recommended: true,
    flags: { enabled: true, deadlines: true, scheduled: true, autoCancel: false },
  },
  {
    id: 'cancel',
    title: 'Send reminders, then cancel it for me',
    blurb: 'The same, except the booking is cancelled and the guest is told, without anybody here seeing it first.',
    danger: true,
    flags: { enabled: true, deadlines: true, scheduled: true, autoCancel: true },
  },
];

/** Which of the five a set of flags amounts to. */
export function modeFor(settings) {
  if (!settings.enabled) return 'off';
  if (settings.autoCancel) return 'cancel';
  if (!settings.scheduled) return 'preview';
  return settings.deadlines ? 'chase_and_ask' : 'chase_forever';
}

/**
 * The stylesheet gives every input `width: 100%`, which is right for the text
 * fields it was written for and wrong for a checkbox or a radio: it stretches
 * across the row and pushes its own label onto the next line. Overridden here
 * rather than in the stylesheet, which other screens are laid out against.
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

  const mode = useMemo(() => modeFor(draft), [draft]);
  const savedMode = useMemo(() => (state ? modeFor(state.settings) : 'off'), [state]);

  if (error && !state) return <div className="banner error">{error}</div>;
  if (!state) return <div className="empty">Loading…</div>;

  const canEdit = state.canEdit;
  const changed = Object.keys(draft).filter((key) => draft[key] !== state.settings[key]);
  const wrongOrder = badOrder(draft);
  const turningOnCancel = mode === 'cancel' && savedMode !== 'cancel';
  const blocked = (turningOnCancel && !confirmCancel) || Boolean(wrongOrder);

  function set(key, value) {
    setNotice(null);
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function chooseMode(id) {
    setNotice(null);
    if (id !== 'cancel') setConfirmCancel(false);
    setDraft((current) => ({ ...current, ...MODES.find((entry) => entry.id === id).flags }));
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

  return (
    <section className="card stack" style={{ gap: '1.5rem' }}>
      <div>
        <h2 style={{ margin: 0 }}>Chasing unpaid bookings</h2>
        <p className="muted" style={{ margin: '0.35rem 0 0', maxWidth: '46rem' }}>
          When a booking comes in we email the guest a payment link. If the money does not arrive we send reminders,
          then a warning. Once they have paid we confirm the booking, send their arrival details before they play, and
          thank them afterwards.
        </p>
      </div>

      {!canEdit && <div className="banner">You can read these. An administrator changes them.</div>}

      {/* ---------------------------------------------------------------- */}
      <div className="stack" style={{ gap: '0.6rem' }}>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>How far should this go?</h3>

        <div className="stack" style={{ gap: '0.4rem' }}>
          {MODES.map((entry) => (
            <label
              key={entry.id}
              className="row"
              style={{
                gap: '0.6rem',
                alignItems: 'flex-start',
                padding: '0.7rem 0.85rem',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${mode === entry.id ? 'var(--brand-gold)' : 'var(--border)'}`,
                background: mode === entry.id ? 'rgba(201, 162, 39, 0.08)' : undefined,
                cursor: canEdit ? 'pointer' : 'default',
              }}
            >
              <input
                type="radio"
                name="lifecycle-mode"
                checked={mode === entry.id}
                onChange={() => chooseMode(entry.id)}
                disabled={!canEdit}
                style={{ ...PICKER, marginTop: '0.25rem' }}
              />
              <span className="stack" style={{ gap: '0.15rem' }}>
                <span style={{ fontWeight: 600 }}>
                  {entry.title}
                  {entry.recommended && (
                    <span className="tag" style={{ marginLeft: '0.5rem' }}>
                      recommended
                    </span>
                  )}
                </span>
                <span className="muted" style={{ fontSize: '0.8125rem' }}>
                  {entry.blurb}
                </span>
              </span>
            </label>
          ))}
        </div>

        {turningOnCancel && (
          <div className="banner error stack" style={{ gap: '0.5rem' }}>
            <div>
              Once this is on, the first anyone here knows of a cancellation is usually the guest replying to it. The
              booking itself is kept — marked Cancelled, with a note of what was owed and when it was chased — but the
              email has gone by then, and the tee time is free for somebody else.
            </div>
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

        {mode !== 'off' && (
          <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={Boolean(draft.visitorDunning)}
              onChange={(event) => set('visitorDunning', event.target.checked)}
              disabled={!canEdit}
              style={PICKER}
            />
            <span>
              Chase visitors too, not just tour operators
              <span className="muted" style={{ fontSize: '0.8125rem' }}>
                {' — '}
                off, a visitor still gets their receipt and arrival details, they are just never chased for money.
              </span>
            </span>
          </label>
        )}
      </div>

      {mode !== 'off' && (
        <>
          <div className="divider" />

          {/* ------------------------------------------------------------ */}
          <div className="stack" style={{ gap: '0.9rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>When</h3>

            <Sentence disabled={!canEdit}>
              Ask for the deposit within{' '}
              <Num id="depositWindowDays" draft={draft} state={state} onChange={set} disabled={!canEdit} /> days of the
              booking.
            </Sentence>

            <Sentence disabled={!canEdit}>
              Send the first reminder{' '}
              <Num id="depositReminderDay" draft={draft} state={state} onChange={set} disabled={!canEdit} /> days in,
              and another the day before the deadline.
            </Sentence>

            <Sentence disabled={!canEdit}>
              Give them until day{' '}
              <Num id="depositRescueDay" draft={draft} state={state} onChange={set} disabled={!canEdit} /> before the
              booking stops, warning them 48 and 24 hours beforehand.
            </Sentence>

            {wrongOrder && <div className="banner error">{wrongOrder}</div>}

            <Sentence disabled={!canEdit}>
              Tour operators owe the balance{' '}
              <Num id="balanceDueDaysBeforePlay" draft={draft} state={state} onChange={set} disabled={!canEdit} /> days
              before they play, with a first notice{' '}
              <Num id="balanceNoticeLeadDays" draft={draft} state={state} onChange={set} disabled={!canEdit} /> days
              before that.
            </Sentence>

            <p className="muted" style={{ margin: '-0.4rem 0 0', fontSize: '0.8125rem' }}>
              An account with its own agreed terms uses those instead.
            </p>

            <Sentence disabled={!canEdit}>
              Confirm the booking{' '}
              <Num id="confirmationDaysBeforePlay" draft={draft} state={state} onChange={set} disabled={!canEdit} />{' '}
              days before play, and send their arrival details{' '}
              <Num id="finalDetailsDaysBeforePlay" draft={draft} state={state} onChange={set} disabled={!canEdit} />{' '}
              days before.
            </Sentence>

            <Sentence disabled={!canEdit}>
              Say thank you{' '}
              <Num id="postPlayDaysAfterPlay" draft={draft} state={state} onChange={set} disabled={!canEdit} />{' '}
              {Number(draft.postPlayDaysAfterPlay) === 1 ? 'day' : 'days'} after they play.
            </Sentence>
          </div>

          <div className="divider" />

          {/* ------------------------------------------------------------ */}
          <div className="stack" style={{ gap: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>What a guest gets</h3>
            <LifecycleTimeline settings={draft} mode={mode} />
          </div>

          <div className="divider" />

          <h3 style={{ margin: 0, fontSize: '1rem' }}>If this has not run for a while</h3>

          <Sentence disabled={!canEdit}>
            Ignore anything that fell due more than{' '}
            <Num id="catchUpDays" draft={draft} state={state} onChange={set} disabled={!canEdit} /> days ago.
          </Sentence>
          <p className="muted" style={{ margin: '-0.6rem 0 0', fontSize: '0.8125rem', maxWidth: '46rem' }}>
            So switching this on today cannot email a year of old bookings about deadlines that passed months ago. Leave
            it low unless you are deliberately catching up.
          </p>
        </>
      )}

      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}

      {canEdit && (
        <div className="toolbar">
          <span className="muted" style={{ fontSize: '0.8125rem' }}>
            {changed.length ? 'Not saved yet' : 'Everything here is saved'}
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
            title={blocked ? wrongOrder || 'Confirm the warning above first' : undefined}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </section>
  );
}

/** A setting written as a sentence, so the units are never in doubt. */
function Sentence({ children, disabled }) {
  return <p style={{ margin: 0, lineHeight: 2.1, maxWidth: '46rem', opacity: disabled ? 0.7 : 1 }}>{children}</p>;
}

/** A number sitting inside that sentence. */
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

/**
 * Each number still needs a name a screen reader can say, since the sentence
 * around it is not attached to the input.
 */
const LABELS = {
  depositWindowDays: 'Days to pay the deposit',
  depositReminderDay: 'Days before the first reminder',
  depositRescueDay: 'Day the booking stops',
  balanceDueDaysBeforePlay: 'Days before play the balance is due',
  balanceNoticeLeadDays: 'Days before that for the first notice',
  confirmationDaysBeforePlay: 'Days before play to confirm',
  finalDetailsDaysBeforePlay: 'Days before play to send arrival details',
  postPlayDaysAfterPlay: 'Days after play to say thank you',
  catchUpDays: 'Ignore anything older than this many days',
};

/**
 * The orderings that read fine field by field and are nonsense as a sequence,
 * said in the same words the server would use if it got this far.
 */
function badOrder(settings) {
  const window = Number(settings.depositWindowDays);
  const reminder = Number(settings.depositReminderDay);
  const rescue = Number(settings.depositRescueDay);
  if (![window, reminder, rescue].every(Number.isFinite)) return null;

  if (reminder >= window) return 'The reminder needs to go out before the deadline it is reminding them about.';
  if (rescue <= window) return 'The booking cannot stop before the deadline it is waiting on.';
  if (rescue - window < 2) {
    return 'Leave at least two days after the deadline, so the 48- and 24-hour warnings have room.';
  }
  return null;
}
