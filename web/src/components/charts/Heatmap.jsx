import { useState } from 'react';
import { GRID, SEQUENTIAL, sequentialStep } from '../../lib/palette.js';
import { ChartTooltip } from './ChartTooltip.jsx';

/**
 * Weekday × time-band grid — magnitude across two categorical axes, so the
 * colour job is sequential: one hue, more-is-brighter.
 *
 * An empty slot is drawn as bare surface with a hairline rather than as the
 * ramp's darkest step, so "nobody asked for this" and "almost nobody asked for
 * this" never look the same. Every cell is focusable and reports its own
 * numbers, so the grid is readable without hovering and without colour.
 *
 * `valueKey` picks which number drives the fill, so one grid can be read as
 * demand, as bookings or as a conversion rate without redrawing it; the
 * tooltip always shows the whole cell.
 */
export function Heatmap({
  cells,
  days,
  bands,
  valueKey = 'count',
  valueLabel = 'bookings',
  valueFormatter = (value) => value,
  tooltipRows,
  emptyMessage,
}) {
  const [hovered, setHovered] = useState(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });

  const peak = Math.max(...cells.map((cell) => cell[valueKey]), 0);
  if (!peak) return <div className="empty">{emptyMessage}</div>;

  const at = (band, day) => cells.find((cell) => cell.band === band && cell.day === day);

  return (
    <div className="relative">
      <div
        className="grid gap-1 text-[0.6875rem]"
        style={{ gridTemplateColumns: `minmax(88px, auto) repeat(${days.length}, minmax(0, 1fr))` }}
        onMouseLeave={() => setHovered(null)}
      >
        <div />
        {days.map((day) => (
          <div key={day} className="pb-1 text-center font-medium uppercase tracking-wide text-ink-muted">
            {day.slice(0, 3)}
          </div>
        ))}

        {bands.map((band) => (
          <Row key={band} band={band}>
            {days.map((day) => {
              const cell = at(band, day);
              const value = cell?.[valueKey] ?? 0;
              const fill = sequentialStep(value / peak);

              return (
                <button
                  key={day}
                  type="button"
                  className="h-8 w-full rounded-sm transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-series-bright"
                  style={
                    fill ? { background: fill } : { background: 'transparent', boxShadow: `inset 0 0 0 1px ${GRID}` }
                  }
                  aria-label={`${band}, ${day}: ${valueFormatter(value)} ${valueLabel}`}
                  onMouseEnter={() => setHovered({ band, day, cell })}
                  onFocus={() => setHovered({ band, day, cell })}
                  onMouseMove={(event) => setPointer({ x: event.clientX, y: event.clientY })}
                  onBlur={() => setHovered(null)}
                >
                  {/* The number is the accessible name; the fill is reinforcement. */}
                  <span className="sr-only">{valueFormatter(value)}</span>
                </button>
              );
            })}
          </Row>
        ))}
      </div>

      <Legend peak={peak} valueFormatter={valueFormatter} />

      {hovered && (
        <div className="pointer-events-none fixed z-50" style={{ left: pointer.x + 12, top: pointer.y + 12 }}>
          <ChartTooltip
            title={`${hovered.day} · ${hovered.band}`}
            rows={
              tooltipRows
                ? tooltipRows(hovered.cell ?? {})
                : [
                    { label: 'Bookings', value: hovered.cell?.count ?? 0 },
                    { label: 'Players', value: hovered.cell?.players ?? 0 },
                  ]
            }
          />
        </div>
      )}
    </div>
  );
}

function Row({ band, children }) {
  return (
    <>
      <div className="flex items-center pr-2 text-right text-ink-muted justify-end">{band}</div>
      {children}
    </>
  );
}

function Legend({ peak, valueFormatter }) {
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-[0.6875rem] text-ink-muted">
      <span>0</span>
      <span
        className="h-3 w-4 rounded-sm"
        style={{ background: 'transparent', boxShadow: `inset 0 0 0 1px ${GRID}` }}
      />
      {SEQUENTIAL.map((step) => (
        <span key={step} className="h-3 w-4 rounded-sm" style={{ background: step }} />
      ))}
      <span className="tabular-nums">{valueFormatter(peak)}</span>
    </div>
  );
}
