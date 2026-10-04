import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { BRAND } from '../lib/brand.js';
import { formatCurrency, formatDate } from '../lib/format.js';

/** How long a sent email can still be taken back. */
const UNDO_SECONDS = 5;

const DRAFT_PREFIX = 'teemail-draft:';

function readDraft(key) {
  if (!key) return null;
  try {
    return window.localStorage.getItem(DRAFT_PREFIX + key);
  } catch {
    return null;
  }
}

function writeDraft(key, value) {
  if (!key) return;
  try {
    if (value && value.trim()) window.localStorage.setItem(DRAFT_PREFIX + key, value);
    else window.localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    // Private windows can refuse storage; the draft just is not kept.
  }
}

/**
 * Replies staff send again and again, filled in from the booking so they only
 * need checking, not typing. Anything the booking does not know is left as a
 * visible gap rather than guessed.
 */
function quickReplies(context) {
  const hi = context.firstName ? `Hi ${context.firstName},` : 'Hello,';
  const signOff = `Kind regards,\n${BRAND.fullName}`;
  const when = [context.date, context.teeTime && `at ${context.teeTime}`].filter(Boolean).join(' ');
  const party = context.players ? `${context.players} player${context.players === 1 ? '' : 's'}` : '';
  const summary = [when, party].filter(Boolean).join(', ');
  const ref = context.bookingId ? `\nBooking reference: ${context.bookingId}` : '';

  return [
    {
      id: 'confirm',
      label: 'Confirm the booking',
      body: `${hi}\n\nGood news - your tee time is confirmed${summary ? `:\n\n${summary}` : '.'}${ref}\n\nWe will send payment details separately. We look forward to welcoming you.\n\n${signOff}`,
    },
    {
      id: 'alternatives',
      label: 'Not available - offer alternatives',
      body: `${hi}\n\nThank you for your enquiry. Unfortunately ${when ? `${when} is` : 'that time is'} no longer available, but we could offer:\n\n- \n- \n\nLet us know which suits and we will hold it for you.\n\n${signOff}`,
    },
    {
      id: 'details',
      label: 'Ask for the players’ details',
      body: `${hi}\n\nThank you for your booking${context.bookingId ? ` (${context.bookingId})` : ''}. To complete it, could you send us:\n\n- the name and handicap of each player\n- a contact mobile number for the day\n- whether you would like caddies, trolleys or buggies\n\n${signOff}`,
    },
    {
      id: 'payment',
      label: 'Payment reminder',
      body: `${hi}\n\nA quick reminder that ${context.total ? `the balance of ${context.total}` : 'payment'} for your booking${context.bookingId ? ` ${context.bookingId}` : ''} is now due. You can pay securely using the payment link in our earlier email - just reply if you need it sent again.\n\n${signOff}`,
    },
    {
      id: 'change',
      label: 'Change made',
      body: `${hi}\n\nThat is all updated for you${summary ? ` - your booking is now ${summary}` : ''}.${ref}\n\nIf anything else changes, just reply to this email.\n\n${signOff}`,
    },
    {
      id: 'cancel',
      label: 'Cancellation confirmed',
      body: `${hi}\n\nWe have cancelled your booking${context.bookingId ? ` ${context.bookingId}` : ''} as requested. We are sorry you cannot make it, and we hope to see you another time.\n\n${signOff}`,
    },
  ];
}

/** What a quick reply can fill in, from whichever booking shape the page has. */
export function composerContext(booking, fallbackName = '') {
  const name = booking?.guestName || fallbackName || '';
  return {
    firstName: name.trim().split(/\s+/)[0] || '',
    bookingId: booking?.bookingId ?? '',
    date: booking?.date ? formatDate(booking.date) : '',
    teeTime: booking?.teeTime && booking.teeTime !== 'Not Specified' ? booking.teeTime : '',
    players: Number(booking?.players) || 0,
    total: Number(booking?.total) ? formatCurrency(booking.total) : '',
  };
}

/**
 * Writing an email to a guest, the same way everywhere in the dashboard.
 *
 * - Quick replies start the email from the booking's own details.
 * - The draft is kept (per conversation) until it is sent, so clicking away
 *   loses nothing.
 * - Preview shows the branded email exactly as the guest will get it.
 * - Send is one click (or Ctrl/Cmd+Enter), with a few seconds to undo it -
 *   no "are you sure?" dialog on every email.
 */
export default function EmailComposer({
  title = null,
  to,
  subject = '',
  editableSubject = false,
  subjectPlaceholder = '',
  initialBody = '',
  draftKey = null,
  context = {},
  replyToId = null,
  note = null,
  sendLabel = 'Send',
  send,
  onSent,
  onCancel = null,
  disabled = false,
}) {
  const [body, setBody] = useState(() => readDraft(draftKey) ?? initialBody ?? '');
  const [subjectText, setSubjectText] = useState('');
  const [fromDraft] = useState(() => Boolean(readDraft(draftKey)));
  const [pending, setPending] = useState(null); // seconds left before it goes
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null); // { html } | { loading } | null
  const [replaced, setReplaced] = useState(null); // the person's own text a quick reply replaced, to put back
  const [template, setTemplate] = useState(null); // { id, text } of the quick reply in the box
  const timer = useRef(null);
  const latest = useRef({});
  latest.current = { body, subjectText, send, onSent };

  // Keep the draft as it is typed.
  useEffect(() => {
    writeDraft(draftKey, body === initialBody ? '' : body);
  }, [body, draftKey, initialBody]);

  // A countdown still running when the composer closes is sent, not lost.
  useEffect(
    () => () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
        deliver();
      }
    },
    // Unmount only; deliver() reads the latest values through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function deliver() {
    setBusy(true);
    setError(null);
    try {
      const result = await latest.current.send(latest.current.body, latest.current.subjectText);
      writeDraft(draftKey, '');
      setBusy(false);
      setPending(null);
      latest.current.onSent?.(result);
    } catch (err) {
      setError(err.message);
      setBusy(false);
      setPending(null);
    }
  }

  function startSend() {
    if (!body.trim() || busy || pending !== null || disabled) return;
    setError(null);
    setPending(UNDO_SECONDS);
    let left = UNDO_SECONDS;
    timer.current = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer.current);
        timer.current = null;
        deliver();
      } else {
        setPending(left);
      }
    }, 1000);
  }

  function undo() {
    clearInterval(timer.current);
    timer.current = null;
    setPending(null);
  }

  function sendNow() {
    clearInterval(timer.current);
    timer.current = null;
    deliver();
  }

  // Choosing a ready-made reply swaps it in for whatever is in the box -
  // switching from one to another replaces it, never stacks them. Text the
  // person wrote or changed themselves is kept aside so it can be put back.
  const edited = Boolean(template) && body !== template.text;

  function applyQuickReply(id) {
    const reply = quickReplies(context).find((entry) => entry.id === id);
    if (!reply) return;
    if (template?.id === id && !edited) return;
    const untouchedTemplate = template && !edited;
    if (body.trim() && !untouchedTemplate) setReplaced(body);
    setBody(reply.body);
    setTemplate({ id, text: reply.body });
    setPreview(null);
  }

  function clearBox() {
    if (body.trim() && (!template || edited)) setReplaced(body);
    setBody('');
    setTemplate(null);
    setPreview(null);
  }

  async function togglePreview() {
    if (preview) return setPreview(null);
    setPreview({ loading: true });
    try {
      const result = await api.emailPreview(body, replyToId);
      setPreview({ html: result.html });
    } catch (err) {
      setPreview(null);
      setError(err.message);
    }
  }

  const locked = busy || pending !== null || disabled;

  return (
    <div className="stack composer" style={{ gap: '0.5rem' }}>
      {title && <div className="composer-title">{title}</div>}
      <div className="muted" style={{ fontSize: '0.8125rem', marginTop: title ? '-0.35rem' : 0 }}>
        To <strong className="secondary">{to}</strong>
        {!editableSubject && subject ? <> · {subject}</> : null}
      </div>

      {!preview && (
        <div className="quick-replies" aria-label="Start from a ready-made reply">
          <span className="muted" style={{ fontSize: '0.8125rem' }}>
            Start with:
          </span>
          {quickReplies(context).map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="chip"
              aria-pressed={template?.id === entry.id}
              disabled={locked}
              onClick={() => applyQuickReply(entry.id)}
              title={template && template.id !== entry.id ? `Replace the text with “${entry.label}”` : undefined}
            >
              {entry.label}
              {template?.id === entry.id && edited ? ' (edited)' : ''}
            </button>
          ))}
          {body.trim() && (
            <button type="button" className="link-button" disabled={locked} onClick={clearBox}>
              Clear
            </button>
          )}
          {replaced && (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setBody(replaced);
                setReplaced(null);
                setTemplate(null);
              }}
            >
              Put back what I had written
            </button>
          )}
        </div>
      )}

      {editableSubject && (
        <input
          aria-label="Subject"
          placeholder={subjectPlaceholder ? `Subject - ${subjectPlaceholder}` : 'Subject'}
          value={subjectText}
          onChange={(event) => setSubjectText(event.target.value)}
          disabled={locked}
        />
      )}

      {preview ? (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
            background: '#fff',
          }}
        >
          {preview.loading ? (
            <div className="muted" style={{ padding: '1rem', color: '#555' }}>
              Building the preview…
            </div>
          ) : (
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={preview.html}
              style={{ width: '100%', height: '32rem', border: 0, display: 'block' }}
            />
          )}
        </div>
      ) : (
        <textarea
          rows={9}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              startSend();
            }
          }}
          disabled={locked}
          placeholder="Type your email here, or pick one of the ready-made replies above."
          aria-label={`Email to ${to}`}
        />
      )}

      {error && <div className="banner error">{error}</div>}

      {pending !== null ? (
        <div className="banner success between" role="status" style={{ margin: 0 }}>
          <span>
            Sending to {to} in {pending}s…
          </span>
          <span className="row" style={{ gap: '0.5rem' }}>
            <button type="button" className="btn-sm" onClick={undo}>
              Undo
            </button>
            <button type="button" className="btn-sm btn-primary" onClick={sendNow}>
              Send now
            </button>
          </span>
        </div>
      ) : (
        <div className="between" style={{ gap: '0.5rem' }}>
          <div className="row" style={{ gap: '0.5rem' }}>
            <button type="button" className="btn-primary" onClick={startSend} disabled={locked || !body.trim()}>
              {busy ? 'Sending…' : sendLabel}
            </button>
            <button type="button" onClick={togglePreview} disabled={busy || (!preview && !body.trim())}>
              {preview ? 'Edit' : 'Preview'}
            </button>
            {onCancel && (
              <button type="button" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
            )}
            {note}
          </div>
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            {fromDraft && body.trim() ? 'Your saved draft · ' : ''}Ctrl/⌘ + Enter to send
          </span>
        </div>
      )}
    </div>
  );
}
