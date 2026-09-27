import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import EmailThread from './EmailThread.jsx';

/**
 * Every email to and from this booking's guest, in the drawer, with a box to
 * write to them. The whole history in one place means whoever picks a booking
 * up next does not have to ask what has already been said.
 */
export default function BookingConversation({ booking }) {
  const [state, setState] = useState({ loading: true, available: true, thread: [] });
  const [composing, setComposing] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let live = true;
    setState({ loading: true, available: true, thread: [] });
    setComposing(false);
    setNotice(null);
    api
      .bookingThread(booking.bookingId)
      .then((payload) => live && setState({ loading: false, available: payload.available, thread: payload.thread ?? [] }))
      .catch((err) => live && setState({ loading: false, available: true, thread: [], error: err.message }));
    return () => {
      live = false;
    };
  }, [booking.bookingId]);

  async function send() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Send this email to ${booking.guestEmail}?`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.emailGuest(booking.bookingId, body, subject);
      setState({ loading: false, available: true, thread: result.thread });
      setNotice({ kind: 'success', text: result.message });
      setComposing(false);
      setBody('');
      setSubject('');
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  if (!state.available) return null;

  return (
    <div className="card stack" style={{ background: 'var(--surface-0)', gap: '0.6rem' }}>
      <div className="between">
        <div className="label">Emails with the guest{state.thread.length ? ` (${state.thread.length})` : ''}</div>
        {!composing && booking.guestEmail && (
          <button type="button" className="btn-sm" onClick={() => setComposing(true)}>
            Email the guest
          </button>
        )}
      </div>

      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}
      {state.error && <div className="banner error">{state.error}</div>}

      {composing && (
        <div className="stack" style={{ gap: '0.4rem' }}>
          <input
            placeholder={`Subject (default: Your booking ${booking.bookingId})`}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={busy}
          />
          <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} placeholder={`To ${booking.guestEmail}`} />
          <div className="row">
            <button type="button" className="btn-primary" onClick={send} disabled={busy || !body.trim()}>
              {busy ? 'Sending…' : 'Send'}
            </button>
            <button type="button" onClick={() => setComposing(false)} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {state.loading ? <div className="muted" style={{ fontSize: '0.8125rem' }}>Loading…</div> : <EmailThread thread={state.thread} />}
    </div>
  );
}
