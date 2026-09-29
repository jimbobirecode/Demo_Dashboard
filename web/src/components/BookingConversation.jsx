import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import ChatThread from './ChatThread.jsx';
import EmailComposer, { composerContext } from './EmailComposer.jsx';

/**
 * The booking's emails, and one place to write the next one.
 *
 * The whole conversation reads top to bottom, oldest first, with long emails
 * folded. Underneath is a single composer: it answers the guest's latest email
 * (quoted, and filed on the same thread), or - when the guest has never
 * written, or staff choose to - starts a fresh email to them. "Reply to this"
 * on any earlier email points the composer at that one instead.
 */
export default function BookingConversation({ booking }) {
  const [state, setState] = useState({ loading: true, available: true, thread: [] });
  const [target, setTarget] = useState(null); // inbound message id, 'new', or null for the default
  const [notice, setNotice] = useState(null);
  const scroller = useRef(null);

  useEffect(() => {
    let live = true;
    setState({ loading: true, available: true, thread: [] });
    setTarget(null);
    setNotice(null);
    api
      .bookingThread(booking.bookingId)
      .then((payload) => live && setState({ loading: false, available: payload.available, thread: payload.thread ?? [] }))
      .catch((err) => live && setState({ loading: false, available: true, thread: [], error: err.message }));
    return () => {
      live = false;
    };
  }, [booking.bookingId]);

  // Open on the latest email, as a mail app does: that is what gets answered,
  // and after sending it is the email just sent.
  useEffect(() => {
    const box = scroller.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [state.loading, state.thread.length]);

  if (!state.available) return null;

  const thread = state.thread;
  const latestInbound = [...thread].reverse().find((message) => message.direction === 'inbound') ?? null;
  const replyingTo =
    target === 'new' ? null : thread.find((message) => message.id === target) ?? (target === null ? latestInbound : null);
  const to = replyingTo?.fromEmail || booking.guestEmail;
  const context = composerContext(booking);
  const firstName = context.firstName;

  function sent(result) {
    setState({ loading: false, available: true, thread: result.thread });
    setNotice({ kind: 'success', text: result.notice ?? result.message });
    setTarget(null);
  }

  return (
    <div className="card stack" style={{ background: 'var(--surface-0)', gap: '0.75rem' }}>
      <div className="between">
        <div className="label">Emails with {firstName || 'the guest'}</div>
        {thread.length > 0 && (
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            {thread.length} email{thread.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {notice && <div className={`banner ${notice.kind}`} role="status">{notice.text}</div>}
      {state.error && <div className="banner error">{state.error}</div>}

      {state.loading ? (
        <div className="muted" style={{ fontSize: '0.8125rem' }}>Loading…</div>
      ) : thread.length ? (
        <div ref={scroller} style={{ maxHeight: '30rem', overflowY: 'auto', paddingRight: '0.25rem' }}>
          <ChatThread
            thread={thread}
            guestName={booking.guestName}
            activeId={replyingTo?.id ?? null}
            onReplyTo={(message) => {
              setTarget(message.id);
              setNotice(null);
            }}
          />
        </div>
      ) : (
        <div className="muted" style={{ fontSize: '0.8125rem' }}>
          No emails recorded for this booking yet. Bookings made before the email log was switched on, through the
          booking form or from an uploaded tee sheet start with none.
        </div>
      )}

      {!state.loading && (to ? (
        <div className="stack" style={{ gap: '0.4rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
          <EmailComposer
            title={replyingTo ? `Reply to ${firstName || 'the guest'}` : `New email to ${firstName || 'the guest'}`}
            key={replyingTo ? `reply-${replyingTo.id}` : 'new'}
            to={to}
            subject={replyingTo ? `Re: ${(replyingTo.subject || '').replace(/^re:\s*/i, '')}` : ''}
            editableSubject={!replyingTo}
            subjectPlaceholder={`Your booking ${booking.bookingId}`}
            draftKey={replyingTo ? `booking-${booking.bookingId}-reply-${replyingTo.id}` : `booking-${booking.bookingId}-new`}
            context={context}
            replyToId={replyingTo?.id ?? null}
            sendLabel={replyingTo ? 'Send reply' : 'Send email'}
            send={(body, subject) =>
              replyingTo ? api.inboxReply(replyingTo.id, body) : api.emailGuest(booking.bookingId, body, subject)
            }
            onSent={sent}
          />
          {latestInbound && (
            <div style={{ fontSize: '0.8125rem' }}>
              {replyingTo ? (
                <button type="button" className="link-button" onClick={() => setTarget('new')}>
                  Start a new email instead of replying
                </button>
              ) : (
                <button type="button" className="link-button" onClick={() => setTarget(null)}>
                  Reply to their latest email instead
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: '0.8125rem' }}>There is no email address on this booking to write to.</div>
      ))}
    </div>
  );
}
