import { useState } from 'react';
import { formatDateTime } from '../lib/format.js';

/** What each email the club sends is, in words a person would use. */
const KIND_LABELS = {
  availability: 'Tee times sent',
  holding: '“We’ve got your message”',
  change_acknowledgement: 'Change request received',
  acknowledgement: 'Booking request received',
  payment_link: 'Payment link',
  receipt: 'Payment receipt',
  pre_arrival: 'Pre-arrival welcome',
  post_play: 'Thank-you after play',
  reply: 'Reply',
  automatic: 'Automatic email',
  membership_reply: 'Membership details',
  membership_closed: 'Applications closed – waitlist offered',
  membership_received: 'Application received',
  membership_waitlisted: 'Waitlist place confirmed',
  membership_under_review: 'Application under review',
  membership_approved: 'Membership approved',
  membership_declined: 'Membership declined',
  membership_welcome: 'Welcome to the club',
  membership_invite: 'Invitation to apply',
};

/** Who an email the club sent came from, as the reader thinks of it. */
/**
 * Who sent a club email. A person's username is shown as it is: the stamp has
 * to read the same for everybody, and "You (alice)" told bob he wrote it.
 */
function sender(message) {
  if (message.sentBy === 'bot') return 'Sent automatically';
  if (message.sentBy === 'Stripe') return 'Sent on payment';
  return message.sentBy || 'The club';
}

/**
 * A conversation laid out like a messaging app: the guest on the left under
 * their name, the club on the right, oldest at the top. Long emails start
 * folded to their first lines.
 *
 * `onReplyTo(message)` puts a "Reply to this" link on the guest's emails;
 * `activeId` marks the one being answered.
 */
export default function ChatThread({ thread, guestName = '', activeId = null, onReplyTo = null }) {
  if (!thread?.length) {
    return (
      <div className="muted" style={{ fontSize: '0.875rem' }}>
        No emails yet.
      </div>
    );
  }
  return (
    <div className="chat">
      {thread.map((message) => (
        <Bubble
          key={message.id}
          message={message}
          guestName={guestName}
          active={message.id === activeId}
          onReplyTo={onReplyTo}
        />
      ))}
    </div>
  );
}

function Bubble({ message, guestName, active, onReplyTo }) {
  const fromGuest = message.direction === 'inbound';
  // A staff reply carries the guest's email quoted underneath (for the guest's
  // benefit); here the guest's email is already in the conversation, so the
  // quote is left off.
  const body = String(message.body ?? '')
    .split(/\n+-{4,}\nOn [^\n]*wrote:\n/)[0]
    .trim();
  const long = body.length > 420 || body.split('\n').length > 10;
  const [open, setOpen] = useState(!long || active);
  const shown = open ? body : `${body.slice(0, 280).trimEnd()}…`;

  return (
    <div className={`chat-row ${fromGuest ? 'from-guest' : 'from-club'}`}>
      <div className={`chat-bubble${active ? ' active' : ''}`}>
        <div className="chat-meta">
          <strong>{fromGuest ? guestName || message.fromEmail : sender(message)}</strong>
          {!fromGuest && message.kind && message.kind !== 'reply' && (
            <span className="chat-tag">{KIND_LABELS[message.kind] ?? message.kind}</span>
          )}
          <span className="chat-time">{formatDateTime(message.createdAt)}</span>
        </div>
        {message.subject && <div className="chat-subject">{message.subject}</div>}
        <div className="chat-body">{shown}</div>
        <div className="chat-actions">
          {long && (
            <button type="button" className="link-button" onClick={() => setOpen(!open)}>
              {open ? 'Show less' : 'Show the full email'}
            </button>
          )}
          {fromGuest && onReplyTo && !active && (
            <button type="button" className="link-button" onClick={() => onReplyTo(message)}>
              Reply to this
            </button>
          )}
          {fromGuest && active && <span className="chat-replying">You are replying to this</span>}
        </div>
      </div>
    </div>
  );
}
