import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, exportUrl } from '../lib/api.js';
import { useBookings } from '../lib/useBookings.js';
import { DEFAULT_PRESET, resolvePreset, withinRange } from '../lib/dateRanges.js';
import { ALL_STATUSES, DEFAULT_STATUS_FILTER, TERMINAL_STATUSES, normaliseStatus, statusColor } from '../lib/status.js';
import { formatCurrency, formatNumber } from '../lib/format.js';
import { OVERDUE } from '../lib/palette.js';
import { awaitingPayment, matchesPaymentView } from '../lib/payments.js';
import FilterBar from '../components/FilterBar.jsx';
import BookingsTable from '../components/BookingsTable.jsx';
import BookingDrawer from '../components/BookingDrawer.jsx';
import BookingFlow from '../components/BookingFlow.jsx';
import NewBookingForm from '../components/NewBookingForm.jsx';

export default function Bookings({ user }) {
  const { bookings, operators, error, loading, lastUpdated, refresh, replaceBooking, addBooking, removeBooking } =
    useBookings();

  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [statuses, setStatuses] = useState(DEFAULT_STATUS_FILTER);
  // The money view: booked rounds the club is still owed for. Separate from
  // the status tiles because it is not a status — it is a status and a
  // balance, and the two move independently.
  const [pendingOnly, setPendingOnly] = useState(false);
  const [paymentView, setPaymentView] = useState('');
  // ?booking=REF opens that booking's drawer: how a tour operator's statement
  // hands over to the booking itself.
  const [params] = useSearchParams();
  const [selectedId, setSelectedId] = useState(() => params.get('booking'));
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [adding, setAdding] = useState(false);
  // Bookings a payment booked that are not yet on the club's tee sheet.
  const [teeSheetOnly, setTeeSheetOnly] = useState(false);

  const range = useMemo(() => resolvePreset(preset, custom), [preset, custom]);

  const dateFiltered = useMemo(() => bookings.filter((booking) => withinRange(booking.date, range)), [bookings, range]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return dateFiltered.filter((booking) => {
      if (statuses.length && !statuses.includes(normaliseStatus(booking.status))) return false;
      if (pendingOnly && !awaitingPayment(booking)) return false;
      if (pendingOnly && !matchesPaymentView(booking, paymentView)) return false;
      if (teeSheetOnly && booking.teeSheetStatus !== 'to_enter') return false;
      if (!needle) return true;
      return [
        booking.bookingId,
        booking.guestEmail,
        booking.guestName,
        booking.contactPhone,
        booking.golfCourses,
        booking.teeTime,
        booking.operatorName,
      ]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    });
  }, [dateFiltered, statuses, search, pendingOnly, paymentView, teeSheetOnly]);

  // From every booking, not just the filtered ones: a booking just taken for
  // next summer, or one whose date was just moved out of the range on screen,
  // must not vanish from under the person working on it.
  const selected = bookings.find((booking) => booking.bookingId === selectedId) ?? null;

  // Counted across every booking, not the dates on screen: a round paid for
  // next summer has to go on the sheet today.
  const toTeeSheet = useMemo(() => bookings.filter((booking) => booking.teeSheetStatus === 'to_enter'), [bookings]);

  // Tiles count the date-filtered set so the numbers stay stable while a
  // status tile is toggled on and off. They are the only status filter.
  const stageCounts = useMemo(() => {
    const counts = Object.fromEntries(ALL_STATUSES.map((stage) => [stage, 0]));
    for (const booking of dateFiltered) {
      const stage = normaliseStatus(booking.status);
      if (stage in counts) counts[stage] += 1;
    }
    return counts;
  }, [dateFiltered]);

  // Booked and still owed for. Counted off the date-filtered set like the
  // status tiles, so the number does not move when it is pressed.
  const pending = useMemo(() => dateFiltered.filter(awaitingPayment), [dateFiltered]);
  const pendingValue = useMemo(
    () => pending.reduce((total, booking) => total + (booking.payment?.outstanding ?? 0), 0),
    [pending],
  );

  function toggleStatusOnly(stage) {
    setPendingOnly(false);
    setPaymentView('');
    setStatuses((current) => (current.length === 1 && current[0] === stage ? DEFAULT_STATUS_FILTER : [stage]));
  }

  /** The money view is Booked plus a balance, so it sets the status too. */
  function togglePendingPayment() {
    setPendingOnly((current) => {
      const next = !current;
      setStatuses(next ? ['Booked'] : DEFAULT_STATUS_FILTER);
      if (!next) setPaymentView('');
      return next;
    });
  }

  async function mutate(action) {
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
      throw err;
    }
  }

  async function advance(booking, stage) {
    setBusyId(booking.bookingId);
    try {
      await mutate(async () => {
        const { booking: updated } = await api.setStatus(booking.bookingId, stage);
        replaceBooking(updated);
      });
    } catch {
      /* surfaced via notice */
    } finally {
      setBusyId(null);
    }
  }

  async function runFixTeeTimes() {
    await mutate(async () => {
      const { updated, notFound } = await api.fixTeeTimes();
      setNotice({
        kind: updated ? 'success' : 'error',
        text: updated
          ? `Extracted tee times for ${updated} booking(s).`
          : `No tee times could be extracted (${notFound} checked).`,
      });
      await refresh({ silent: true });
    }).catch(() => {});
  }

  const exportParams = { statuses, from: range.from, to: range.to };

  return (
    <div className="stack">
      <div className="between">
        <div>
          <h1>Booking Requests</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            {formatNumber(filtered.length)} of {formatNumber(bookings.length)} bookings
            {lastUpdated && ` · updated ${lastUpdated.toLocaleTimeString('en-GB')}`}
          </p>
        </div>
        <div className="row">
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            Add booking
          </button>
          <a className="btn-sm" href={exportUrl('csv', exportParams)} style={linkButton}>
            Export CSV
          </a>
          <a className="btn-sm" href={exportUrl('xlsx', exportParams)} style={linkButton}>
            Export Excel
          </a>
          <button type="button" onClick={runFixTeeTimes}>
            Fix tee times
          </button>
          <button type="button" onClick={() => refresh()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {(toTeeSheet.length > 0 || teeSheetOnly) && (
        <div className="card tee-sheet-card between" role="status">
          <div>
            <div style={{ fontWeight: 700 }}>
              {toTeeSheet.length
                ? `${formatNumber(toTeeSheet.length)} paid online — to put on the tee sheet`
                : 'Everything paid online is on the tee sheet'}
            </div>
            <div className="secondary" style={{ fontSize: '0.8125rem' }}>
              Booked by the guest paying on the booking form. Open each, put it on the sheet, and mark it done.
            </div>
          </div>
          <button
            type="button"
            className={teeSheetOnly ? undefined : 'btn-primary'}
            onClick={() => {
              const next = !teeSheetOnly;
              setTeeSheetOnly(next);
              if (next) {
                // Every date and status, so none of them is hidden by the
                // filters already on screen.
                setPendingOnly(false);
                setPaymentView('');
                setStatuses([]);
                setPreset('all');
                setSearch('');
              } else {
                setStatuses(DEFAULT_STATUS_FILTER);
                setPreset(DEFAULT_PRESET);
              }
            }}
          >
            {teeSheetOnly ? 'Show all bookings' : 'Show them'}
          </button>
        </div>
      )}
      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}

      {/* The stages a booking moves through, in order. Rejected and Cancelled
          are not stages anybody passes through on the way to playing golf, so
          they are a line of text under the flow rather than two more boxes of
          equal weight. What the booked rounds are worth is a figure for the
          Analytics page ("Booked value"), not for the list somebody works
          from. */}
      <BookingFlow
        stages={[
          {
            id: 'Inquiry',
            label: 'Inquiry',
            value: formatNumber(stageCounts.Inquiry),
            sub: 'Asked, not yet answered',
            accent: statusColor('Inquiry'),
            pressed: !pendingOnly && statuses.length === 1 && statuses[0] === 'Inquiry',
            onClick: () => toggleStatusOnly('Inquiry'),
          },
          {
            id: 'Requested',
            label: 'Requested',
            value: formatNumber(stageCounts.Requested),
            sub: 'Times offered, awaiting the guest',
            accent: statusColor('Requested'),
            pressed: !pendingOnly && statuses.length === 1 && statuses[0] === 'Requested',
            onClick: () => toggleStatusOnly('Requested'),
          },
          {
            id: 'pending-payment',
            label: 'Booked · pending payment',
            value: formatNumber(pending.length),
            sub: `${formatCurrency(pendingValue)} owed`,
            accent: OVERDUE,
            pressed: pendingOnly,
            onClick: togglePendingPayment,
          },
          {
            id: 'Booked',
            label: 'Booked',
            value: formatNumber(stageCounts.Booked),
            sub: pending.length ? `Including ${formatNumber(pending.length)} not yet paid` : 'All paid up',
            accent: statusColor('Booked'),
            pressed: !pendingOnly && statuses.length === 1 && statuses[0] === 'Booked',
            onClick: () => toggleStatusOnly('Booked'),
          },
        ]}
        aside={
          <div className="muted" style={{ fontSize: '0.8125rem' }}>
            {TERMINAL_STATUSES.map((stage, index) => (
              <span key={stage}>
                {index > 0 && ' · '}
                <button
                  type="button"
                  className="link-button"
                  aria-pressed={!pendingOnly && statuses.length === 1 && statuses[0] === stage}
                  onClick={() => toggleStatusOnly(stage)}
                >
                  {formatNumber(stageCounts[stage])} {stage.toLowerCase()}
                </button>
              </span>
            ))}
            {' — not stages, and left out of the flow above.'}
          </div>
        }
      />

      <FilterBar
        search={search}
        onSearch={setSearch}
        preset={preset}
        onPreset={setPreset}
        custom={custom}
        onCustom={setCustom}
        paymentView={pendingOnly ? paymentView : null}
        onPaymentView={setPaymentView}
        onReset={() => {
          setSearch('');
          setPreset(DEFAULT_PRESET);
          setCustom({ from: '', to: '' });
          setStatuses(DEFAULT_STATUS_FILTER);
          setPendingOnly(false);
          setPaymentView('');
        }}
      />

      <BookingsTable
        bookings={filtered}
        showTrade={pendingOnly || undefined}
        selectedId={selectedId}
        onSelect={(booking) => setSelectedId(booking.bookingId)}
        onAdvance={advance}
        busyId={busyId}
      />

      {adding && (
        <NewBookingForm
          operators={operators}
          onClose={() => setAdding(false)}
          onCreate={async (draft) => {
            const { booking } = await api.createBooking(draft);
            addBooking(booking);
            setAdding(false);
            // Straight to the booking, where a payment can be taken or a link
            // sent while the guest is still on the phone.
            setSelectedId(booking.bookingId);
            setNotice({
              kind: 'success',
              text: `${booking.bookingId} added. Take a payment or send a link from Payment below.`,
            });
          }}
        />
      )}

      {selected && (
        <BookingDrawer
          booking={selected}
          operators={operators}
          onClose={() => setSelectedId(null)}
          onStatusChange={(booking, status) =>
            mutate(async () => {
              const { booking: updated } = await api.setStatus(booking.bookingId, status);
              replaceBooking(updated);
            })
          }
          onNoteSave={(booking, note) =>
            mutate(async () => {
              const { booking: updated } = await api.setNote(booking.bookingId, note);
              replaceBooking(updated);
            })
          }
          onTeeSheet={(booking, entered) =>
            mutate(async () => {
              const { booking: updated } = await api.setTeeSheet(booking.bookingId, entered);
              replaceBooking(updated);
            })
          }
          onDetailsSave={async (booking, patch) => {
            const result = await api.updateBooking(booking.bookingId, patch);
            replaceBooking(result.booking);
            return result;
          }}
          onPaymentSave={(booking, patch) =>
            mutate(async () => {
              const { booking: updated } = await api.setPayment(booking.bookingId, patch);
              replaceBooking(updated);
            })
          }
          onSendPaymentLink={async (booking, amount) => {
            const { booking: updated, message } = await api.sendPaymentLink(booking.bookingId, amount);
            replaceBooking(updated);
            return message;
          }}
          onCheckPayment={async (booking) => {
            const result = await api.checkPayment(booking.bookingId);
            if (result.found) replaceBooking(result.booking);
            return result;
          }}
          onSendReceipt={async (booking) => {
            const { booking: updated, message } = await api.sendReceipt(booking.bookingId);
            replaceBooking(updated);
            return message;
          }}
          onAssignOperator={(booking, operatorId) =>
            mutate(async () => {
              await api.assignOperator([booking.bookingId], operatorId);
              // The account decides the due dates, so the whole row is re-read
              // rather than patched — the payment state has changed with it.
              await refresh({ silent: true });
            })
          }
          onDelete={
            user?.role === 'admin'
              ? (booking) =>
                  mutate(async () => {
                    await api.remove(booking.bookingId);
                    removeBooking(booking.bookingId);
                    setSelectedId(null);
                  })
              : undefined
          }
        />
      )}
    </div>
  );
}

const linkButton = {
  display: 'inline-block',
  textDecoration: 'none',
  color: 'var(--text-primary)',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '0.5rem 0.85rem',
};
