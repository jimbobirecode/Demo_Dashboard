/**
 * What actually happens to a booking, drawn.
 *
 * This is the part of the settings page that does the explaining. Four
 * switches and eight numbers describe the same thing, but nobody reads a
 * cadence out of a grid of inputs — they read it out of a line of days with
 * the emails hung off it, which is what this is.
 *
 * It is driven by the draft settings, not the saved ones, so it answers the
 * question being asked while somebody is editing: "if I change this to 14,
 * what does the guest actually get?"
 */
const UNPAID = 'var(--status-rejected)';
const PAID = 'var(--status-booked)';

/** The unpaid story, as a run of days from the booking. */
export function chaseSteps(settings, mode) {
  const window = Number(settings.depositWindowDays);
  const reminder = Number(settings.depositReminderDay);
  const rescue = Number(settings.depositRescueDay);
  if (![window, reminder, rescue].every(Number.isFinite)) return [];

  const steps = [
    { day: 0, what: 'Payment link', detail: `We ask for the deposit, due within ${window} days` },
    { day: reminder, what: 'Reminder', detail: 'Still nothing paid' },
    { day: window - 1, what: 'Last chance', detail: '24 hours before the deadline' },
    { day: window, what: 'Deadline passed', detail: 'We warn them and offer a way to save it' },
  ];

  // The final warnings and the cancellation only exist in the modes that
  // allow a booking to be stopped. Showing them regardless would promise
  // something the club has not switched on.
  if (mode !== 'chase_forever') {
    steps.push(
      { day: rescue - 2, what: 'Final notice', detail: '48 hours left' },
      { day: rescue - 1, what: 'Final notice', detail: '24 hours left' },
    );
    steps.push(
      mode === 'cancel'
        ? { day: rescue, what: 'Cancelled', detail: 'The booking is cancelled and they are told', end: true }
        : { day: rescue, what: 'Stops here', detail: 'We wait for you to decide. Nothing is emailed', end: true },
    );
  }

  return steps.sort((a, b) => a.day - b.day);
}

/** The paid story, as a run of days around the play date. */
export function playSteps(settings) {
  const confirmation = Number(settings.confirmationDaysBeforePlay);
  const details = Number(settings.finalDetailsDaysBeforePlay);
  const after = Number(settings.postPlayDaysAfterPlay);
  if (![confirmation, details, after].every(Number.isFinite)) return [];

  return [
    { when: 'As soon as they pay', what: 'Receipt', detail: 'With the terms for the next stage' },
    { when: `${confirmation} days before`, what: 'Confirmation', detail: 'Everything they need to know' },
    { when: `${details} days before`, what: 'Final details', detail: 'Arrival information' },
    {
      when: after === 0 ? 'On the day' : `${after} day${after === 1 ? '' : 's'} after`,
      what: 'Thank you',
      detail: 'And anything else the club wants to say',
    },
  ];
}

export default function LifecycleTimeline({ settings, mode }) {
  const chase = chaseSteps(settings, mode);
  const play = playSteps(settings);

  if (!chase.length) {
    return <p className="muted">Fill the timings in below and this will show what a guest receives.</p>;
  }

  return (
    <div className="stack" style={{ gap: '1.25rem' }}>
      <Track
        title="If they do not pay"
        colour={UNPAID}
        caption="Counted from the day the booking is made."
        items={chase.map((step) => ({
          when: step.day === 0 ? 'Straight away' : `Day ${step.day}`,
          ...step,
        }))}
        off={mode === 'off'}
      />

      <Track
        title="If they pay"
        colour={PAID}
        caption="The chasing stops the moment any money arrives — there is nothing to press."
        items={play}
        off={mode === 'off'}
      />
    </div>
  );
}

function Track({ title, colour, caption, items, off }) {
  return (
    <div className="stack" style={{ gap: '0.5rem', opacity: off ? 0.45 : 1 }}>
      <div>
        <strong style={{ color: colour }}>{title}</strong>
        <p className="muted" style={{ margin: '0.1rem 0 0', fontSize: '0.8125rem' }}>
          {caption}
        </p>
      </div>

      <ol
        className="stack"
        style={{ gap: 0, margin: 0, padding: 0, listStyle: 'none', borderLeft: `2px solid ${colour}` }}
      >
        {items.map((item, index) => (
          <li
            key={`${item.what}-${item.when}-${index}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '8.5rem 1fr',
              gap: '0.75rem',
              padding: '0.4rem 0 0.4rem 0.85rem',
            }}
          >
            <span className="timeline-when" style={{ fontWeight: 600 }}>
              {item.when}
            </span>
            <span>
              <span style={{ fontWeight: item.end ? 700 : 500, color: item.end ? colour : undefined }}>
                {item.what}
              </span>
              <span className="muted" style={{ fontSize: '0.8125rem' }}>
                {' — '}
                {item.detail}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
