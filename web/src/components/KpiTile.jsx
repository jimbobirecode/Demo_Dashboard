import { DELTA_DOWN, DELTA_UP } from '../lib/palette.js';

/**
 * A stat tile — the right form for a single headline number. Renders as a
 * button when it also acts as a filter toggle, and can carry a
 * period-over-period delta.
 *
 * The delta's colour is reinforcement only: the arrow glyph and the signed
 * number carry it, because up-green and down-red are the same colour to a
 * deuteranope. `delta === null` means the previous period was zero, where a
 * percentage would be meaningless — it says so in words instead.
 */
export default function KpiTile({
  label,
  value,
  sub,
  accent,
  onClick,
  pressed,
  delta,
  deltaLabel = 'vs previous',
  higherIsBetter = true,
}) {
  const content = (
    <>
      <div className="label">{label}</div>
      <div className="kpi-value">{value}</div>
      {delta !== undefined && <Delta delta={delta} label={deltaLabel} higherIsBetter={higherIsBetter} />}
      {sub && <div className="kpi-sub">{sub}</div>}
    </>
  );

  if (!onClick) {
    return (
      <div className="kpi" style={{ '--kpi-accent': accent }}>
        {content}
      </div>
    );
  }

  return (
    <button type="button" className="kpi" style={{ '--kpi-accent': accent }} onClick={onClick} aria-pressed={pressed}>
      {content}
    </button>
  );
}

function Delta({ delta, label, higherIsBetter }) {
  if (delta === null) {
    return <div className="kpi-sub">No activity in the previous period</div>;
  }

  const flat = Number(delta) === 0;
  const rising = Number(delta) > 0;
  const color = flat ? undefined : rising === higherIsBetter ? DELTA_UP : DELTA_DOWN;

  return (
    <div className="kpi-delta" style={color ? { color } : undefined}>
      <span aria-hidden="true">{flat ? '→' : rising ? '▲' : '▼'}</span>
      <span className="kpi-delta-value">{flat ? 'No change' : `${Math.abs(delta)}%`}</span>
      <span className="kpi-sub" style={{ margin: 0 }}>
        {label}
      </span>
    </div>
  );
}
