import { useState } from 'react';
import { formatCurrency, formatNumber } from '../../lib/format.js';
import { PIPELINE_RAMP, STATUS_COLORS } from '../../lib/palette.js';
import { ChartCard, Heatmap, BarList, TableView } from '../charts/index.js';
import { Segmented } from './Segmented.jsx';

const REQUEST_MEASURES = [
  { id: 'requests', label: 'Requested' },
  { id: 'bookings', label: 'Booked' },
  { id: 'missed', label: 'Not booked' },
  { id: 'conversion', label: 'Conversion' },
];

/**
 * Enquiries against actual bookings, slot by slot.
 *
 * A grid of confirmed bookings alone cannot tell a quiet slot nobody wants
 * from a busy slot everybody walks away from. This one counts demand where it
 * was asked for and supply where it was played, so the office can read both —
 * and the two lists underneath name the slots worth acting on.
 */
export default function RequestUtilisation({ grid }) {
  const [metric, setMetric] = useState('requests');
  const { totals } = grid;

  const asPercent = metric === 'conversion';
  const formatValue = asPercent ? (value) => `${value}%` : formatNumber;

  return (
    <>
      <ChartCard
        title="Booking request utilisation"
        subtitle={
          grid.placed
            ? `${formatNumber(totals.requests)} enquiries asked for a slot · ` +
              `${formatNumber(totals.converted)} booked (${totals.conversion}%) · ` +
              `${formatNumber(totals.missed)} did not` +
              (totals.unplaced ? ` · ${formatNumber(totals.unplaced)} carry no usable date or time` : '')
            : 'No enquiry in this period carries a date and a time to place'
        }
        action={<Segmented label="Request measure" options={REQUEST_MEASURES} value={metric} onChange={setMetric} />}
        footer={
          <TableView
            label="the numbers"
            columns={[
              { key: 'day', header: 'Day' },
              { key: 'band', header: 'Time' },
              { key: 'requests', header: 'Asked for', numeric: true },
              { key: 'converted', header: 'Booked it', numeric: true },
              { key: 'declined', header: 'Lost', numeric: true },
              { key: 'open', header: 'Still open', numeric: true },
              { key: 'conversion', header: 'Conversion', numeric: true, render: (r) => `${r.conversion}%` },
              { key: 'bookings', header: 'On the sheet', numeric: true },
              { key: 'revenue', header: 'Value', numeric: true, render: (r) => formatCurrency(r.revenue) },
            ]}
            rows={grid.cells
              .filter((cell) => cell.requests > 0 || cell.bookings > 0)
              .map((cell) => ({ ...cell, key: `${cell.band}|${cell.day}` }))}
          />
        }
      >
        <Heatmap
          cells={grid.cells}
          days={grid.days}
          bands={grid.bands}
          valueKey={metric}
          valueLabel={
            asPercent ? 'per cent converted' : REQUEST_MEASURES.find((m) => m.id === metric).label.toLowerCase()
          }
          valueFormatter={formatValue}
          tooltipRows={(cell) => [
            { label: 'Asked for', value: formatNumber(cell.requests ?? 0) },
            { label: 'Booked it', value: formatNumber(cell.converted ?? 0), color: STATUS_COLORS.Booked },
            { label: 'Lost', value: formatNumber(cell.declined ?? 0), color: STATUS_COLORS.Cancelled },
            { label: 'Still open', value: formatNumber(cell.open ?? 0), color: STATUS_COLORS.Inquiry },
            { label: 'Conversion', value: `${cell.conversion ?? 0}%` },
            { label: 'On the sheet', value: formatNumber(cell.bookings ?? 0) },
          ]}
          emptyMessage={
            metric === 'conversion'
              ? 'No slot in this period has an enquiry to convert.'
              : 'No enquiry in this period has a date and a time to place.'
          }
        />
      </ChartCard>

      <div className="chart-grid">
        <ChartCard
          title="Asked for, not booked"
          subtitle="The slots demand keeps landing on and walking away from"
          footer={
            <TableView
              label="the numbers"
              columns={[
                { key: 'key', header: 'Slot' },
                { key: 'requests', header: 'Asked for', numeric: true },
                { key: 'converted', header: 'Booked it', numeric: true },
                { key: 'declined', header: 'Lost', numeric: true },
                { key: 'open', header: 'Still open', numeric: true },
                { key: 'conversion', header: 'Conversion', numeric: true, render: (r) => `${r.conversion}%` },
              ]}
              rows={grid.gaps}
            />
          }
        >
          <BarList
            data={grid.gaps}
            category="missed"
            colorFor={(row) => (row.conversion ? STATUS_COLORS.Requested : STATUS_COLORS.Cancelled)}
            valueFormatter={formatNumber}
            emptyMessage="Every slot that was asked for was booked."
          />
        </ChartCard>

        <ChartCard
          title="Moved to another slot"
          subtitle={
            totals.moved
              ? `${formatNumber(totals.moved)} ${totals.moved === 1 ? 'party plays' : 'parties play'} a band other than the one they asked for`
              : 'Every booking plays the band it asked for'
          }
        >
          <BarList
            data={grid.shifts.map((shift) => ({
              ...shift,
              label: `${shift.day}: ${shift.from} → ${shift.to}`,
            }))}
            category="count"
            colorFor={() => PIPELINE_RAMP[2]}
            valueFormatter={formatNumber}
            emptyMessage="No booking was moved off the band it asked for."
          />
        </ChartCard>
      </div>
    </>
  );
}
