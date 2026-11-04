import { useEffect, useState } from 'react';
import PipelineProgress from './PipelineProgress.jsx';
import PaymentPanel from './PaymentPanel.jsx';
import BookingConversation from './BookingConversation.jsx';
import BookingDetailsForm from './BookingDetailsForm.jsx';
import StatusPill from './StatusPill.jsx';
import { ALL_STATUSES } from '../lib/status.js';
import { BRAND } from '../lib/brand.js';
import { formatCurrency, formatDate, formatDateTime } from '../lib/format.js';

export default function BookingDrawer({
  booking,
  operators = [],
  onClose,
  onStatusChange,
  onNoteSave,
  onDetailsSave,
  onTeeSheet,
  onPaymentSave,
  onSendPaymentLink,
  onSendReceipt,
  onCheckPayment,
  onAssignOperator,
  onDelete,
}) {
  const [note, setNote] = useState(booking.note);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  // Reset local edits whenever a different booking is opened.
  useEffect(() => {
    setNote(booking.note);
    setConfirmDelete(false);
    setMessage(null);
  }, [booking.bookingId, booking.note]);

  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function run(action, successMessage) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      if (successMessage) setMessage({ kind: 'success', text: successMessage });
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`Booking ${booking.bookingId}`}>
        <div className="between">
          <div>
            <div className="mono" style={{ fontSize: '1.125rem', fontWeight: 700 }}>
              {booking.bookingId}
            </div>
            <div className="secondary">{booking.guestEmail}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>

        {message && <div className={`banner ${message.kind}`}>{message.text}</div>}

        {/* Booked by a payment: nobody at the club has put it on the tee
            sheet, which the dashboard cannot write to. Top of the drawer,
            because it is the one thing still to do. */}
        {booking.teeSheetStatus === 'to_enter' && (
          <div className="card tee-sheet-card stack" style={{ gap: '0.5rem' }}>
            <div style={{ fontWeight: 700 }}>Paid online — put it on the tee sheet</div>
            <div className="secondary" style={{ fontSize: '0.8125rem' }}>
              {booking.guestName || booking.guestEmail} paid {formatCurrency(booking.amountPaid)}
              {booking.stripePaidAt ? ` on ${formatDateTime(booking.stripePaidAt)}` : ''}, which booked it. It is not on
              the club&apos;s tee sheet until somebody puts it there.
            </div>
            {onTeeSheet && (
              <div>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => run(() => onTeeSheet(booking, true), 'Marked as on the tee sheet')}
                >
                  Done — it&apos;s on the tee sheet
                </button>
              </div>
            )}
          </div>
        )}
        {booking.teeSheetStatus === 'entered' && (
          <div className="secondary row" style={{ fontSize: '0.8125rem', gap: '0.5rem' }}>
            <span>
              On the tee sheet
              {booking.teeSheetEnteredBy ? ` · marked by ${booking.teeSheetEnteredBy}` : ''}
              {booking.teeSheetEnteredAt ? `, ${formatDateTime(booking.teeSheetEnteredAt)}` : ''}
            </span>
            {onTeeSheet && (
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => run(() => onTeeSheet(booking, false), 'Flagged again for the tee sheet')}
              >
                Undo
              </button>
            )}
          </div>
        )}

        <PipelineProgress status={booking.status} />

        <div className="detail-grid">
          <Field label="Tee date" value={formatDate(booking.date)} />
          <Field label="Tee time" value={booking.teeTime} />
          <Field label="Players" value={booking.players} />
          <Field label="Total" value={formatCurrency(booking.total)} accent />
        </div>

        {onDetailsSave && <BookingDetailsForm booking={booking} onSave={(patch) => onDetailsSave(booking, patch)} />}

        <BookingConversation booking={booking} />

        {onPaymentSave && (
          <PaymentPanel
            booking={booking}
            operators={operators}
            onSave={onPaymentSave}
            onAssign={onAssignOperator}
            onSendLink={onSendPaymentLink}
            onSendReceipt={onSendReceipt}
            onCheckPayment={onCheckPayment}
          />
        )}

        {(booking.guestEmail ||
          booking.guestName ||
          booking.contactPhone ||
          booking.caddieRequirements ||
          booking.specialRequests) && (
          <div className="card" style={{ background: 'var(--surface-0)' }}>
            <div className="label">Who this booking is with</div>
            <div className="detail-grid" style={{ marginTop: '0.5rem' }}>
              {/* Two different people, so both are named for what they are.
                  "Lead guest" on its own was read as the person being emailed,
                  and at County Louth the address usually belongs to a tour
                  operator while the name is a guest in the party. */}
              {booking.guestEmail && <Field label="Email we reply to" value={booking.guestEmail} wide />}
              {booking.guestName && <Field label="Lead guest" value={booking.guestName} />}
              {booking.contactPhone && <Field label="Phone" value={booking.contactPhone} />}
              {booking.caddieRequirements && <Field label="Caddies" value={booking.caddieRequirements} />}
            </div>
            {booking.specialRequests && (
              <div style={{ marginTop: '0.75rem' }}>
                <div className="label">Special requests</div>
                <div style={{ marginTop: '0.25rem' }}>{booking.specialRequests}</div>
              </div>
            )}
            {booking.formSubmittedAt && (
              <div className="secondary" style={{ marginTop: '0.5rem', fontSize: '0.75rem' }}>
                Form submitted {formatDateTime(booking.formSubmittedAt)}
              </div>
            )}
          </div>
        )}

        {booking.golfCourses && (
          <div className="card" style={{ background: 'var(--surface-0)' }}>
            <div className="label">Golf courses &amp; tee times</div>
            <div style={{ marginTop: '0.4rem' }}>{booking.golfCourses}</div>
            <div className="secondary" style={{ marginTop: '0.25rem', fontSize: '0.8125rem' }}>
              {booking.selectedTeeTimes || 'Times not specified'}
            </div>
          </div>
        )}

        {(booking.hotelRequired || booking.lodgingNights) && (
          <div className="card" style={{ background: 'var(--surface-0)' }}>
            <div className="label">{BRAND.lodgingLabel}</div>
            <div className="detail-grid" style={{ marginTop: '0.5rem' }}>
              <Field label="Check-in" value={formatDate(booking.hotelCheckin)} />
              <Field label="Check-out" value={formatDate(booking.hotelCheckout)} />
              {booking.lodgingNights != null && <Field label="Nights" value={booking.lodgingNights} />}
              {booking.lodgingRooms != null && <Field label="Rooms" value={booking.lodgingRooms} />}
              {booking.lodgingRoomType && <Field label="Room type" value={booking.lodgingRoomType} />}
              {booking.lodgingCost != null && <Field label="Lodging" value={formatCurrency(booking.lodgingCost)} />}
              {booking.resortFeeTotal != null && (
                <Field label="Resort fee" value={formatCurrency(booking.resortFeeTotal)} />
              )}
            </div>
            {booking.lodgingPreferences && (
              <div style={{ marginTop: '0.75rem' }}>
                <div className="label">Preferences</div>
                <div style={{ marginTop: '0.25rem' }}>{booking.lodgingPreferences}</div>
              </div>
            )}
          </div>
        )}

        <div className="stack" style={{ gap: '0.4rem' }}>
          <span className="label">Status</span>
          <div className="row">
            <StatusPill status={booking.status} />
            <select
              value={booking.status === 'Pending' ? 'Inquiry' : booking.status}
              onChange={(event) => run(() => onStatusChange(booking, event.target.value), 'Status updated')}
              disabled={busy}
              aria-label="Change status"
            >
              {ALL_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="stack" style={{ gap: '0.4rem' }}>
          <span className="label">Notes / original enquiry</span>
          <textarea rows={12} value={note} onChange={(event) => setNote(event.target.value)} />
          <button
            type="button"
            className="btn-primary"
            disabled={busy || note === booking.note}
            onClick={() => run(() => onNoteSave(booking, note), 'Notes saved')}
          >
            Save notes
          </button>
        </div>

        <div className="secondary" style={{ fontSize: '0.75rem' }}>
          Requested {formatDateTime(booking.timestamp)}
          {booking.updatedBy && ` · last updated ${formatDateTime(booking.updatedAt)} by ${booking.updatedBy}`}
        </div>

        {/* Deleting is for administrators (the API refuses anyone else), so
            the danger zone is only drawn when there is a handler for it. */}
        {onDelete && (
          <>
            <div className="divider" />

            <div className="stack" style={{ gap: '0.5rem' }}>
              <span className="label" style={{ color: 'var(--status-rejected)' }}>
                Danger zone
              </span>
              {confirmDelete ? (
                <div className="row">
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={busy}
                    onClick={() => run(() => onDelete(booking))}
                  >
                    Yes, delete permanently
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button type="button" className="btn-danger" onClick={() => setConfirmDelete(true)}>
                  Delete booking
                </button>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

/**
 * One labelled value in a detail grid.
 *
 * `wide` gives it the whole row. An email address is one long unbreakable
 * token: in a 130px column it either paints over its neighbour or breaks
 * mid-domain, and neither is an address somebody can read back over the
 * phone.
 */
function Field({ label, value, accent, wide = false }) {
  return (
    <div style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <div className="label">{label}</div>
      <div
        style={{
          fontSize: accent ? '1.25rem' : '0.9375rem',
          fontWeight: accent ? 700 : 600,
          color: accent ? 'var(--brand-gold-bright)' : 'var(--text-primary)',
        }}
      >
        {value}
      </div>
    </div>
  );
}
