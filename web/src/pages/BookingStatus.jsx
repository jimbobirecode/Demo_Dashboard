import { Link } from 'react-router-dom';
import Workflow from './Workflow.jsx';

/**
 * Booking Status: what every booking is waiting on, in one place.
 *
 * The ladder each booking climbs — the deposit chase, the confirmations, the
 * thank you — with what is due, what was missed, and the whole ladder for any
 * booking. It replaced two pages: the Booking Workflow, which it is, and the
 * Operator Reminders, whose job the ladder now does itself (a trade booking is
 * chased at the account, on the account's own terms; see BOOKING_TRIGGERS.md).
 * Both old paths redirect here (App.jsx).
 */
export default function BookingStatus() {
  return (
    <div className="stack">
      <div>
        <h1>Booking Status</h1>
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          What each booking is waiting on, and the emails due to go out about it. Timings are set under{' '}
          <Link to="/settings">Settings</Link>.
        </p>
      </div>

      <Workflow embedded />
    </div>
  );
}
