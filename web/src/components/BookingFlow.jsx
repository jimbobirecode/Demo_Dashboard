import { formatCurrency, formatNumber } from '../lib/format.js';

/**
 * The pipeline as a flow, not as a row of boxes.
 *
 * Seven tiles of equal weight said nothing about order: Rejected sat beside
 * Booked as though a round went to one or the other at random, and the two a
 * club watches all day -- what is waiting on an answer, and what is waiting on
 * money -- looked like the two it checks once a month.
 *
 * So the stages a booking actually moves through are drawn in the order it
 * moves through them.
 *
 * Each stage is a button: pressing one narrows the list to it, pressing it
 * again puts the list back. `stages` is [{ id, label, value, sub, accent,
 * pressed, onClick }].
 *
 * No arrows between them. The order is the order on the screen, and an arrow
 * in every gap was something more to read for something already plain.
 */
export default function BookingFlow({ stages, aside = null }) {
  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      <div className="flow">
        {stages.map((stage) => (
          <Step key={stage.id} stage={stage} />
        ))}
      </div>
      {aside}
    </div>
  );
}

function Step({ stage }) {
  return (
    <button
      type="button"
      className="flow-step"
      aria-pressed={stage.pressed}
      onClick={stage.onClick}
      style={{ '--flow-accent': stage.accent }}
    >
      <div className="label">{stage.label}</div>
      <div className="flow-value">{stage.value}</div>
      {stage.sub && <div className="flow-sub">{stage.sub}</div>}
    </button>
  );
}

/** The counts a flow needs, from the bookings already on screen. */
export function flowValue(count, money) {
  return money === undefined ? formatNumber(count) : formatCurrency(money);
}
