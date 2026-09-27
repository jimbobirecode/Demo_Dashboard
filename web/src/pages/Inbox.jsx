import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatCurrency, formatDate, formatDateTime, formatNumber } from '../lib/format.js';
import EmailThread from '../components/EmailThread.jsx';
import StatusPill from '../components/StatusPill.jsx';

const FILTERS = [
  { id: 'open', label: 'To answer' },
  { id: 'replied', label: 'Replied' },
  { id: 'dismissed', label: 'Dismissed' },
  { id: 'all', label: 'All received' },
];

/**
 * Emails a person has to answer.
 *
 * The bot answers plain enquiries itself. Everything else — a question, a
 * complaint, a tour operator, an enquiry with no dates, anything Claude was
 * unsure about — lands here with what Claude understood and a drafted reply.
 * The guest has already been told a person will reply. Nothing is sent from
 * here until somebody presses Send.
 */
export default function Inbox({ onCountChange }) {
  const [filter, setFilter] = useState('open');
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const payload = await api.inbox(filter);
      setData(payload);
      setError(null);
      onCountChange?.(payload.counts?.open ?? 0);
    } catch (err) {
      setError(err.message);
    }
  }, [filter, onCountChange]);

  useEffect(() => {
    load();
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!data) return <div className="empty">{error ?? 'Loading inbox…'}</div>;
  if (!data.available) {
    return (
      <div className="stack">
        <h1>Inbox</h1>
        <div className="banner error">
          Run <code>{data.migration}</code> on the database to turn the Inbox on. Until then, emails the bot cannot
          answer are handled the old way.
        </div>
      </div>
    );
  }

  const messages = data.messages;
  const selected = messages.find((m) => m.id === selectedId) ?? null;

  return (
    <div className="stack">
      <div className="between">
        <div>
          <h1>Inbox</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Emails the bot held for a person: questions, complaints, tour operators, anything unclear. The guest has
            been told the team will reply.
          </p>
        </div>
        <button type="button" onClick={load}>Refresh</button>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="segmented" role="group" aria-label="Which emails">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={filter === entry.id}
            onClick={() => {
              setFilter(entry.id);
              setSelectedId(null);
            }}
          >
            {entry.label}
            {entry.id !== 'all' && data.counts?.[entry.id] ? ` (${formatNumber(data.counts[entry.id])})` : ''}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 380px) 1fr', gap: '1rem', alignItems: 'start' }}>
        <div className="stack" style={{ gap: '0.4rem' }}>
          {!messages.length && (
            <div className="empty">{filter === 'open' ? 'Nothing waiting — every email has been answered.' : 'None.'}</div>
          )}
          {messages.map((message) => (
            <button
              key={message.id}
              type="button"
              onClick={() => setSelectedId(message.id)}
              aria-pressed={message.id === selectedId}
              style={{
                textAlign: 'left',
                display: 'block',
                width: '100%',
                background: message.id === selectedId ? 'var(--surface-2)' : 'var(--surface-1)',
                border: `1px solid ${message.id === selectedId ? 'var(--brand-gold)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-sm)',
                padding: '0.6rem 0.75rem',
              }}
            >
              <div className="between" style={{ gap: '0.5rem' }}>
                <strong style={{ fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>{message.fromEmail}</strong>
                <span className="muted" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>{formatDateTime(message.createdAt)}</span>
              </div>
              <div style={{ fontSize: '0.8125rem' }}>{message.subject || '(no subject)'}</div>
              <div className="muted" style={{ fontSize: '0.75rem' }}>
                {[message.intentLabel, message.reviewReason || message.routeLabel].filter(Boolean).join(' · ')}
              </div>
            </button>
          ))}
        </div>

        <div>
          {selected ? (
            <InboxDetail key={selected.id} id={selected.id} onChanged={load} />
          ) : (
            messages.length > 0 && <div className="empty">Choose an email to read it and reply.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function InboxDetail({ id, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [reply, setReply] = useState('');
  const [linkRef, setLinkRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let live = true;
    api.inboxMessage(id).then((payload) => {
      if (!live) return;
      setDetail(payload);
      setReply(payload.message.draftReply || '');
    }).catch((err) => live && setNotice({ kind: 'error', text: err.message }));
    return () => {
      live = false;
    };
  }, [id]);

  async function act(action, success) {
    setBusy(true);
    setNotice(null);
    try {
      const payload = await action();
      setDetail(payload);
      setNotice({ kind: 'success', text: payload.notice ?? success });
      onChanged();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  if (!detail) return <div className="empty">{notice?.text ?? 'Loading…'}</div>;
  const { message, thread, booking } = detail;
  const extraction = message.extraction ?? {};
  const open = message.reviewStatus === 'open';

  function send() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Send this reply to ${message.fromEmail}?`)) return;
    act(() => api.inboxReply(message.id, reply), 'Reply sent');
  }

  return (
    <div className="card stack" style={{ gap: '0.9rem' }}>
      <div className="between" style={{ alignItems: 'flex-start', gap: '1rem' }}>
        <div>
          <div style={{ fontWeight: 700 }}>{message.subject || '(no subject)'}</div>
          <div className="muted" style={{ fontSize: '0.8125rem' }}>
            From {message.fromEmail} · {formatDateTime(message.createdAt)}
          </div>
        </div>
        <span className="muted" style={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>
          {message.reviewStatus === 'replied'
            ? `Replied by ${message.handledBy} ${formatDateTime(message.handledAt)}`
            : message.reviewStatus === 'dismissed'
              ? `Dismissed by ${message.handledBy}`
              : 'Waiting for a reply'}
        </span>
      </div>

      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}

      <div className="detail-grid">
        <div>
          <div className="label">Understood as</div>
          <div>{message.intentLabel ?? '—'}{extraction.source === 'keywords' ? ' (keyword match — Claude unavailable)' : ''}</div>
        </div>
        <div>
          <div className="label">Why it is here</div>
          <div>{message.reviewReason || message.routeLabel || '—'}</div>
        </div>
        <div>
          <div className="label">Booking</div>
          {booking ? (
            <div className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
              <span className="mono">{booking.bookingId}</span>
              <StatusPill status={booking.status} />
            </div>
          ) : (
            <div className="row" style={{ gap: '0.4rem' }}>
              <input
                placeholder="Attach to booking ref"
                value={linkRef}
                onChange={(e) => setLinkRef(e.target.value)}
                style={{ width: '12rem' }}
              />
              <button
                type="button"
                className="btn-sm"
                disabled={busy || !linkRef.trim()}
                onClick={() => act(() => api.inboxLink(message.id, linkRef), 'Attached to the booking')}
              >
                Attach
              </button>
            </div>
          )}
        </div>
      </div>
      {booking && (
        <div className="secondary" style={{ fontSize: '0.8125rem' }}>
          {booking.guestName || 'Guest'} · {booking.date ? formatDate(booking.date) : 'no date'}
          {booking.teeTime ? `, ${booking.teeTime}` : ''} · {booking.players} players · {formatCurrency(booking.total)}
        </div>
      )}
      {message.summary && (
        <div className="secondary" style={{ fontStyle: 'italic' }}>{message.summary}</div>
      )}

      <div>
        <div className="label" style={{ marginBottom: '0.4rem' }}>Conversation</div>
        <EmailThread thread={thread} highlightId={message.id} />
      </div>

      <div className="stack" style={{ gap: '0.4rem' }}>
        <div className="between">
          <span className="label">Your reply to {message.fromEmail}</span>
          {message.draftReply && (
            <span className="muted" style={{ fontSize: '0.75rem' }}>Drafted by Claude from the club&rsquo;s own information — check it before sending</span>
          )}
        </div>
        <textarea
          rows={10}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          disabled={busy}
          placeholder="Write a reply…"
        />
        <div className="row">
          <button type="button" className="btn-primary" disabled={busy || !reply.trim()} onClick={send}>
            {busy ? 'Sending…' : 'Send reply'}
          </button>
          {open ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => act(() => api.inboxStatus(message.id, 'dismissed'), 'Dismissed — no reply sent')}
            >
              Dismiss without replying
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => act(() => api.inboxStatus(message.id, 'open'), 'Back in the inbox')}>
              Reopen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
