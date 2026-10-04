import { useEffect, useState } from 'react';
import { Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { api, portalStatementUrl } from '../lib/api.js';
import { BRAND } from '../lib/brand.js';
import { formatCurrency, formatDate } from '../lib/format.js';
import StatusPill from '../components/StatusPill.jsx';
import KpiTile from '../components/KpiTile.jsx';
import Wordmark from '../components/Wordmark.jsx';

/**
 * The tour operator portal: its own sign-in (an emailed one-time link) and
 * one page with every booking on the operator's account, what is owed and
 * when, and the ways to ask the club for something. Nothing here changes a
 * booking by itself - requests land with the club's staff.
 */
export default function Portal() {
  return (
    <Routes>
      <Route path="/portal/sign-in" element={<RedeemLink />} />
      <Route path="*" element={<PortalHome />} />
    </Routes>
  );
}

function RedeemLink() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setError('This sign-in link is incomplete. Request a new one below.');
      return;
    }
    api
      .portalRedeem(token)
      .then(() => navigate('/portal', { replace: true }))
      .catch((err) => setError(err.message));
  }, [params, navigate]);

  if (!error) return <div className="empty">Signing you in…</div>;
  return <SignIn notice={{ kind: 'error', text: error }} />;
}

function SignIn({ notice = null }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(notice);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const payload = await api.portalLogin(email.trim());
      setMessage({ kind: 'success', text: payload.message, sent: true });
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <Wordmark showTagline={false} />
        <h1 style={{ fontSize: '1.125rem' }}>Tour operator portal</h1>
        <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>
          See all your bookings with {BRAND.fullName}, what is due and when, pay online and send us requests. Enter your
          work email and we will send you a sign-in link - no password needed.
        </p>
        {message && (
          <div className={`banner ${message.kind}`} role="status">
            {message.text}
          </div>
        )}
        {!message?.sent && (
          <>
            <label className="stack" style={{ gap: '0.35rem' }}>
              <span className="label">Work email address</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoFocus
              />
            </label>
            <button type="submit" className="btn-primary" disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Email me a sign-in link'}
            </button>
          </>
        )}
        {message?.sent && (
          <button type="button" className="link-button" onClick={() => setMessage(null)}>
            Use a different address
          </button>
        )}
      </form>
    </div>
  );
}

function PortalHome() {
  const [me, setMe] = useState({ loading: true });
  const [list, setList] = useState(null);
  const [notice, setNotice] = useState(null);
  const [view, setView] = useState('current');
  const [open, setOpen] = useState(null); // { bookingId, kind } for the inline request form
  const [enquiring, setEnquiring] = useState(false);
  const [paying, setPaying] = useState(null);

  async function load() {
    try {
      const [account, bookings] = await Promise.all([api.portalMe(), api.portalBookings()]);
      setMe({ data: account });
      setList(bookings);
    } catch (err) {
      setMe(err.status === 401 ? { signedOut: true } : { error: err.message });
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (me.loading) return <div className="empty">Loading your bookings…</div>;
  if (me.signedOut) return <SignIn />;
  if (me.error) {
    return (
      <div className="login-page">
        <div className="card login-card">
          <Wordmark showTagline={false} />
          <div className="banner error">{me.error}</div>
        </div>
      </div>
    );
  }

  const { operator, account, canPayOnline, email } = me.data;
  const today = list?.today ?? '';
  const bookings = list?.bookings ?? [];
  const shown =
    view === 'current' ? bookings.filter((b) => (b.date && b.date >= today) || b.outstanding > 0) : bookings;

  async function signOut() {
    await api.portalLogout().catch(() => {});
    setMe({ signedOut: true });
  }

  async function pay(booking) {
    setPaying(booking.bookingId);
    setNotice(null);
    try {
      const { url } = await api.portalPay(booking.bookingId);
      window.location.assign(url);
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
      setPaying(null);
    }
  }

  function done(text) {
    setNotice({ kind: 'success', text });
    setOpen(null);
    setEnquiring(false);
    load();
  }

  return (
    <div className="portal">
      <header className="portal-header between">
        <div className="row" style={{ gap: '1rem', alignItems: 'center' }}>
          <Wordmark showTagline={false} />
          <div>
            <div style={{ fontWeight: 700, fontSize: '1.0625rem' }}>{operator.name}</div>
            <div className="muted" style={{ fontSize: '0.8125rem' }}>
              {operator.accountCode ? `Account ${operator.accountCode} · ` : ''}Signed in as {email}
            </div>
          </div>
        </div>
        <button type="button" className="btn-sm" onClick={signOut}>
          Sign out
        </button>
      </header>

      <main className="portal-main stack" style={{ gap: '1.25rem' }}>
        {operator.onHold && (
          <div className="banner error">
            Your account is on hold. Existing bookings stand, but please contact the club before making new ones.
          </div>
        )}
        {notice && (
          <div className={`banner ${notice.kind}`} role="status">
            {notice.text}
          </div>
        )}

        <div className="kpi-row">
          <KpiTile
            label="Outstanding"
            value={formatCurrency(account.outstanding)}
            sub={`${account.bookings} booking${account.bookings === 1 ? '' : 's'} on account`}
          />
          <KpiTile
            label="Overdue"
            value={formatCurrency(account.overdueAmount)}
            sub={
              account.overdueCount
                ? `${account.overdueCount} booking${account.overdueCount === 1 ? '' : 's'}, oldest ${account.maxDaysOverdue} days`
                : 'Nothing overdue'
            }
            accent={account.overdueCount ? 'var(--status-rejected)' : undefined}
          />
          {account.creditLimit !== null && (
            <KpiTile
              label="Credit available"
              value={formatCurrency(Math.max(account.headroom, 0))}
              sub={`of a ${formatCurrency(account.creditLimit)} limit`}
            />
          )}
          <KpiTile
            label="Next round"
            value={account.nextPlayDate ? formatDate(account.nextPlayDate) : '-'}
            sub={operator.terms}
          />
        </div>

        <section className="card stack" style={{ gap: '0.75rem' }}>
          <div className="between" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
            <div className="segmented" role="group" aria-label="Which bookings">
              <button type="button" aria-pressed={view === 'current'} onClick={() => setView('current')}>
                Upcoming &amp; owing
              </button>
              <button type="button" aria-pressed={view === 'all'} onClick={() => setView('all')}>
                All bookings ({bookings.length})
              </button>
            </div>
            <div className="row" style={{ gap: '0.5rem' }}>
              <a className="button-link btn-sm" href={portalStatementUrl} download>
                Download statement (CSV)
              </a>
              <button type="button" className="btn-sm btn-primary" onClick={() => setEnquiring(!enquiring)}>
                {enquiring ? 'Close' : 'Request new tee times'}
              </button>
            </div>
          </div>

          {enquiring && <EnquiryForm onDone={done} onCancel={() => setEnquiring(false)} />}

          {shown.length === 0 ? (
            <div className="muted" style={{ padding: '1rem 0' }}>
              {view === 'current' ? 'Nothing upcoming or owing.' : 'No bookings on this account yet.'}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Booking</th>
                    <th>Play date</th>
                    <th>Tee time</th>
                    <th>Players</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th style={{ textAlign: 'right' }}>Paid</th>
                    <th style={{ textAlign: 'right' }}>Outstanding</th>
                    <th>Due</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((b) => (
                    <BookingRow
                      key={b.bookingId}
                      booking={b}
                      today={today}
                      canPayOnline={canPayOnline}
                      paying={paying === b.bookingId}
                      open={open?.bookingId === b.bookingId ? open.kind : null}
                      onOpen={(kind) => setOpen(kind ? { bookingId: b.bookingId, kind } : null)}
                      onPay={() => pay(b)}
                      onDone={done}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="muted" style={{ fontSize: '0.8125rem', margin: 0 }}>
          Changes and cancellations are requests: your booking stays as it is until the club confirms by email.
          Questions about your account? Reply to any email from {BRAND.fullName}.
        </p>
      </main>
    </div>
  );
}

function BookingRow({ booking: b, today, canPayOnline, paying, open, onOpen, onPay, onDone }) {
  const played = b.date && b.date < today;
  const live = !['Cancelled', 'Rejected'].includes(b.status) && !played;
  const teeTimes = Array.isArray(b.teeTimes) && b.teeTimes.length ? b.teeTimes.join(', ') : b.teeTime;

  return (
    <>
      <tr>
        <td>
          <div className="mono" style={{ whiteSpace: 'nowrap' }}>
            {b.bookingId}
          </div>
          {b.guestName && (
            <div className="muted" style={{ fontSize: '0.75rem' }}>
              {b.guestName}
            </div>
          )}
        </td>
        <td>{b.date ? formatDate(b.date) : '-'}</td>
        <td>{teeTimes || '-'}</td>
        <td>{b.players ?? '-'}</td>
        <td>
          <StatusPill status={b.status} />
          {b.pendingRequest && (
            <div className="muted" style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
              {b.pendingRequest.kind === 'cancel' ? 'Cancellation requested' : 'Change requested'}
            </div>
          )}
        </td>
        <td style={{ textAlign: 'right' }}>{formatCurrency(b.total)}</td>
        <td style={{ textAlign: 'right' }}>{formatCurrency(b.paid)}</td>
        <td style={{ textAlign: 'right', fontWeight: b.outstanding > 0 ? 700 : 400 }}>
          {formatCurrency(b.outstanding)}
        </td>
        <td>
          {b.dueDate && b.outstanding > 0 ? (
            <span style={b.overdue ? { color: 'var(--status-rejected)', fontWeight: 700 } : undefined}>
              {formatDate(b.dueDate)}
              {b.overdue ? ` · ${b.daysOverdue}d overdue` : ''}
            </span>
          ) : (
            <span className="muted">-</span>
          )}
        </td>
        <td>
          <div className="row" style={{ gap: '0.35rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {canPayOnline && b.canPay && (
              <button
                type="button"
                className="btn-sm btn-primary"
                style={{ whiteSpace: 'nowrap' }}
                disabled={paying}
                onClick={onPay}
              >
                {paying ? 'Opening…' : `Pay ${formatCurrency(b.outstanding)}`}
              </button>
            )}
            {live && !b.pendingRequest && (
              <>
                <button
                  type="button"
                  className="btn-sm"
                  aria-pressed={open === 'amend'}
                  onClick={() => onOpen(open === 'amend' ? null : 'amend')}
                >
                  Change
                </button>
                <button
                  type="button"
                  className="btn-sm"
                  aria-pressed={open === 'cancel'}
                  onClick={() => onOpen(open === 'cancel' ? null : 'cancel')}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={10} style={{ background: 'var(--surface-0)' }}>
            <RequestForm booking={b} kind={open} onDone={onDone} onCancel={() => onOpen(null)} />
          </td>
        </tr>
      )}
    </>
  );
}

function RequestForm({ booking, kind, onDone, onCancel }) {
  const [form, setForm] = useState({ requestedDate: '', requestedTime: '', requestedPlayers: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { kind, message: form.message };
      if (kind === 'amend') {
        if (form.requestedDate) body.requestedDate = form.requestedDate;
        if (form.requestedTime) body.requestedTime = form.requestedTime;
        if (form.requestedPlayers) body.requestedPlayers = form.requestedPlayers;
      }
      const result = await api.portalRequest(booking.bookingId, body);
      onDone(result.message);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" style={{ gap: '0.6rem', padding: '0.5rem 0' }} onSubmit={submit}>
      <strong>{kind === 'cancel' ? `Ask to cancel ${booking.bookingId}` : `Ask to change ${booking.bookingId}`}</strong>
      {kind === 'cancel' && (
        <div className="muted" style={{ fontSize: '0.8125rem' }}>
          The booking is not cancelled until the club confirms it by email. Any cancellation terms on your account
          apply.
        </div>
      )}
      {kind === 'amend' && (
        <div className="row" style={{ gap: '0.75rem', flexWrap: 'wrap' }}>
          <label className="stack" style={{ gap: '0.25rem' }}>
            <span className="label">New date (optional)</span>
            <input type="date" value={form.requestedDate} onChange={set('requestedDate')} />
          </label>
          <label className="stack" style={{ gap: '0.25rem' }}>
            <span className="label">Preferred time (optional)</span>
            <input value={form.requestedTime} onChange={set('requestedTime')} placeholder="e.g. 09:30" />
          </label>
          <label className="stack" style={{ gap: '0.25rem' }}>
            <span className="label">Players (optional)</span>
            <input
              type="number"
              min="1"
              max="40"
              value={form.requestedPlayers}
              onChange={set('requestedPlayers')}
              style={{ width: '6rem' }}
            />
          </label>
        </div>
      )}
      <label className="stack" style={{ gap: '0.25rem' }}>
        <span className="label">{kind === 'cancel' ? 'Reason (optional)' : 'What would you like to change?'}</span>
        <textarea rows={3} value={form.message} onChange={set('message')} />
      </label>
      {error && <div className="banner error">{error}</div>}
      <div className="row" style={{ gap: '0.5rem' }}>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Sending…' : kind === 'cancel' ? 'Send cancellation request' : 'Send change request'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Close
        </button>
      </div>
    </form>
  );
}

function EnquiryForm({ onDone, onCancel }) {
  const [form, setForm] = useState({ date: '', players: '', course: '', timing: '', groupName: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.portalEnquiry(form);
      onDone(result.message);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="card stack" style={{ gap: '0.6rem', background: 'var(--surface-0)' }} onSubmit={submit}>
      <strong>Request new tee times</strong>
      <div className="muted" style={{ fontSize: '0.8125rem' }}>
        The club will check availability and reply by email with tee times to confirm.
      </div>
      <div className="row" style={{ gap: '0.75rem', flexWrap: 'wrap' }}>
        <label className="stack" style={{ gap: '0.25rem' }}>
          <span className="label">Date</span>
          <input type="date" value={form.date} onChange={set('date')} required />
        </label>
        <label className="stack" style={{ gap: '0.25rem' }}>
          <span className="label">Players</span>
          <input
            type="number"
            min="1"
            max="200"
            value={form.players}
            onChange={set('players')}
            required
            style={{ width: '6rem' }}
          />
        </label>
        <label className="stack" style={{ gap: '0.25rem' }}>
          <span className="label">Preferred time</span>
          <input value={form.timing} onChange={set('timing')} placeholder="e.g. morning, after 10:00" />
        </label>
        <label className="stack" style={{ gap: '0.25rem' }}>
          <span className="label">Course (optional)</span>
          <input value={form.course} onChange={set('course')} />
        </label>
        <label className="stack" style={{ gap: '0.25rem' }}>
          <span className="label">Group / lead guest</span>
          <input value={form.groupName} onChange={set('groupName')} />
        </label>
      </div>
      <label className="stack" style={{ gap: '0.25rem' }}>
        <span className="label">Anything else</span>
        <textarea
          rows={3}
          value={form.notes}
          onChange={set('notes')}
          placeholder="Multiple days, replay rounds, buggies…"
        />
      </label>
      {error && <div className="banner error">{error}</div>}
      <div className="row" style={{ gap: '0.5rem' }}>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Sending…' : 'Send request'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Close
        </button>
      </div>
    </form>
  );
}
