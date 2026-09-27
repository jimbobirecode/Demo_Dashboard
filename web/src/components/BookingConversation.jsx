import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import EmailThread from './EmailThread.jsx';

/**
 * The guest's own words at the top of the drawer, and a way to answer them.
 *
 * "Original email" is the first thing the guest sent about this booking —
 * shown in full, because what they actually wrote (the "if possible", the
 * non-golfing partner, the "we'd prefer the morning") is what the fields
 * above cannot hold. Below it, the whole conversation, with Reply on every
 * email the guest sent and "Email the guest" for a fresh one.
 */
export default function BookingConversation({ booking }) {
  const [state, setState] = useState({ loading: true, available: true, thread: [] });
  const [replyTo, setReplyTo] = useState(null); // message id, or 'new'
  const [showThread, setShowThread] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let live = true;
    setState({ loading: true, available: true, thread: [] });
    setReplyTo(null);
    setShowThread(false);
    setNotice(null);
    api
      .bookingThread(booking.bookingId)
      .then((payload) => live && setState({ loading: false, available: payload.available, thread: payload.thread ?? [] }))
      .catch((err) => live && setState({ loading: false, available: true, thread: [], error: err.message }));
    return () => {
      live = false;
    };
  }, [booking.bookingId]);

  if (!state.available) return null;

  const thread = state.thread;
  const original = thread.find((message) => message.direction === 'inbound') ?? null;
  const rest = thread.filter((message) => message !== original);
  const latestInbound = [...thread].reverse().find((message) => message.direction === 'inbound') ?? null;

  function sent(result) {
    setState({ loading: false, available: true, thread: result.thread });
    setNotice({ kind: 'success', text: result.notice ?? result.message });
    setReplyTo(null);
    setShowThread(true);
  }

  const replyActions = (message) =>
    message.direction !== 'inbound' ? null : replyTo === message.id ? (
      <ReplyBox
        key={message.id}
        to={message.fromEmail}
        subjectHint={message.subject}
        send={(body) => api.inboxReply(message.id, body)}
        onSent={sent}
        onCancel={() => setReplyTo(null)}
      />
    ) : (
      <button type="button" className="btn-sm" onClick={() => setReplyTo(message.id)} style={{ padding: '0.1rem 0.6rem' }}>
        Reply
      </button>
    );

  return (
    <div className="card stack" style={{ background: 'var(--surface-0)', gap: '0.6rem' }}>
      <div className="between">
        <div className="label">Original email</div>
        {latestInbound && latestInbound !== original && (
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            Latest from the guest {formatDateTime(latestInbound.createdAt)}
          </span>
        )}
      </div>

      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}
      {state.error && <div className="banner error">{state.error}</div>}

      {state.loading ? (
        <div className="muted" style={{ fontSize: '0.8125rem' }}>Loading…</div>
      ) : original ? (
        <div className="stack" style={{ gap: '0.4rem' }}>
          <div style={{ fontSize: '0.8125rem' }}>
            <strong>{original.fromEmail}</strong>
            <span className="muted"> · {formatDateTime(original.createdAt)}</span>
          </div>
          <div style={{ fontWeight: 600 }}>{original.subject || '(no subject)'}</div>
          <div
            style={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontSize: '0.875rem',
              lineHeight: 1.55,
              maxHeight: '22rem',
              overflowY: 'auto',
              padding: '0.6rem 0.75rem',
              background: 'var(--surface-1)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {original.body}
          </div>
          <div>{replyActions(original)}</div>
        </div>
      ) : (
        <div className="muted" style={{ fontSize: '0.8125rem' }}>
          No original email is recorded for this booking. Emails are recorded from when the email log was switched on;
          bookings made before then, through the booking form or from an uploaded tee sheet have none.
        </div>
      )}

      <div className="between" style={{ marginTop: '0.25rem' }}>
        {rest.length > 0 ? (
          <button type="button" className="btn-sm" onClick={() => setShowThread(!showThread)}>
            {showThread ? 'Hide' : 'Show'} the rest of the conversation ({rest.length})
          </button>
        ) : (
          <span />
        )}
        {booking.guestEmail && replyTo !== 'new' && (
          <button type="button" className="btn-sm" onClick={() => setReplyTo('new')}>
            Email the guest
          </button>
        )}
      </div>

      {replyTo === 'new' && (
        <ReplyBox
          to={booking.guestEmail}
          withSubject
          subjectHint={`Your booking ${booking.bookingId}`}
          send={(body, subject) => api.emailGuest(booking.bookingId, body, subject)}
          onSent={sent}
          onCancel={() => setReplyTo(null)}
        />
      )}

      {showThread && rest.length > 0 && <EmailThread thread={rest} actions={replyActions} />}
    </div>
  );
}

function ReplyBox({ to, subjectHint, withSubject = false, send, onSent, onCancel }) {
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Send this email to ${to}?`)) return;
    setBusy(true);
    setError(null);
    try {
      onSent(await send(body, subject));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: '0.4rem', width: '100%', marginTop: '0.25rem' }}>
      <div className="muted" style={{ fontSize: '0.75rem' }}>
        To {to}
        {!withSubject && subjectHint ? ` · Re: ${subjectHint.replace(/^re:\s*/i, '')}` : ''}
        {!withSubject ? ' · their email is quoted underneath' : ''}
      </div>
      {withSubject && (
        <input placeholder={`Subject (default: ${subjectHint})`} value={subject} onChange={(e) => setSubject(e.target.value)} disabled={busy} />
      )}
      <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} autoFocus placeholder="Write your reply…" />
      {error && <div className="banner error">{error}</div>}
      <div className="row">
        <button type="button" className="btn-primary" onClick={submit} disabled={busy || !body.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}
