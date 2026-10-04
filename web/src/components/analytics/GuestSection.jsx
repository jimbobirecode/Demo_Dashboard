import { formatCurrency, formatNumber } from '../../lib/format.js';
import { SERIES } from '../../lib/palette.js';
import { BarChart, BarList, CategoryBar, ChartCard, TableView } from '../charts/index.js';
import { Figure, Section } from './Section.jsx';

/**
 * Who is booking, and how quickly the office gets back to them.
 *
 * "Returning" only ever means "more than once inside the selected period" —
 * this page never sees the rest of the book, and says so rather than implying
 * a lifetime number.
 */
export default function GuestSection({ guests, responseTimes }) {
  return (
    <>
      <Section title="Guests and response" blurb="Who the enquiries come from, and how long they wait for an answer" />

      <div className="chart-grid">
        <ChartCard
          title="Repeat and new guests"
          subtitle={`${formatNumber(guests.guests)} distinct email addresses in this period`}
        >
          <div className="stack" style={{ gap: '1rem' }}>
            <CategoryBar
              value={guests.returning}
              total={guests.guests}
              label="Booked more than once"
              remainderLabel="Once"
            />
            <div className="detail-grid">
              <Figure label="Repeat rate" value={`${guests.repeatRate}%`} sub="Within this period only" />
              <Figure label="Bookings from repeats" value={formatNumber(guests.bookingsFromReturning)} />
              <Figure
                label="Business addresses"
                value={formatNumber(guests.business)}
                sub={`${formatNumber(guests.consumer)} personal`}
              />
              <Figure label="No address" value={formatNumber(guests.anonymous)} sub="Cannot be counted as a guest" />
            </div>
          </div>
        </ChartCard>

        <ChartCard
          title="Most frequent guests"
          subtitle="By bookings in this period"
          footer={
            <TableView
              label="the numbers"
              columns={[
                { key: 'key', header: 'Guest' },
                { key: 'email', header: 'Email' },
                { key: 'count', header: 'Bookings', numeric: true },
                { key: 'players', header: 'Players', numeric: true },
                { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => formatCurrency(r.revenue) },
              ]}
              rows={guests.top.map((row) => ({ ...row, key: row.email }))}
            />
          }
        >
          <BarList
            data={guests.top.map((row) => ({ ...row, label: row.key }))}
            index="email"
            color={SERIES}
            valueFormatter={formatNumber}
            emptyMessage="No booking in this period carries an email address."
          />
        </ChartCard>

        <ChartCard
          title="Time to answer"
          subtitle={
            responseTimes.medianHours === null
              ? 'From the enquiry landing to the booking being confirmed'
              : `Median ${describeHours(responseTimes.medianHours)} · ${responseTimes.withinDay}% answered inside a day`
          }
          footer={
            <TableView
              label="the numbers"
              columns={[
                { key: 'key', header: 'Answered in' },
                { key: 'count', header: 'Bookings', numeric: true },
              ]}
              rows={responseTimes.distribution}
            />
          }
        >
          <div className="stack" style={{ gap: '1rem' }}>
            <BarChart
              data={responseTimes.distribution}
              layout="vertical"
              valueFormatter={formatNumber}
              emptyMessage="No booking in this period has both an enquiry time and an answer."
            />
            <div className="detail-grid">
              <Figure label="Answered" value={formatNumber(responseTimes.answered)} />
              <Figure
                label="No answer recorded"
                value={formatNumber(responseTimes.unanswered)}
                sub="Still open, or never timestamped"
              />
            </div>
          </div>
        </ChartCard>
      </div>
    </>
  );
}

/** Hours read badly past a day or two. */
function describeHours(hours) {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}
