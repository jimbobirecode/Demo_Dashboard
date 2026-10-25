import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatDate, formatDateTime } from '../lib/format.js';

/**
 * One booking's lifecycle history, inside the drawer.
 *
 * This is the answer to "why did this guest get that email?" and, more often,
 * "why did nobody chase this one?" — so it shows the rungs that did *not*
 * send as well as the ones that did. A booking that paid on day six has a
 * row saying the day-seven warning was skipped, which is a far better answer
 * than an absence.
 *
 * Renders nothing at all until there is history. The ladder is off by default
 * and most clubs will never switch it on; an empty panel in every drawer
 * would be clutter they cannot act on.
 */
export default function BookingLifecycle({ bookingId }) {
  const [history, setHistory] = useState(null);

  useEffect(() => {
    let live = true;
    setHistory(null);
    api
      .bookingLifecycle(bookingId)
      // Swallowed on purpose: the ladder may be switched off, or this may be
      // an older install. Either way the drawer's other panels still work.
      .then((payload) => live && setHistory(payload.history ?? []))
      .catch(() => live && setHistory([]));
    return () => {
      live = false;
    };
  }, [bookingId]);

  if (!history?.length) return null;

  return (
    <>
      <div className="divider" />

      <div className="stack" style={{ gap: '0.5rem' }}>
        <span className="label">Lifecycle</span>

        <ul className="timeline">
          {history.map((entry) => (
            <li key={`${entry.rung}-${entry.at}`}>
              <span className="timeline-when">{entry.dueOn ? formatDate(entry.dueOn) : '—'}</span>
              <span>
                <span style={{ fontWeight: OUTCOMES[entry.outcome]?.strong ? 600 : 400 }}>{rungLabel(entry.rung)}</span>
                <span
                  className="tag"
                  style={{
                    marginLeft: '0.4rem',
                    color: OUTCOMES[entry.outcome]?.color,
                    borderColor: OUTCOMES[entry.outcome]?.color,
                  }}
                >
                  {OUTCOMES[entry.outcome]?.label ?? entry.outcome}
                </span>
                <div className="muted" style={{ fontSize: '0.75rem' }}>
                  {entry.detail ? `${entry.detail} · ` : ''}
                  {entry.emailTo ? `${entry.emailTo} · ` : ''}
                  {formatDateTime(entry.at)}
                </div>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/**
 * What each outcome means to somebody reading the drawer.
 *
 * `skipped` and `superseded` are the two worth spelling out: they are not
 * failures, they are the ladder deciding correctly, and a club that reads
 * them as errors will go looking for a fault that is not there.
 */
const OUTCOMES = {
  sent: { label: 'sent', color: 'var(--status-booked)', strong: true },
  held: { label: 'waiting on a decision', color: 'var(--status-rejected)', strong: true },
  failed: { label: 'failed — will retry', color: 'var(--status-rejected)', strong: true },
  skipped: { label: 'not needed', color: undefined, strong: false },
  superseded: { label: 'overtaken', color: undefined, strong: false },
};

/** The rung keys, in the words the club uses. */
const LABELS = {
  deposit_request: 'Deposit requested',
  deposit_reminder_1: 'Deposit reminder',
  deposit_reminder_2: 'Deposit reminder (24 hours before the deadline)',
  deposit_overdue: 'Deposit window closed — cancellation warning',
  deposit_rescue_48h: 'Final notice (48 hours)',
  deposit_rescue_24h: 'Final notice (24 hours)',
  deposit_cancelled: 'Cancelled — no deposit',
  deposit_receipt: 'Payment received — terms for the next stage',
  balance_notice: 'Balance due — polite reminder',
  balance_reminder_48h: 'Balance reminder (48 hours)',
  balance_reminder_24h: 'Balance reminder (24 hours)',
  balance_cancelled: 'Cancelled — balance unpaid',
  balance_receipt: 'Paid in full — booking details',
  confirmation: 'Confirmation',
  final_details: 'Final details',
  post_play: 'Post-play thank you',
};

function rungLabel(rung) {
  return LABELS[rung] ?? rung;
}
