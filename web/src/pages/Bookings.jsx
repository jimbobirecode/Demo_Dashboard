import { useMemo, useState } from 'react';
import { api, exportUrl } from '../lib/api.js';
import { useBookings } from '../lib/useBookings.js';
import { DEFAULT_PRESET, resolvePreset, withinRange } from '../lib/dateRanges.js';
import { ALL_STATUSES, DEFAULT_STATUS_FILTER, normaliseStatus, statusColor } from '../lib/status.js';
import { formatCurrency, formatNumber } from '../lib/format.js';
import FilterBar from '../components/FilterBar.jsx';
import BookingsTable from '../components/BookingsTable.jsx';
import BookingDrawer from '../components/BookingDrawer.jsx';
import KpiTile from '../components/KpiTile.jsx';

export default function Bookings({ user }) {
  const { bookings, operators, error, loading, lastUpdated, refresh, replaceBooking, removeBooking } =
    useBookings();

  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [statuses, setStatuses] = useState(DEFAULT_STATUS_FILTER);
  const [selectedId, setSelectedId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState(null);

  const range = useMemo(() => resolvePreset(preset, custom), [preset, custom]);

  const dateFiltered = useMemo(
    () => bookings.filter((booking) => withinRange(booking.date, range)),
    [bookings, range],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return dateFiltered.filter((booking) => {
      if (statuses.length && !statuses.includes(normaliseStatus(booking.status))) return false;
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
  }, [dateFiltered, statuses, search]);

  const selected = filtered.find((booking) => booking.bookingId === selectedId) ?? null;

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

  const pipelineValue = useMemo(
    () =>
      dateFiltered
        .filter((booking) => booking.status === 'Booked')
        .reduce((total, booking) => total + booking.total, 0),
    [dateFiltered],
  );

  function toggleStatusOnly(stage) {
    setStatuses((current) =>
      current.length === 1 && current[0] === stage ? DEFAULT_STATUS_FILTER : [stage],
    );
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
      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}

      {/* Six tiles: narrower than the default so they share one row. */}
      <div className="kpi-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        {ALL_STATUSES.map((stage) => (
          <KpiTile
            key={stage}
            label={stage}
            value={formatNumber(stageCounts[stage])}
            sub="Click to filter"
            accent={statusColor(stage)}
            pressed={statuses.length === 1 && statuses[0] === stage}
            onClick={() => toggleStatusOnly(stage)}
          />
        ))}
        <KpiTile
          label="Booked value"
          value={formatCurrency(pipelineValue)}
          sub="Booked only"
          accent="var(--brand-gold)"
        />
      </div>

      <FilterBar
        search={search}
        onSearch={setSearch}
        preset={preset}
        onPreset={setPreset}
        custom={custom}
        onCustom={setCustom}
        onReset={() => {
          setSearch('');
          setPreset(DEFAULT_PRESET);
          setCustom({ from: '', to: '' });
          setStatuses(DEFAULT_STATUS_FILTER);
        }}
      />

      <BookingsTable
        bookings={filtered}
        selectedId={selectedId}
        onSelect={(booking) => setSelectedId(booking.bookingId)}
        onAdvance={advance}
        busyId={busyId}
      />

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
          onTeeTimeSave={(booking, teeTime) =>
            mutate(async () => {
              const { booking: updated } = await api.setTeeTime(booking.bookingId, teeTime);
              replaceBooking(updated);
            })
          }
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
          onDelete={user?.role === 'admin' ? (booking) =>
            mutate(async () => {
              await api.remove(booking.bookingId);
              removeBooking(booking.bookingId);
              setSelectedId(null);
            }) : undefined}
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
