import { useEffect, useState } from 'react';
import { formatCurrency } from '../lib/format.js';
import { suggestedRate } from '../lib/rates.js';
import { Labelled } from './BookingDetailsForm.jsx';

/**
 * Taking a booking by hand: over the phone, at the counter, or from an email
 * that came to the office rather than the bot.
 *
 * What it asks for is what a booking cannot do without — a date, a party, a
 * price, and a way to reach them — and the rest is optional. The price is per
 * player, as the club quotes it, prefilled from the rate card for the date and
 * for whether it is on a tour operator's account; the total beside it is what
 * the booking will cost.
 *
 * Saved, it is an ordinary booking: the drawer opens on it so a payment can be
 * taken or a link sent there and then, and it joins the payment and arrival
 * emails like any booking the bot took — waiting on Booking Status for
 * somebody to send them, unless sending on a schedule is switched on.
 */
const EMPTY = {
  date: '',
  teeTime: '',
  players: '4',
  pricePerPlayer: '',
  guestName: '',
  guestEmail: '',
  contactPhone: '',
  operatorId: '',
  status: 'Booked',
  source: 'phone',
  specialRequests: '',
  note: '',
};

export default function NewBookingForm({ operators = [], onCreate, onClose }) {
  const [form, setForm] = useState(EMPTY);
  const [priceTyped, setPriceTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // The rate card's figure, until somebody types their own.
  const suggestion = suggestedRate(form.date, { tourOperator: Boolean(form.operatorId) });
  const each = priceTyped ? form.pricePerPlayer : suggestion === null ? '' : String(suggestion);
  const players = Number(form.players);
  // No price yet is no total, not a total of nothing.
  const total =
    each !== '' && Number(each) >= 0 && Number.isInteger(players) && players > 0 ? Number(each) * players : null;

  const active = operators.filter((operator) => operator.active !== false);

  function set(field, value) {
    setError(null);
    if (field === 'pricePerPlayer') setPriceTyped(true);
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        ...form,
        players: Number(form.players),
        pricePerPlayer: each === '' ? undefined : Number(each),
        operatorId: form.operatorId || undefined,
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Add a booking">
        <div className="between">
          <div>
            <div style={{ fontSize: '1.125rem', fontWeight: 700 }}>Add a booking</div>
            <div className="secondary">Taken by phone, in person, or from an email to the office</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && <div className="banner error">{error}</div>}

        <form className="stack" style={{ gap: '1rem' }} onSubmit={submit}>
          <div className="form-grid">
            <Labelled label="How it came in">
              <select value={form.source} onChange={(event) => set('source', event.target.value)}>
                <option value="phone">Phone</option>
                <option value="walk_in">In person</option>
                <option value="email">Email to the office</option>
              </select>
            </Labelled>
            <Labelled label="Status">
              <select value={form.status} onChange={(event) => set('status', event.target.value)}>
                <option value="Booked">Booked</option>
                <option value="Requested">Requested — times offered</option>
                <option value="Inquiry">Inquiry — not yet answered</option>
              </select>
            </Labelled>
          </div>

          <div className="form-grid">
            <Labelled label="Date">
              <input type="date" required value={form.date} onChange={(event) => set('date', event.target.value)} />
            </Labelled>
            <Labelled label="Tee time">
              <input
                value={form.teeTime}
                placeholder="e.g. 10:20"
                onChange={(event) => set('teeTime', event.target.value)}
              />
            </Labelled>
          </div>

          <div className="form-grid">
            <Labelled label="Players">
              <input
                type="number"
                min="1"
                step="1"
                required
                value={form.players}
                onChange={(event) => set('players', event.target.value)}
              />
            </Labelled>
            <Labelled label="Price per player (€)">
              <input
                type="number"
                min="0"
                step="0.01"
                required
                value={each}
                onChange={(event) => set('pricePerPlayer', event.target.value)}
              />
            </Labelled>
            <div className="stack" style={{ gap: '0.25rem' }}>
              <span className="label">Total</span>
              <div className="flow-value" style={{ fontSize: '1.25rem', color: 'var(--brand-gold-bright)' }}>
                {total === null ? '—' : formatCurrency(total)}
              </div>
            </div>
          </div>
          <div className="muted" style={{ fontSize: '0.8125rem', marginTop: '-0.5rem' }}>
            {each === ''
              ? 'Pick a date and the rate card fills in the price. Type over it to change it.'
              : priceTyped
                ? 'Your own price per player.'
                : 'The rate card’s price for that date. Type over it to change it.'}
          </div>

          <Labelled label="Tour operator account">
            <select value={form.operatorId} onChange={(event) => set('operatorId', event.target.value)}>
              <option value="">None — a visitor</option>
              {active.map((operator) => (
                <option key={operator.id} value={operator.id}>
                  {operator.name}
                </option>
              ))}
            </select>
          </Labelled>

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
          </div>
          {!form.guestEmail && (
            <div className="muted" style={{ fontSize: '0.8125rem', marginTop: '-0.5rem' }}>
              Without an email address the booking is kept, but no payment link or reminder can reach it.
            </div>
          )}

          <Labelled label="Special requests">
            <textarea
              rows={2}
              value={form.specialRequests}
              onChange={(event) => set('specialRequests', event.target.value)}
            />
          </Labelled>
          <Labelled label="Note">
            <textarea rows={3} value={form.note} onChange={(event) => set('note', event.target.value)} />
          </Labelled>

          <div className="row">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Adding…' : 'Add booking'}
            </button>
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
