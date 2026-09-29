import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatCurrency, formatDate, formatNumber } from '../lib/format.js';
import Wordmark from '../components/Wordmark.jsx';

/**
 * A guest's own booking, reached from a link in their confirmation email.
 *
 * Signed out by necessity — a guest has no account — so it shows only what the
 * holder of the link already knows and offers only what club policy allows.
 * What the buttons will actually do is said in words before they are pressed:
 * whether a cancellation takes effect now or waits for the club is the one
 * thing somebody must not be surprised by.
 */
export default function ManageBooking() {
  const [params] = useSearchParams();
  const ref = params.get('ref') ?? '';
  const token = params.get('token') ?? '';

  const [state, setState] = useState({ status: 'loading' });
  const [kind, setKind] = useState(null);
  const [form, setForm] = useState({ message: '', requestedDate: '', requestedTime: '', requestedPlayers: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ref || !token) {
      setState({ status: 'invalid', reason: 'That link is incomplete. Please ring the club.' });
      return;
    }
    api
      .manageBooking(ref, token)
      .then((payload) => setState({ status: 'ready', ...payload }))
      .catch((err) => setState({ status: 'invalid', reason: err.message }));
  }, [ref, token]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.requestBookingChange({ ref, token, kind, ...form });
      setState({ status: 'done', message: result.message, applied: result.applied });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (state.status === 'loading') return <div className="empty">Finding your booking…</div>;

  if (state.status === 'invalid') {
    return (
      <div className="login-page">
        <div className="card login-card">
          <Wordmark showTagline={false} />
          <div className="banner error">{state.reason}</div>
        </div>
      </div>
    );
  }

  if (state.status === 'done') {
    return (
      <div className="login-page">
        <div className="card login-card">
          <Wordmark showTagline={false} />
          <div className="banner success">{state.message}</div>
        </div>
      </div>
    );
  }

  const { booking, options, pending } = state;

  return (
    <div className="login-page">
      <div className="card login-card" style={{ width: 'min(560px, 100%)' }}>
        <Wordmark showTagline={false} />

        <h1 style={{ fontSize: '1.125rem' }}>Your booking</h1>

        <div className="card" style={{ background: 'var(--surface-0)' }}>
          <div className="detail-grid">
            <Detail label="Reference" value={booking.bookingId} mono />
            <Detail label="Date" value={booking.date ? formatDate(booking.date) : '—'} />
            <Detail label="Tee time" value={booking.teeTime || '—'} />
            <Detail label="Players" value={formatNumber(booking.players)} />
            {booking.golfCourses && <Detail label="Course" value={booking.golfCourses} />}
            {booking.total > 0 && <Detail label="Total" value={formatCurrency(booking.total)} />}
          </div>
        </div>

        {pending?.length > 0 && (
          <div className="banner">
            You have already asked the club to {pending[0].kind === 'cancel' ? 'cancel this booking' : 'change this booking'}.
            They will be in touch.
          </div>
        )}

        {error && <div className="banner error">{error}</div>}

        {!options.canCancel && !options.canAmend ? (
          <div className="banner">{options.reason}</div>
        ) : pending?.length ? null : !kind ? (
          <div className="stack" style={{ gap: '0.5rem' }}>
            <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>{options.reason}</p>
            <div className="row">
              {options.canAmend && (
                <button type="button" className="btn-primary" onClick={() => setKind('amend')}>
                  Request a change
                </button>
              )}
              {options.canCancel && (
                <button type="button" onClick={() => setKind('cancel')}>
                  Request a cancellation
                </button>
              )}
            </div>
          </div>
        ) : (
          <form className="stack" style={{ gap: '0.75rem' }} onSubmit={submit}>
            {kind === 'cancel' ? (
              <div className="banner">
                This sends a cancellation request to the club. Your booking is not cancelled until the club confirms
                it — your tee time is held until then, and you will get an email either way.
              </div>
            ) : (
              <div className="toolbar">
                <label className="stack" style={{ gap: '0.35rem' }}>
                  <span className="label">New date</span>
                  <input
                    type="date"
                    value={form.requestedDate}
                    onChange={(event) => setForm({ ...form, requestedDate: event.target.value })}
                    style={{ width: 'auto' }}
                  />
                </label>
                <label className="stack" style={{ gap: '0.35rem' }}>
                  <span className="label">Preferred time</span>
                  <input
                    value={form.requestedTime}
                    onChange={(event) => setForm({ ...form, requestedTime: event.target.value })}
                    placeholder="Morning"
                    style={{ width: '8rem' }}
                  />
                </label>
                <label className="stack" style={{ gap: '0.35rem' }}>
                  <span className="label">Players</span>
                  <input
                    type="number"
                    min="1"
                    max="40"
                    value={form.requestedPlayers}
                    onChange={(event) => setForm({ ...form, requestedPlayers: event.target.value })}
                    style={{ width: '5rem' }}
                  />
                </label>
              </div>
            )}

            <label className="stack" style={{ gap: '0.35rem' }}>
              <span className="label">
                {kind === 'cancel' ? 'Anything to tell the club? (optional)' : 'What would you like to change?'}
              </span>
              <textarea
                rows={3}
                value={form.message}
                onChange={(event) => setForm({ ...form, message: event.target.value })}
                required={kind === 'amend' && !form.requestedDate}
              />
            </label>

            <div className="row">
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? 'Sending…' : kind === 'cancel'
                  ? 'Send cancellation request'
                  : 'Send request'}
              </button>
              <button type="button" onClick={() => { setKind(null); setError(null); }}>
                Back
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function Detail({ label, value, mono }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className={mono ? 'mono' : undefined} style={{ fontWeight: 600 }}>{value}</div>
    </div>
  );
}
