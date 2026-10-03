import { formatCurrency, formatNumber } from '../../lib/format.js';
import { SERIES, categoricalColor } from '../../lib/palette.js';
import { BarChart, BarList, CategoryBar, ChartCard, TableView } from '../charts/index.js';
import { Figure, NotRecorded, Section } from './Section.jsx';

/**
 * The bed half of a golf trip, for the parties that asked for one.
 *
 * The attach rate card that used to stand alone lives here too, so the
 * question "how many want a bed, and what is the bed worth" is answered in one
 * place rather than two.
 */
export default function StaySection({ lodging, accommodation }) {
  return (
    <>
      <Section
        title="Accommodation"
        blurb="Who wants a bed, how long they stay, and what the stay is worth beside the golf"
      />

      <div className="chart-grid">
        <ChartCard title="Attach rate" subtitle={`${accommodation.attachRate}% of parties also want a bed`}>
          <div className="stack" style={{ gap: '1rem' }}>
            <CategoryBar
              value={accommodation.withAccommodation}
              total={accommodation.total}
              label="Want accommodation"
              remainderLabel="Golf only"
            />
            <div className="detail-grid">
              <Figure label="Average with a stay" value={formatCurrency(accommodation.averageWith)} />
              <Figure label="Average golf only" value={formatCurrency(accommodation.averageWithout)} />
              <Figure
                label="Room nights"
                value={formatNumber(lodging.roomNights)}
                sub={`${formatNumber(lodging.rooms)} rooms over ${formatNumber(lodging.nightsTotal)} nights`}
              />
              <Figure
                label="Median stay"
                value={lodging.medianNights === null ? '—' : `${lodging.medianNights} nights`}
                sub={lodging.averageNights === null ? undefined : `${lodging.averageNights} on average`}
              />
            </div>
          </div>
        </ChartCard>

        <ChartCard
          title="Length of stay"
          subtitle="Nights per party, for the parties that recorded one"
          footer={
            <TableView
              label="the numbers"
              columns={[
                { key: 'key', header: 'Stay' },
                { key: 'count', header: 'Parties', numeric: true },
              ]}
              rows={lodging.nightsDistribution}
            />
          }
        >
          <BarChart
            data={lodging.nightsDistribution}
            valueFormatter={formatNumber}
            emptyMessage="No booking in this period records how many nights."
          />
        </ChartCard>

        <ChartCard
          title="Room types"
          subtitle="What parties actually ask for"
          footer={
            <TableView
              label="the numbers"
              columns={[
                { key: 'key', header: 'Room type' },
                { key: 'count', header: 'Parties', numeric: true },
                { key: 'rooms', header: 'Rooms', numeric: true },
                { key: 'nights', header: 'Nights', numeric: true },
              ]}
              rows={lodging.roomTypes}
            />
          }
        >
          <BarList
            data={lodging.roomTypes}
            color={SERIES}
            valueFormatter={formatNumber}
            emptyMessage="No booking in this period records a room type."
          />
        </ChartCard>

        <ChartCard
          title="Where the revenue sits"
          subtitle="Committed revenue split into golf, lodging and resort fees — a booking that records neither reads as all golf"
          footer={
            <TableView
              label="the numbers"
              columns={[
                { key: 'key', header: 'Line' },
                { key: 'value', header: 'Revenue', numeric: true, render: (r) => formatCurrency(r.value) },
              ]}
              rows={lodging.revenueMix}
            />
          }
        >
          {lodging.revenueMix.length ? (
            <BarList
              data={lodging.revenueMix}
              category="value"
              colorFor={(row, index) => categoricalColor(index)}
              valueFormatter={formatCurrency}
            />
          ) : (
            <NotRecorded>No committed revenue in this period.</NotRecorded>
          )}
        </ChartCard>
      </div>
    </>
  );
}
