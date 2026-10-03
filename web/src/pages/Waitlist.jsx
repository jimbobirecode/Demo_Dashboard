import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatCurrency, formatDate, formatNumber } from '../lib/format.js';
import KpiTile from '../components/KpiTile.jsx';
import { PIPELINE_RAMP, STATUS_COLORS } from '../lib/palette.js';

/**
 * Parties waiting for a time the club could not give them, and what became of
 * them.
 *
 * Converting an entry writes the booking and the link together, which is what
 * makes the conversion figures at the top of this page answerable at all — the
 * previous path recorded the connection in a sentence inside the booking's
 * note, and nothing could report on that.
 */
export default function Waitlist() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showOpen, setShowOpen] = useState(true);

  async function load() {
    try {
      setData(await api.waitlist());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function act(fn, message) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (message) setNotice(message);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="empty">{error ?? 'Loading waitlist…'}</div>;

  const { conversion } = data;
  const entries = showOpen ? data.entries.filter((entry) => entry.open) : data.entries;

  return (
    <div className="stack">
      <header className="between">
        <div>
          <h1>Waitlist</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Parties waiting for a time, and how many of them end up playing
          </p>
        </div>
        <button type="button" className="btn-sm" onClick={() => setShowOpen(!showOpen)}>
          {showOpen ? 'Show all entries' : 'Show only open'}
        </button>
      </header>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner success">{notice}</div>}

      <div className="kpi-row">
        <KpiTile
          label="Still waiting"
          value={formatNumber(conversion.open)}
          sub={`${formatNumber(conversion.playersWaiting)} players`}
          accent={PIPELINE_RAMP[1]}
        />
        <KpiTile
          label="Converted"
          value={`${conversion.conversionRate}%`}
          sub={`${formatNumber(conversion.converted)} of ${formatNumber(conversion.settled)} that reached an ending`}
          accent={STATUS_COLORS.Booked}
        />
        <KpiTile
          label="Of every entry"
          value={`${conversion.conversionRateOfAll}%`}
          sub="Counting the ones still open"
          accent={PIPELINE_RAMP[2]}
        />
        <KpiTile
          label="Recovered"
          value={formatCurrency(conversion.revenue)}
          sub={
            conversion.unlinked
              ? `At least — ${formatNumber(conversion.unlinked)} conversion${conversion.unlinked === 1 ? '' : 's'} cannot be valued`
              : `${formatNumber(conversion.playersConverted)} players placed`
          }
          accent={STATUS_COLORS.Requested}
        />
        <KpiTile
          label="After a nudge"
          value={`${conversion.notifiedConversionRate}%`}
          sub={`${formatNumber(conversion.notified)} told about an opening`}
          accent={STATUS_COLORS.Inquiry}
        />
      </div>

      <AddEntry
        disabled={busy}
        onAdd={(entry) => act(() => api.addWaitlistEntry(entry), 'Added to the waitlist')}
      />

      {data.suggestions?.length > 0 && (
        <Suggestions
          rows={data.suggestions}
          busy={busy}
          onLink={(row) =>
            act(
              () => api.linkWaitlistEntry(row.waitlistId, row.bookingId),
              `${row.waitlistId} recorded as converting to ${row.bookingId}`,
            )
          }
        />
      )}

      {data.demand.length > 0 && <Demand rows={data.demand} />}

      <EntryTable
        entries={entries}
        busy={busy}
        onNotify={(entry) =>
          act(
            () => api.updateWaitlistEntry(entry.waitlistId, { notificationSent: true, status: 'Notified' }),
            `${entry.guestName || entry.guestEmail} marked as notified`,
          )
        }
        onCancel={(entry) =>
          act(() => api.updateWaitlistEntry(entry.waitlistId, { status: 'Cancelled' }),
            `${entry.waitlistId} cancelled`)
        }
        onConvert={(entry, booking) =>
          act(async () => {
            const result = await api.convertWaitlistEntry(entry.waitlistId, booking);
            setNotice(`Booked ${result.booking.bookingId} for ${entry.guestName || entry.guestEmail}`);
          })
        }
        onDelete={(entry) => act(() => api.deleteWaitlistEntry(entry.waitlistId), 'Entry removed')}
      />
    </div>
  );
}

function AddEntry({ onAdd, disabled }) {
  const blank = {
    guestName: '', guestEmail: '', requestedDate: '', preferredTime: '',
    players: 4, golfCourse: '', priority: 5, notes: '',
  };
  const [form, setForm] = useState(blank);
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  return (
    <form
      className="card stack"
      style={{ gap: '0.75rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        onAdd({ ...form, players: Number(form.players), priority: Number(form.priority) });
        setForm(blank);
      }}
    >
      <h3>Add to the waitlist</h3>
      <div className="toolbar">
        <label className="stack grow" style={{ gap: '0.35rem' }}>
          <span className="label">Name</span>
          <input value={form.guestName} onChange={set('guestName')} />
        </label>
        <label className="stack grow" style={{ gap: '0.35rem' }}>
          <span className="label">Email</span>
          <input type="email" value={form.guestEmail} onChange={set('guestEmail')} required />
        </label>
        <label className="stack" style={{ gap: '0.35rem' }}>
          <span className="label">Date wanted</span>
          <input type="date" value={form.requestedDate} onChange={set('requestedDate')} required style={{ width: 'auto' }} />
        </label>
        <label className="stack" style={{ gap: '0.35rem' }}>
          <span className="label">Players</span>
          <input type="number" min="1" max="40" value={form.players} onChange={set('players')} style={{ width: '5rem' }} />
        </label>
        <label className="stack" style={{ gap: '0.35rem' }}>
          <span className="label">Preferred</span>
          <select value={form.preferredTime} onChange={set('preferredTime')} style={{ width: 'auto' }}>
            <option value="">Any</option>
            <option value="Morning">Morning</option>
            <option value="Afternoon">Afternoon</option>
          </select>
        </label>
        <label className="stack" style={{ gap: '0.35rem' }}>
          <span className="label">Priority</span>
          <input type="number" min="1" max="10" value={form.priority} onChange={set('priority')} style={{ width: '5rem' }} />
        </label>
        <button type="submit" className="btn-primary" disabled={disabled}>Add</button>
      </div>
    </form>
  );
}

/**
 * Conversions that happened somewhere other than this page.
 *
 * A time found over the phone becomes a booking with nothing tying it back to
 * the list, so the conversion rate under-reports by exactly that much. These
 * are proposed, never applied: two people can share an inbox, and a guest can
 * wait for one date while booking another under their own steam. The evidence
 * is spelled out so whoever confirms is deciding rather than trusting.
 */
function Suggestions({ rows, busy, onLink }) {
  return (
    <div className="card stack" style={{ gap: '0.75rem' }}>
      <div>
        <h3>Possible conversions ({rows.length})</h3>
        <p className="muted" style={{ margin: '0.15rem 0 0', fontSize: '0.8125rem' }}>
          People on the list who already have a booking. Confirm one and it counts toward
          conversion — nothing is linked until you say so.
        </p>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Guest</th>
              <th>Waiting for</th>
              <th>Booking</th>
              <th>Why it matches</th>
              <th className="num">Players</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <div>{row.guestName || '—'}</div>
                  <div className="muted" style={{ fontSize: '0.75rem' }}>{row.guestEmail}</div>
                </td>
                <td>{formatDate(row.requestedDate)}</td>
                <td className="mono">
                  {row.bookingId}
                  <div className="muted" style={{ fontSize: '0.75rem' }}>
                    {row.bookingStatus} · {formatCurrency(row.total)}
                  </div>
                </td>
                <td>
                  {row.because}
                  {row.confidence === 'exact' && (
                    <div className="muted" style={{ fontSize: '0.75rem' }}>Exact date match</div>
                  )}
                </td>
                <td className="num">
                  {row.waitlistPlayers} → {row.bookingPlayers}
                  {!row.playersMatch && (
                    <div className="muted" style={{ fontSize: '0.75rem' }}>Party size differs</div>
                  )}
                </td>
                <td className="num">
                  <button type="button" className="btn-sm" disabled={busy} onClick={() => onLink(row)}>
                    This is the one
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The dates the list keeps piling up on. */
function Demand({ rows }) {
  return (
    <div className="card stack" style={{ gap: '0.75rem' }}>
      <div>
        <h3>Most wanted dates</h3>
        <p className="muted" style={{ margin: '0.15rem 0 0', fontSize: '0.8125rem' }}>
          Where the waiting players are — a date with many entries and few conversions is one to
          open more times on
        </p>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Entries</th>
              <th className="num">Players</th>
              <th className="num">Still open</th>
              <th className="num">Converted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.date}>
                <td>{formatDate(row.date)}</td>
                <td className="num">{row.entries}</td>
                <td className="num">{row.players}</td>
                <td className="num">{row.open}</td>
                <td className="num">{row.converted} ({row.conversion}%)</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EntryTable({ entries, busy, onNotify, onCancel, onConvert, onDelete }) {
  const [converting, setConverting] = useState(null);

  if (!entries.length) return <div className="empty">Nobody is waiting.</div>;

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Guest</th>
            <th>Date wanted</th>
            <th>Preferred</th>
            <th className="num">Players</th>
            <th className="num">Priority</th>
            <th>State</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.waitlistId} style={{ opacity: entry.open ? 1 : 0.6 }}>
              <td>
                <div>{entry.guestName || '—'}</div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>{entry.guestEmail}</div>
              </td>
              <td>{entry.requestedDate ? formatDate(entry.requestedDate) : '—'}</td>
              <td>{entry.preferredTime || 'Any'}{entry.timeFlexibility ? ` · ${entry.timeFlexibility}` : ''}</td>
              <td className="num">{entry.players}</td>
              <td className="num">{entry.priority}</td>
              <td>
                {entry.status}
                {entry.convertedBookingId && (
                  <div className="muted mono" style={{ fontSize: '0.75rem' }}>{entry.convertedBookingId}</div>
                )}
                {entry.notificationSent && entry.open && (
                  <div className="muted" style={{ fontSize: '0.75rem' }}>Notified</div>
                )}
              </td>
              <td className="num">
                {entry.open && (
                  <div className="row" style={{ justifyContent: 'flex-end', gap: '0.4rem' }}>
                    {!entry.notificationSent && (
                      <button type="button" className="btn-sm" disabled={busy} onClick={() => onNotify(entry)}>
                        Mark notified
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-sm"
                      disabled={busy}
                      onClick={() => setConverting(converting === entry.waitlistId ? null : entry.waitlistId)}
                    >
                      Convert
                    </button>
                    <button type="button" className="btn-sm" disabled={busy} onClick={() => onCancel(entry)}>
                      Cancel
                    </button>
                    <button type="button" className="btn-sm btn-danger" disabled={busy} onClick={() => onDelete(entry)}>
                      Delete
                    </button>
                  </div>
                )}
                {converting === entry.waitlistId && (
                  <ConvertForm
                    entry={entry}
                    busy={busy}
                    onSubmit={(booking) => {
                      setConverting(null);
                      onConvert(entry, booking);
                    }}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Turning an entry into a booking needs the two things the entry cannot know. */
function ConvertForm({ entry, busy, onSubmit }) {
  const [form, setForm] = useState({ teeTime: '', date: entry.requestedDate ?? '', total: '' });

  return (
    <form
      className="row"
      style={{ justifyContent: 'flex-end', marginTop: '0.5rem', gap: '0.4rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ ...form, total: Number(form.total) || 0 });
      }}
    >
      <input
        type="date"
        value={form.date}
        onChange={(event) => setForm({ ...form, date: event.target.value })}
        aria-label="Play date"
        required
        style={{ width: 'auto' }}
      />
      <input
        value={form.teeTime}
        onChange={(event) => setForm({ ...form, teeTime: event.target.value })}
        placeholder="09:40 AM"
        aria-label="Tee time"
        required
        style={{ width: '7rem' }}
      />
      <input
        type="number"
        min="0"
        step="0.01"
        value={form.total}
        onChange={(event) => setForm({ ...form, total: event.target.value })}
        placeholder="Total"
        aria-label="Booking total"
        style={{ width: '7rem' }}
      />
      <button type="submit" className="btn-primary btn-sm" disabled={busy}>Book it</button>
    </form>
  );
}
