import { useState } from 'react';
import { formatDateTime } from '../lib/format.js';

const KIND_LABELS = {
  availability: 'Tee time availability',
  holding: '“We’ve got your message”',
  change_acknowledgement: 'Change request acknowledged',
  acknowledgement: 'Acknowledgement',
  payment_link: 'Payment link',
  receipt: 'Payment receipt',
  pre_arrival: 'Pre-arrival welcome',
  post_play: 'Post-play thank you',
  reply: 'Reply',
  automatic: 'Automatic email',
};

/**
 * A conversation, oldest first: what the guest wrote, and everything sent to
 * them — by the bot, by Stripe's receipt, or by a person. Long emails start
 * folded so a thread stays readable.
 */
export default function EmailThread({ thread, highlightId = null, actions = null }) {
  if (!thread?.length) {
    return <div className="muted" style={{ fontSize: '0.8125rem' }}>No emails recorded yet.</div>;
  }
  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      {thread.map((message) => (
        <ThreadMessage key={message.id} message={message} highlighted={message.id === highlightId} actions={actions} />
      ))}
    </div>
  );
}

function ThreadMessage({ message, highlighted, actions }) {
  const inbound = message.direction === 'inbound';
  const long = message.body.length > 600;
  const [open, setOpen] = useState(!long || highlighted);
  const who = inbound
    ? message.fromEmail
    : message.sentBy === 'bot'
      ? 'Sent automatically'
      : message.sentBy === 'Stripe'
        ? 'Sent on payment'
        : `Sent by ${message.sentBy ?? 'the club'}`;

  return (
    <div
      style={{
        border: `1px solid ${highlighted ? 'var(--brand-gold)' : 'var(--border)'}`,
        borderLeft: `3px solid ${inbound ? 'var(--north-sea, #2F5D7C)' : 'var(--brand-gold)'}`,
        borderRadius: 'var(--radius-sm)',
        background: inbound ? 'var(--surface-1)' : 'var(--surface-0)',
        padding: '0.6rem 0.75rem',
      }}
    >
      <div className="between" style={{ gap: '0.5rem', alignItems: 'baseline' }}>
        <div style={{ fontSize: '0.8125rem' }}>
          <strong>{inbound ? '↘ ' : '↗ '}{who}</strong>
          {!inbound && message.kind && (
            <span className="muted"> · {KIND_LABELS[message.kind] ?? message.kind}</span>
          )}
          {inbound && message.intentLabel && <span className="muted"> · {message.intentLabel}</span>}
          {inbound && message.routeLabel && <span className="muted"> · {message.routeLabel}</span>}
        </div>
        <span className="muted" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
          {formatDateTime(message.createdAt)}
        </span>
      </div>
      <div style={{ fontSize: '0.8125rem', fontWeight: 600, marginTop: '0.2rem' }}>{message.subject}</div>
      {inbound && message.summary && (
        <div className="secondary" style={{ fontSize: '0.8125rem', fontStyle: 'italic' }}>{message.summary}</div>
      )}
      {open ? (
        <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.8125rem', marginTop: '0.35rem', overflowWrap: 'anywhere' }}>
          {message.body}
        </div>
      ) : null}
      {long && (
        <button type="button" className="btn-sm" onClick={() => setOpen(!open)} style={{ marginTop: '0.35rem', padding: '0.1rem 0.5rem' }}>
          {open ? 'Fold' : 'Show email'}
        </button>
      )}
      {actions && <div style={{ marginTop: '0.4rem' }}>{actions(message)}</div>}
    </div>
  );
}
