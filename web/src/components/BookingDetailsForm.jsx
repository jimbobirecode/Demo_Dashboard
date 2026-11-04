import { useEffect, useMemo, useState } from 'react';
import { formatCurrency } from '../lib/format.js';

/**
 * Changing a booking's details from the drawer: the date, the tee time, the
 * party, the price, and who it is with.
 *
 * Closed until somebody asks for it, because most visits to a booking are to
 * read it. Open, it says what a change will do before it is saved: a party
 * that grows is repriced at the price per player it was taken at, and the new
 * total is shown beside the field rather than discovered afterwards. Typing a
 * total yourself turns that off — an agreed price stands.
 *
 * `onSave(patch)` resolves to the server's answer, whose `warnings` (a payment
 * link out for the old amount, more paid than the new total) are put in front
 * of whoever made the change.
 */
const FIELDS = ['date', 'teeTime', 'players', 'total', 'guestName', 'guestEmail', 'contactPhone', 'specialRequests'];

function formOf(booking) {
  return {
    date: booking.date ?? '',
    teeTime: booking.teeTime === 'Not Specified' ? '' : (booking.teeTime ?? ''),
    players: String(booking.players ?? ''),
    total: String(booking.total ?? ''),
    guestName: booking.guestName ?? '',
    guestEmail: booking.guestEmail ?? '',
    contactPhone: booking.contactPhone ?? '',
    specialRequests: booking.specialRequests ?? '',
  };
}

export default function BookingDetailsForm({ booking, onSave }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(() => formOf(booking));
  const [totalTyped, setTotalTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  // A different booking, or this one saved: start again from what is stored.
  useEffect(() => {
    setForm(formOf(booking));
    setTotalTyped(false);
  }, [booking]);

  useEffect(() => {
    setOpen(false);
    setMessage(null);
  }, [booking.bookingId]);

  const original = useMemo(() => formOf(booking), [booking]);
  const each = Number(booking.players) > 0 ? Number(booking.total) / Number(booking.players) : null;
  const players = Number(form.players);
  const partyChanged = form.players !== original.players && Number.isInteger(players) && players > 0;
  // The figure the server will reprice to, shown before it does.
  const repriced = partyChanged && !totalTyped && each !== null ? Math.round(each * players * 100) / 100 : null;

  const changed = FIELDS.filter((field) => form[field] !== original[field]);

  function set(field, value) {
    setMessage(null);
    if (field === 'total') setTotalTyped(true);
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const patch = {};
      for (const field of changed) {
        // The total is the server's to work out unless somebody typed one.
        if (field === 'total' && !totalTyped) continue;
        patch[field] = ['players', 'total'].includes(field) ? Number(form[field]) : form[field];
      }
      const result = await onSave(patch);
      const lines = [];
      if (result?.repriced) {
        lines.push(
          `Repriced at ${formatCurrency(result.repriced.pricePerPlayer)} a player: ` +
            `${formatCurrency(result.repriced.from)} → ${formatCurrency(result.repriced.to)}.`,
        );
      }
      lines.push(...(result?.warnings ?? []));
      setMessage({ kind: result?.warnings?.length ? 'warning' : 'success', lines: ['Saved.', ...lines] });
      setOpen(false);
    } catch (err) {
      setMessage({ kind: 'error', lines: [err.message] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: '0.6rem' }}>
      <div className="between">
        <span className="label">Booking details</span>
        {!open && (
          <button type="button" className="btn-sm" onClick={() => setOpen(true)}>
            Edit booking
          </button>
        )}
      </div>

      {message && (
        <div className={`banner ${message.kind}`} role="status">
          {message.lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}

      {open && (
        <div className="card stack" style={{ gap: '0.75rem', background: 'var(--surface-0)' }}>
          <div className="form-grid">
            <Labelled label="Date">
              <input type="date" value={form.date} onChange={(event) => set('date', event.target.value)} />
            </Labelled>
            <Labelled label="Tee time">
              <input
                value={form.teeTime}
                placeholder="e.g. 10:20"
                onChange={(event) => set('teeTime', event.target.value)}
              />
            </Labelled>
            <Labelled label="Players">
              <input
                type="number"
                min="1"
                step="1"
                value={form.players}
                onChange={(event) => set('players', event.target.value)}
              />
            </Labelled>
            <Labelled label="Total (€)">
              <input
                type="number"
                min="0"
                step="0.01"
                value={repriced !== null ? String(repriced) : form.total}
                onChange={(event) => set('total', event.target.value)}
              />
            </Labelled>
          </div>
          {repriced !== null && (
            <div className="muted" style={{ fontSize: '0.8125rem', marginTop: '-0.35rem' }}>
              {players} × {formatCurrency(each)}, the price per player it was taken at. Type a total to set your own.
            </div>
          )}

          <div className="form-grid">
            <Labelled label="Lead guest">
              <input value={form.guestName} onChange={(event) => set('guestName', event.target.value)} />
            </Labelled>
            <Labelled label="Phone">
              <input value={form.contactPhone} onChange={(event) => set('contactPhone', event.target.value)} />
            </Labelled>
            <Labelled label="Email we reply to" wide>
              <input type="email" value={form.guestEmail} onChange={(event) => set('guestEmail', event.target.value)} />
            </Labelled>
            <Labelled label="Special requests" wide>
              <textarea
                rows={2}
                value={form.specialRequests}
                onChange={(event) => set('specialRequests', event.target.value)}
              />
            </Labelled>
          </div>

          <div className="row">
            <button type="button" className="btn-primary" disabled={busy || !changed.length} onClick={save}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setForm(original);
                setTotalTyped(false);
                setOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Labelled({ label, wide = false, children }) {
  return (
    <label className="stack" style={{ gap: '0.25rem', ...(wide ? { gridColumn: '1 / -1' } : {}) }}>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
