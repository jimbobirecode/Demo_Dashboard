import { formatNumber } from '../../lib/format.js';
import { INK_MUTED, SERIES, STATUS_COLORS } from '../../lib/palette.js';
import { BarChart, BarList, CategoryBar, ChartCard, TableView } from '../charts/index.js';
import { Figure, NotRecorded, Section } from './Section.jsx';

/**
 * What the party asked the club to arrange, and whether the campaigns that
 * were meant to reach them did.
 *
 * Both read fields the enquiry form writes as free text, so the cards are
 * careful to say what they are counting: a caddie estimate is an estimate, and
 * a theme is a keyword match rather than a category anybody chose.
 */
export default function ServiceSection({ caddies, requestThemes, emailCoverage }) {
  return (
    <>
      <Section
        title="What the party asked for"
        blurb="Caddies, the notes people leave on an enquiry, and whether the journey emails reached them"
      />

      <div className="chart-grid">
        <ChartCard
          title="Caddie demand"
          subtitle={`${caddies.attachRate}% of parties ask for caddies · ${formatNumber(caddies.recorded)} recorded an answer either way`}
          footer={
            <TableView
              label="the numbers"
              columns={[
                { key: 'key', header: 'Caddies' },
                { key: 'count', header: 'Bookings', numeric: true },
                { key: 'players', header: 'Players', numeric: true },
              ]}
              rows={caddies.distribution}
            />
          }
        >
          <div className="stack" style={{ gap: '1rem' }}>
            <BarChart
              data={caddies.distribution}
              layout="vertical"
              colorFor={(row) => (row.key === 'Not specified' ? INK_MUTED : SERIES)}
              valueFormatter={formatNumber}
              tooltipRows={(row) => [
                { label: 'Bookings', value: formatNumber(row.count), color: SERIES },
                { label: 'Players', value: formatNumber(row.players) },
              ]}
              emptyMessage="No booking in this period records a caddie requirement."
            />
            <div className="detail-grid">
              <Figure
                label="Caddies asked for"
                value={`≈ ${formatNumber(caddies.estimatedCaddies)}`}
                sub="Estimated: the number in the note, or the whole party where it says everyone"
              />
              <Figure
                label="Players in those parties"
                value={formatNumber(caddies.playersInRequests)}
              />
            </div>
          </div>
        </ChartCard>

        <ChartCard
          title="What people write in"
          subtitle={`${requestThemes.rate}% of enquiries leave a note — a booking counts toward every theme it mentions, so these do not sum`}
          footer={
            <TableView
              label="the numbers"
              columns={[
                { key: 'key', header: 'Theme' },
                { key: 'count', header: 'Bookings', numeric: true },
              ]}
              rows={requestThemes.themes}
            />
          }
        >
          <BarList
            data={requestThemes.themes}
            color={SERIES}
            valueFormatter={formatNumber}
            emptyMessage="No special requests recorded in this period."
          />
        </ChartCard>

        <ChartCard
          title="Journey email coverage"
          subtitle="Committed bookings the pre-arrival and post-play emails actually reached"
          footer={
            emailCoverage.tracked && (
              <TableView
                label="the numbers"
                columns={[
                  { key: 'key', header: 'Campaign' },
                  { key: 'eligible', header: 'Owed', numeric: true },
                  { key: 'sent', header: 'Sent', numeric: true },
                  { key: 'missed', header: 'Not sent', numeric: true },
                  { key: 'rate', header: 'Coverage', numeric: true, render: (r) => `${r.rate}%` },
                ]}
                rows={emailCoverage.campaigns}
              />
            )
          }
        >
          {emailCoverage.tracked ? (
            <div className="stack" style={{ gap: '1.25rem' }}>
              {emailCoverage.campaigns.map((campaign) => (
                <div key={campaign.key} className="stack" style={{ gap: '0.4rem' }}>
                  <div className="label">
                    {campaign.key} — {campaign.rate}%
                  </div>
                  <CategoryBar
                    value={campaign.sent}
                    total={campaign.eligible}
                    label="Sent"
                    remainderLabel="Not sent"
                    color={STATUS_COLORS.Booked}
                  />
                </div>
              ))}
            </div>
          ) : (
            <NotRecorded>
              Nothing in this period records a send. Journey emails are sent from the Guest
              Emails page.
            </NotRecorded>
          )}
        </ChartCard>
      </div>
    </>
  );
}
