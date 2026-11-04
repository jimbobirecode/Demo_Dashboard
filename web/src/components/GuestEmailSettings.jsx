import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/**
 * The emails that go to guests without anybody choosing to send them.
 *
 * One switch so far. A guest who asks to move or cancel a booking used to get
 * an immediate "we have your request", sent with the request itself; the
 * club's real answer followed later from the Requests page. Two emails about
 * one question, the first of which repeated the page the guest had just
 * submitted. It is off unless this club turns it on.
 *
 * The club's *answer* is not a switch and is not here: it is sent because
 * somebody pressed Approve or Decline, and a guest whose cancellation is
 * agreed has to be told.
 */
const PICKER = { width: 'auto', flex: '0 0 auto', margin: 0 };

export default function GuestEmailSettings() {
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .guestEmailSettings()
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
      const payload = await api.saveGuestEmailSettings(patch);
      setState((current) => ({ ...current, settings: payload.settings }));
      setDraft(payload.settings);
      setNotice({ kind: 'success', text: 'Saved.' });
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" style={{ gap: '1rem' }}>
      <div>
        <h2 style={{ margin: 0 }}>Emailing guests</h2>
        <p className="muted" style={{ margin: '0.35rem 0 0' }}>
          What goes out on its own, without anybody here pressing a button.
        </p>
      </div>

      {!canEdit && <div className="banner">Only an administrator can change these.</div>}
      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}

      <label className="row" style={{ gap: '0.6rem', alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={Boolean(draft.requestReceived)}
          onChange={(event) => set('requestReceived', event.target.checked)}
          disabled={!canEdit || busy}
          style={PICKER}
        />
        <span style={{ fontWeight: 600, fontSize: '1rem' }}>Acknowledge a guest&rsquo;s change request</span>
      </label>
      <p className="muted" style={{ margin: '-0.65rem 0 0 1.6rem', fontSize: '0.8125rem' }}>
        {draft.requestReceived
          ? 'A guest who asks to move or cancel is emailed straight away to say the club has it.'
          : 'Nothing is sent when a request arrives. The guest sees the confirmation on the page, and hears from ' +
            'the club when somebody answers on '}
        {!draft.requestReceived && <Link to="/requests">Requests</Link>}
        {!draft.requestReceived && '.'}
      </p>
      <p className="muted" style={{ margin: '-0.4rem 0 0 1.6rem', fontSize: '0.8125rem' }}>
        The club&rsquo;s answer &mdash; approved, declined, cancelled &mdash; is sent either way. It goes because
        somebody pressed a button, so it is not a switch.
      </p>

      {canEdit && (
        <div className="row" style={{ gap: '0.75rem', alignItems: 'center' }}>
          <button type="button" className="btn-primary" onClick={save} disabled={busy || changed.length === 0}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {changed.length > 0 && <span className="muted">Unsaved</span>}
        </div>
      )}
    </section>
  );
}
