import { INK_SECONDARY } from '../../lib/palette.js';

/**
 * Tremor's tooltip shape: a heading, then one row per series with its colour
 * swatch, label and value.
 *
 * Values and labels wear text tokens — the swatch beside them is the only thing
 * carrying series identity, so nothing reads as coloured-in data.
 */
export function ChartTooltip({ title, rows }) {
  return (
    <div className="chart-tooltip">
      {title && <div style={{ fontWeight: 700, marginBottom: rows.length ? '0.35rem' : 0 }}>{title}</div>}
      {rows.map((row) => (
        <div key={row.label} className="row" style={{ gap: '1rem', justifyContent: 'space-between' }}>
          <span className="row" style={{ gap: '0.4rem' }}>
            {row.color && (
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: row.color,
                  display: 'inline-block',
                }}
              />
            )}
            <span style={{ color: INK_SECONDARY }}>{row.label}</span>
          </span>
          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Wires ChartTooltip into Recharts' render-prop contract. */
export function tooltipRenderer(build) {
  return function render({ active, payload, label }) {
    if (!active || !payload?.length) return null;
    const content = build({ payload, label });
    return content ? <ChartTooltip {...content} /> : null;
  };
}
