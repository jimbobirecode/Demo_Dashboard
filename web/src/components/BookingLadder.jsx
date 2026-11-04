import { useState } from 'react';
import { formatDate } from '../lib/format.js';

/**
 * One booking's ladder, as a flow rather than a spreadsheet.
 *
 * It was eleven rows of six columns: a trigger number, the step, a date, a
 * state, a sentence explaining the state, and a button. Four of the eleven
 * rows said "Not applicable" about steps that will never fire for this
 * booking, and most of the explanations repeated the state beside them —
 * "Done · Already done".
 *
 * The question it answers is "where has this one got to, and what happens
 * next", which is a line, not a table. So: the steps in the order they
 * happen, what is behind quiet, what is due marked, and the ones that do not
 * apply folded away until somebody asks for them.
 */
const STATE_LABELS = {
  due: 'Due',
  sent: 'Done',
  missed: 'Missed',
  skipped: 'Not applicable',
  superseded: 'Superseded',
  upcoming: 'Upcoming',
  blocked: 'Blocked',
  unknown: 'No date',
};

/** Steps that will not fire for this booking: folded away by default. */
const QUIET_STATES = ['skipped', 'superseded'];

/** Steps somebody can still take off the list. */
const CLEARABLE_STATES = ['due', 'missed', 'upcoming'];

/**
 * The state's own word carries it; a sentence that only repeats the word is
 * noise. "9 days past its date — too late to send unprompted" earns its place;
 * "Already done" beside "Done" does not.
 */
function reasonWorthSaying(step) {
  const reason = String(step.reason ?? '').trim();
  if (!reason) return '';
  const state = STATE_LABELS[step.state] ?? step.state;
  return reason.toLowerCase() === `already ${state.toLowerCase()}` ? '' : reason;
}

export default function BookingLadder({ steps, busy, onClear }) {
  const [showQuiet, setShowQuiet] = useState(false);

  const live = steps.filter((step) => !QUIET_STATES.includes(step.state));
  const quiet = steps.filter((step) => QUIET_STATES.includes(step.state));
  const shown = showQuiet ? steps : live;

  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      <div className="flow ladder">
        {shown.map((step) => (
          <Rung key={step.step} step={step} busy={busy} onClear={onClear} />
        ))}
      </div>

      {quiet.length > 0 && (
        <button
          type="button"
          className="ladder-toggle"
          aria-expanded={showQuiet}
          onClick={() => setShowQuiet(!showQuiet)}
        >
          {showQuiet
            ? 'Hide the steps that do not apply'
            : `Show ${quiet.length} step${quiet.length === 1 ? '' : 's'} that do not apply`}
        </button>
      )}
    </div>
  );
}

function Rung({ step, busy, onClear }) {
  const reason = reasonWorthSaying(step);
  return (
    <div className={`flow-step ladder-step is-${step.state}`} title={step.trigger || undefined}>
      <div className="ladder-label">{step.label}</div>
      <div className="ladder-meta">
        <span className="ladder-state">{STATE_LABELS[step.state] ?? step.state}</span>
        {step.dueOn && <span className="muted"> · {formatDate(step.dueOn)}</span>}
      </div>
      {reason && <div className="ladder-reason">{reason}</div>}
      {CLEARABLE_STATES.includes(step.state) && (
        <button
          type="button"
          className="ladder-clear"
          aria-label={`Clear ${step.label}`}
          disabled={busy}
          onClick={() => onClear(step.step)}
        >
          Clear
        </button>
      )}
    </div>
  );
}
