import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { DATE_PRESETS, resolvePreset } from '../lib/dateRanges.js';
import { formatCurrency, formatDate, formatDateShort, formatNumber } from '../lib/format.js';
import { STATUS_COLORS } from '../lib/status.js';
import { INK_MUTED, PIPELINE_RAMP, SERIES, categoricalColor } from '../lib/palette.js';
import KpiTile from '../components/KpiTile.jsx';
import { AreaChart, BarChart, BarList, ChartCard, TableView } from '../components/charts/index.js';
import {
  GuestSection,
  MoneySection,
  RequestUtilisation,
  ServiceSection,
  StaySection,
} from '../components/analytics/index.js';
import { Section } from '../components/analytics/Section.jsx';
import { Segmented } from '../components/analytics/Segmented.jsx';

const REFRESH_MS = 60_000;

const MEASURES = {
  count: { label: 'Bookings', format: formatNumber, color: SERIES },
  revenue: { label: 'Revenue', format: formatCurrency, color: SERIES },
  players: { label: 'Players', format: formatNumber, color: SERIES },
};

const GRANULARITIES = [
  { id: 'day', label: 'Daily' },
  { id: 'week', label: 'Weekly' },
  { id: 'month', label: 'Monthly' },
];

export default function Analytics() {
  const [preset, setPreset] = useState('next90');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [granularity, setGranularity] = useState(null); // null = let the span decide
  const [measure, setMeasure] = useState('count');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => resolvePreset(preset, custom), [preset, custom]);

  useEffect(() => {
    let cancelled = false;

    async function load({ silent } = {}) {
      if (!silent) setLoading(true);
      try {
        const payload = await api.analytics({ ...range, granularity });
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load({ silent: true });
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // Keyed on the range's ends, not the object, which is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, granularity]);

  if (loading && !data) return <div className="empty">Loading analytics…</div>;

  const active = MEASURES[measure];
  // The server decides the default granularity from the span; once the reader
  // picks one, theirs wins.
  const shownGranularity = granularity ?? data?.granularity ?? 'day';

  return (
    <div className="stack">
      <header className="between">
        <div>
          <h1>Reports &amp; Analytics</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            {range.from ? formatDate(range.from) : 'earliest'} → {range.to ? formatDate(range.to) : 'latest'}
            {data?.comparison && (
              <>
                {' '}
                · compared with {formatDate(data.comparison.from)} – {formatDate(data.comparison.to)}
              </>
            )}
          </p>
        </div>

        <div className="row">
          <select
            value={preset}
            onChange={(event) => setPreset(event.target.value)}
            aria-label="Analysis period"
            style={{ width: 'auto' }}
          >
            {DATE_PRESETS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
          {preset === 'custom' && (
            <>
              <input
                type="date"
                value={custom.from}
                onChange={(event) => setCustom({ ...custom, from: event.target.value })}
                aria-label="From date"
                style={{ width: 'auto' }}
              />
              <input
                type="date"
                value={custom.to}
                onChange={(event) => setCustom({ ...custom, to: event.target.value })}
                aria-label="To date"
                style={{ width: 'auto' }}
              />
            </>
          )}
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {!data && <div className="empty">No analytics available.</div>}

      {data && (
        <>
          <KpiRow totals={data.totals} />

          <ChartCard
            title={`${active.label} over time`}
            subtitle={`By tee date, ${shownGranularity === 'day' ? 'day by day' : `per ${shownGranularity}`} — hover for the period's detail`}
            action={
              <div className="row" style={{ gap: '0.5rem' }}>
                <Segmented
                  label="Measure"
                  options={Object.entries(MEASURES).map(([id, m]) => ({ id, label: m.label }))}
                  value={measure}
                  onChange={setMeasure}
                />
                <Segmented
                  label="Granularity"
                  options={GRANULARITIES}
                  value={shownGranularity}
                  onChange={setGranularity}
                />
              </div>
            }
            footer={
              <TableView
                label="the numbers"
                columns={[
                  { key: 'date', header: 'Period', render: (row) => formatDate(row.date) },
                  { key: 'count', header: 'Bookings', numeric: true, render: (r) => formatNumber(r.count) },
                  { key: 'players', header: 'Players', numeric: true, render: (r) => formatNumber(r.players) },
                  { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => formatCurrency(r.revenue) },
                ]}
                rows={data.series.map((row) => ({ ...row, key: row.date }))}
              />
            }
          >
            <AreaChart
              data={data.series}
              category={measure}
              color={active.color}
              valueFormatter={active.format}
              labelFormatter={shownGranularity === 'month' ? formatDate : formatDateShort}
              tooltipRows={(row) => [
                { label: 'Bookings', value: formatNumber(row.count), color: SERIES },
                { label: 'Players', value: formatNumber(row.players) },
                { label: 'Committed revenue', value: formatCurrency(row.revenue) },
              ]}
              emptyMessage="No bookings with a tee date in this period."
            />
          </ChartCard>

          <Section
            title="Pipeline and mix"
            blurb="Where enquiries are won and lost, and what the ones that land are made of"
          />

          <div className="chart-grid">
            <ChartCard
              title="Conversion funnel"
              subtitle="Bookings reaching each stage, excluding rejected and cancelled"
              footer={
                <TableView
                  label="stage detail"
                  columns={[
                    { key: 'stage', header: 'Stage' },
                    { key: 'count', header: 'Reached', numeric: true },
                    {
                      key: 'conversionFromPrevious',
                      header: 'From previous',
                      numeric: true,
                      render: (r) => `${r.conversionFromPrevious}%`,
                    },
                    { key: 'droppedHere', header: 'Lost here', numeric: true },
                  ]}
                  rows={data.funnel.map((row) => ({ ...row, key: row.stage }))}
                />
              }
            >
              <BarChart
                data={data.funnel}
                index="stage"
                layout="vertical"
                colorFor={(row) => STATUS_COLORS[row.stage]}
                valueFormatter={formatNumber}
                labelKey="conversionFromTop"
                labelRenderer={(value) => `${value}%`}
                tooltipRows={(row) => [
                  { label: 'Reached', value: formatNumber(row.count), color: STATUS_COLORS[row.stage] },
                  { label: 'Of all enquiries', value: `${row.conversionFromTop}%` },
                  { label: 'From previous stage', value: `${row.conversionFromPrevious}%` },
                  { label: 'Lost at this stage', value: formatNumber(row.droppedHere) },
                ]}
                emptyMessage="No pipeline activity in this period."
              />
            </ChartCard>

            <ChartCard
              title="Booking lead time"
              subtitle={
                data.leadTime.median === null
                  ? 'How far ahead the tee sheet fills'
                  : `Median ${data.leadTime.median} days ahead of play`
              }
              footer={
                <TableView
                  label="the numbers"
                  columns={[
                    { key: 'key', header: 'Booked ahead' },
                    { key: 'count', header: 'Bookings', numeric: true },
                  ]}
                  rows={data.leadTime.distribution}
                />
              }
            >
              <BarChart
                data={data.leadTime.distribution}
                layout="vertical"
                valueFormatter={formatNumber}
                emptyMessage="No bookings carry both an enquiry date and a tee date."
              />
            </ChartCard>

            <ChartCard
              title="Party size"
              subtitle="Players per booking — where the volume and the money actually sit"
              footer={
                <TableView
                  label="the numbers"
                  columns={[
                    { key: 'key', header: 'Party' },
                    { key: 'count', header: 'Bookings', numeric: true },
                    { key: 'players', header: 'Players', numeric: true },
                    { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => formatCurrency(r.revenue) },
                  ]}
                  rows={data.partySizes}
                />
              }
            >
              <BarChart
                data={data.partySizes}
                valueFormatter={formatNumber}
                tooltipRows={(row) => [
                  { label: 'Bookings', value: formatNumber(row.count), color: SERIES },
                  { label: 'Players', value: formatNumber(row.players) },
                  { label: 'Committed revenue', value: formatCurrency(row.revenue) },
                ]}
                emptyMessage="No bookings in this period."
              />
            </ChartCard>

            <ChartCard
              title="Course mix"
              subtitle="A booking naming both courses counts toward each, so these do not sum to the total"
              footer={
                <TableView
                  label="the numbers"
                  columns={[
                    { key: 'key', header: 'Course' },
                    { key: 'count', header: 'Bookings', numeric: true },
                    { key: 'players', header: 'Players', numeric: true },
                    { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => formatCurrency(r.revenue) },
                  ]}
                  rows={data.courses}
                />
              }
            >
              <BarList
                data={data.courses}
                colorFor={(row, index) => (row.key === 'Not specified' ? INK_MUTED : categoricalColor(index))}
                valueFormatter={formatNumber}
                emptyMessage="No course recorded on any booking in this period."
              />
            </ChartCard>

            <ChartCard
              title="Bookings by status"
              subtitle="Colour brightens along the pipeline; every bar is labelled"
              footer={
                <TableView
                  label="the numbers"
                  columns={[
                    { key: 'status', header: 'Status' },
                    { key: 'count', header: 'Bookings', numeric: true },
                    { key: 'players', header: 'Players', numeric: true },
                    { key: 'revenue', header: 'Value', numeric: true, render: (r) => formatCurrency(r.revenue) },
                  ]}
                  rows={data.byStatus.map((row) => ({ ...row, key: row.status }))}
                />
              }
            >
              <BarChart
                data={data.byStatus.filter((row) => row.count > 0)}
                index="status"
                layout="vertical"
                colorFor={(row) => STATUS_COLORS[row.status]}
                valueFormatter={formatNumber}
                tooltipRows={(row) => [
                  { label: 'Bookings', value: formatNumber(row.count), color: STATUS_COLORS[row.status] },
                  { label: 'Players', value: formatNumber(row.players) },
                  { label: 'Value', value: formatCurrency(row.revenue) },
                ]}
                emptyMessage="No bookings in this period."
              />
            </ChartCard>
          </div>

          <Section
            title="Demand against bookings"
            blurb="What people asked for, slot by slot, beside what the tee sheet actually carries"
          />

          <RequestUtilisation grid={data.requestUtilisation} />

          <div className="chart-grid">
            <ChartCard title="Most requested tee times" subtitle="Top slots by volume">
              <BarChart
                data={data.popularTeeTimes}
                valueFormatter={formatNumber}
                emptyMessage="No tee times recorded."
              />
            </ChartCard>

            <ChartCard title="Busiest days of the week" subtitle="Bookings by tee-date weekday">
              <BarChart
                data={data.busiestDays}
                valueFormatter={formatNumber}
                labelFormatter={(day) => String(day).slice(0, 3)}
                emptyMessage="No dated bookings."
              />
            </ChartCard>
          </div>

          <MoneySection payments={data.payments} trade={data.trade} />
          <StaySection lodging={data.lodging} accommodation={data.accommodation} />
          <ServiceSection
            caddies={data.caddies}
            requestThemes={data.requestThemes}
            emailCoverage={data.emailCoverage}
          />
          <GuestSection guests={data.guests} responseTimes={data.responseTimes} />
        </>
      )}
    </div>
  );
}

function KpiRow({ totals }) {
  const delta = totals.delta ?? {};

  return (
    <div className="kpi-row">
      <KpiTile
        label="Total bookings"
        value={formatNumber(totals.bookings)}
        delta={delta.bookings}
        accent={PIPELINE_RAMP[1]}
      />
      <KpiTile
        label="Committed revenue"
        value={formatCurrency(totals.revenue)}
        sub="Booked only"
        delta={delta.revenue}
        accent={STATUS_COLORS.Booked}
      />
      <KpiTile
        label="Average booking value"
        value={formatCurrency(totals.averageValue)}
        delta={delta.averageValue}
        accent={PIPELINE_RAMP[2]}
      />
      <KpiTile
        label="Conversion"
        value={`${totals.conversionRate}%`}
        sub={`${formatNumber(totals.committed)} of ${formatNumber(totals.bookings)} committed`}
        accent={STATUS_COLORS.Requested}
      />
      <KpiTile
        label="Lost"
        value={`${totals.cancellationRate}%`}
        sub={`${formatNumber(totals.lost)} rejected or cancelled`}
        accent={STATUS_COLORS.Rejected}
      />
    </div>
  );
}
