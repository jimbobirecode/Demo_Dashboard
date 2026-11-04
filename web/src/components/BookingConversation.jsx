import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import ChatThread from './ChatThread.jsx';
import EmailComposer, { composerContext } from './EmailComposer.jsx';
import { correspondent } from '../lib/correspondent.js';

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
  const [state, setState] = useState({ loading: true, thread: [] });
  const [target, setTarget] = useState(null); // inbound message id, 'new', or null for the default
  const [notice, setNotice] = useState(null);
  const scroller = useRef(null);

  useEffect(() => {
    let live = true;
    setState({ loading: true, thread: [] });
    setTarget(null);
    setNotice(null);
    api
      .bookingThread(booking.bookingId)
      .then(
        (payload) =>
          live && setState({ loading: false, thread: payload.thread ?? [], recipient: payload.recipient ?? null }),
      )
      .catch((err) => live && setState({ loading: false, thread: [], error: err.message }));
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

  const thread = state.thread;
  const latestInbound = [...thread].reverse().find((message) => message.direction === 'inbound') ?? null;
  const replyingTo =
    target === 'new'
      ? null
      : (thread.find((message) => message.id === target) ?? (target === null ? latestInbound : null));
  // A reply goes back to whoever wrote; a fresh email goes to whoever the club
  // has been emailing about this booking, which is the operator's address on an
  // operator's booking and only then the lead guest's.
  const to = replyingTo?.fromEmail || latestInbound?.fromEmail || booking.guestEmail;
  // The server names the default recipient from the club's own records; a
  // reply to an earlier email falls back to the local rule for that address.
  const served = state.recipient && state.recipient.email === String(to).toLowerCase() ? state.recipient : null;
  const who =
    served ?? correspondent({ email: to, leadGuestEmail: booking.guestEmail, leadGuestName: booking.guestName });
  const context = composerContext(booking, who);

  function sent(result) {
    setState({ loading: false, thread: result.thread });
    setNotice({ kind: 'success', text: result.notice ?? result.message });
    setTarget(null);
  }

  return (
    <div className="card stack" style={{ background: 'var(--surface-0)', gap: '0.75rem' }}>
      <div className="between">
        <div>
          <div className="label">Emails with {who.label || 'the guest'}</div>
          {context.leadName && (
            <div className="muted" style={{ fontSize: '0.75rem' }}>
              Lead guest: {context.leadName} — named on the booking, not the address above
            </div>
          )}
        </div>
        {thread.length > 0 && (
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            {thread.length} email{thread.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {notice && (
        <div className={`banner ${notice.kind}`} role="status">
          {notice.text}
        </div>
      )}
      {state.error && <div className="banner error">{state.error}</div>}

      {state.loading ? (
        <div className="muted" style={{ fontSize: '0.8125rem' }}>
          Loading…
        </div>
      ) : thread.length ? (
        <div ref={scroller} style={{ maxHeight: '30rem', overflowY: 'auto', paddingRight: '0.25rem' }}>
          <ChatThread
            thread={thread}
            guestName={booking.guestName}
            leadGuestEmail={booking.guestEmail}
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

      {!state.loading &&
        (to ? (
          <div className="stack" style={{ gap: '0.4rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
            <EmailComposer
              title={
                who.name ? `${replyingTo ? 'Reply' : 'New email'} to ${who.name}` : replyingTo ? 'Reply' : 'New email'
              }
              key={replyingTo ? `reply-${replyingTo.id}` : 'new'}
              to={to}
              recipient={who}
              about={
                booking.guestName && booking.guestName !== who.name
                  ? `About booking ${booking.bookingId} — the round is for ${booking.guestName}, who is not who this email goes to.`
                  : null
              }
              subject={replyingTo ? `Re: ${(replyingTo.subject || '').replace(/^re:\s*/i, '')}` : ''}
              editableSubject={!replyingTo}
              subjectPlaceholder={`Your booking ${booking.bookingId}`}
              draftKey={
                replyingTo ? `booking-${booking.bookingId}-reply-${replyingTo.id}` : `booking-${booking.bookingId}-new`
              }
              context={context}
              replyToId={replyingTo?.id ?? null}
              sendLabel={replyingTo ? 'Send reply' : 'Send email'}
              send={(body, subject) =>
                replyingTo ? api.inboxReply(replyingTo.id, body) : api.emailGuest(booking.bookingId, body, subject, to)
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
          <div className="muted" style={{ fontSize: '0.8125rem' }}>
            There is no email address on this booking to write to.
          </div>
        ))}
    </div>
  );
}
