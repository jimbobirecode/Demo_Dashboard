import { formatCurrency, formatNumber } from '../../lib/format.js';
import { INK_MUTED, OVERDUE, PAYMENT_COLORS, SERIES } from '../../lib/palette.js';
import { BarChart, BarList, CategoryBar, ChartCard, TableView } from '../charts/index.js';
import { Figure, NotRecorded, Section } from './Section.jsx';

/**
 * The money already agreed: what has been collected, what is late, and who the
 * book comes from.
 *
 * Both cards read only committed bookings — an open enquiry is not revenue and
 * cannot be overdue.
 */
export default function MoneySection({ payments, trade }) {
  return (
    <>
      <Section
        title="Money and channel"
        blurb="Booked rounds only — what has been collected, what is late, and where the book comes from"
      />

      <div className="chart-grid">
        <ChartCard
          title="Collection"
          subtitle={
            payments.tracked
              ? `${formatCurrency(payments.paid)} of ${formatCurrency(payments.gross)} collected across ${formatNumber(payments.bookings)} committed bookings`
              : 'No booking in this period records a payment'
          }
          footer={
            payments.tracked && (
              <TableView
                label="the numbers"
                columns={[
                  { key: 'key', header: 'Payment status' },
                  { key: 'count', header: 'Bookings', numeric: true },
                  { key: 'gross', header: 'Value', numeric: true, render: (r) => formatCurrency(r.gross) },
                  { key: 'paid', header: 'Paid', numeric: true, render: (r) => formatCurrency(r.paid) },
                  { key: 'outstanding', header: 'Outstanding', numeric: true, render: (r) => formatCurrency(r.outstanding) },
                ]}
                rows={payments.byStatus.filter((row) => row.count > 0).map((row) => ({ ...row, key: row.key }))}
              />
            )
          }
        >
          {payments.tracked ? (
            <div className="stack" style={{ gap: '1rem' }}>
              <div className="detail-grid">
                <Figure label="Outstanding" value={formatCurrency(payments.outstanding)} />
                <Figure
                  label="Overdue"
                  value={formatCurrency(payments.overdueAmount)}
                  sub={`${formatNumber(payments.overdue)} booking${payments.overdue === 1 ? '' : 's'} past its due date`}
                />
                <Figure label="Collected" value={`${payments.collectionRate}%`} />
                <Figure label="Invoiced" value={`${payments.invoicedRate}%`} />
              </div>

              <BarChart
                data={payments.byStatus.filter((row) => row.count > 0)}
                valueFormatter={formatNumber}
                colorFor={(row) => PAYMENT_COLORS[row.key] ?? INK_MUTED}
                tooltipRows={(row) => [
                  { label: 'Bookings', value: formatNumber(row.count), color: PAYMENT_COLORS[row.key] },
                  { label: 'Value', value: formatCurrency(row.gross) },
                  { label: 'Paid', value: formatCurrency(row.paid) },
                  { label: 'Outstanding', value: formatCurrency(row.outstanding) },
                ]}
                emptyMessage="No committed bookings in this period."
              />
            </div>
          ) : (
            <NotRecorded>
              Nothing in this period records a payment. Payment state is recorded on the
              booking drawer.
            </NotRecorded>
          )}
        </ChartCard>

        <ChartCard
          title="Overdue by age"
          subtitle="How old the outstanding money is, counted from the date it fell due"
          footer={
            <TableView
              label="the numbers"
              columns={[
                { key: 'key', header: 'Late by' },
                { key: 'count', header: 'Bookings', numeric: true },
                { key: 'amount', header: 'Outstanding', numeric: true, render: (r) => formatCurrency(r.amount) },
              ]}
              rows={payments.ageing.filter((row) => row.count > 0)}
            />
          }
        >
          <BarChart
            data={payments.ageing}
            layout="vertical"
            color={OVERDUE}
            valueFormatter={formatNumber}
            tooltipRows={(row) => [
              { label: 'Bookings', value: formatNumber(row.count), color: OVERDUE },
              { label: 'Outstanding', value: formatCurrency(row.amount) },
            ]}
            emptyMessage="Nothing is overdue in this period."
          />
        </ChartCard>

        <ChartCard
          title="Direct against trade"
          subtitle={`${trade.tradeShare}% of bookings come through a tour operator account`}
          footer={
            <TableView
              label="the numbers"
              columns={[
                { key: 'key', header: 'Channel' },
                { key: 'count', header: 'Bookings', numeric: true },
                { key: 'players', header: 'Players', numeric: true },
                { key: 'averageParty', header: 'Average party', numeric: true },
                { key: 'conversion', header: 'Conversion', numeric: true, render: (r) => `${r.conversion}%` },
                { key: 'averageValue', header: 'Average value', numeric: true, render: (r) => formatCurrency(r.averageValue) },
                { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => formatCurrency(r.revenue) },
              ]}
              rows={trade.channels}
            />
          }
        >
          <div className="stack" style={{ gap: '1rem' }}>
            <CategoryBar
              value={trade.channels[1].count}
              total={trade.channels[0].count + trade.channels[1].count}
              label="Through an operator"
              remainderLabel="Direct"
            />
            <div className="detail-grid">
              <Figure
                label="Average trade booking"
                value={formatCurrency(trade.channels[1].averageValue)}
                sub={`${trade.channels[1].averageParty} players on average`}
              />
              <Figure
                label="Average direct booking"
                value={formatCurrency(trade.channels[0].averageValue)}
                sub={`${trade.channels[0].averageParty} players on average`}
              />
              <Figure label="Trade conversion" value={`${trade.channels[1].conversion}%`} />
              <Figure label="Direct conversion" value={`${trade.channels[0].conversion}%`} />
            </div>
          </div>
        </ChartCard>

        <ChartCard
          title="Top trade accounts"
          subtitle="By committed revenue in this period"
          footer={
            <TableView
              label="the numbers"
              columns={[
                { key: 'key', header: 'Account' },
                { key: 'count', header: 'Bookings', numeric: true },
                { key: 'players', header: 'Players', numeric: true },
                { key: 'conversion', header: 'Conversion', numeric: true, render: (r) => `${r.conversion}%` },
                { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => formatCurrency(r.revenue) },
              ]}
              rows={trade.operators}
            />
          }
        >
          <BarList
            data={trade.operators}
            category="revenue"
            color={SERIES}
            valueFormatter={formatCurrency}
            emptyMessage="No booking in this period is matched to a tour operator."
          />
        </ChartCard>
      </div>
    </>
  );
}
