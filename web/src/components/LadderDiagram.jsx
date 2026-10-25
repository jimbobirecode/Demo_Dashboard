/**
 * The lifecycle ladder, drawn so somebody who has only ever seen the
 * spreadsheet recognises it.
 *
 * Three phases in the order a booking meets them, each rung on its own line
 * with the day it falls due written out in words rather than as an offset.
 * "Day 7" and "10 days before the balance deadline" are what a person asks
 * about; `anchor: 'balanceDue', offset: -10` is not.
 *
 * Every rung says whether it has a template, because a rung without one is
 * silently skipped — that is the single most likely reason for a club to
 * think the ladder is broken, so it is on the face of the page rather than in
 * a log.
 */
const PHASES = [
  {
    id: 'payment',
    title: 'Payment',
    blurb: 'Chasing the deposit, from the day the booking was taken.',
  },
  {
    id: 'balance',
    title: 'Balance',
    blurb: 'Trade bookings only, counted back from the balance deadline. A visitor pays once.',
  },
  {
    id: 'communication',
    title: 'Run-up to the tee',
    blurb: 'What a booking that is paid for receives before and after play.',
  },
];

/** The day a rung falls due, in words. */
export function rungTiming(rung) {
  const { anchor, offset } = rung;

  if (anchor === 'paidOn') return 'When a payment arrives';
  if (anchor === 'lifecycle') return offset === 0 ? 'Straight away' : `Day ${offset}`;

  const subject = anchor === 'balanceDue' ? 'the balance deadline' : 'play';
  if (offset === 0) return anchor === 'balanceDue' ? 'On the deadline' : 'On the day of play';
  const days = Math.abs(offset);
  const unit = days === 1 ? 'day' : 'days';
  return offset < 0 ? `${days} ${unit} before ${subject}` : `${days} ${unit} after ${subject}`;
}

export default function LadderDiagram({ ladder = [], highlight = null }) {
  if (!ladder.length) {
    return <p className="muted">The ladder is switched off, so it has no rungs.</p>;
  }

  return (
    <div className="stack" style={{ gap: '1.25rem' }}>
      {PHASES.map((phase) => {
        const rungs = ladder.filter((rung) => rung.phase === phase.id);
        if (!rungs.length) return null;

        return (
          <div key={phase.id} className="stack" style={{ gap: '0.5rem' }}>
            <div>
              <span className="label">{phase.title}</span>
              <p className="muted" style={{ margin: '0.15rem 0 0', fontSize: '0.8125rem' }}>
                {phase.blurb}
              </p>
            </div>

            <ul className="timeline">
              {rungs.map((rung) => (
                <li key={rung.key} style={highlight === rung.key ? { fontWeight: 600 } : undefined}>
                  <span className="timeline-when">{rungTiming(rung)}</span>
                  <span>
                    {rung.label}
                    {rung.cancels && (
                      <span
                        className="tag"
                        style={{
                          marginLeft: '0.4rem',
                          color: 'var(--status-rejected)',
                          borderColor: 'var(--status-rejected)',
                        }}
                        title="This rung cancels the booking"
                      >
                        cancels
                      </span>
                    )}
                    {!rung.flows.includes('visitor') && (
                      <span className="tag" style={{ marginLeft: '0.4rem' }} title="Trade bookings only">
                        trade only
                      </span>
                    )}
                    {!rung.flows.includes('operator') && (
                      <span className="tag" style={{ marginLeft: '0.4rem' }} title="Visitor bookings only">
                        visitors only
                      </span>
                    )}
                    {!rung.configured && (
                      <span className="muted" style={{ marginLeft: '0.4rem', fontSize: '0.75rem' }}>
                        · no email template yet, so it is skipped
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
