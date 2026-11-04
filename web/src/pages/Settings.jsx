import { Link } from 'react-router-dom';
import GuestEmailSettings from '../components/GuestEmailSettings.jsx';
import TriggerSettings from '../components/TriggerSettings.jsx';

/**
 * The club's own settings.
 *
 * Two sections — chasing unpaid bookings, and what goes to a guest without
 * anybody pressing a button — and room for the next one. Membership
 * keeps its settings on the Membership page for now; moving them here is a
 * change to a working screen and belongs in its own piece of work.
 *
 * Reading is open to anyone signed in; saving is an administrator's. That
 * split is deliberate: everybody on the desk should be able to see why a
 * guest was chased on a Tuesday, and far fewer people should be able to
 * change it.
 */
export default function Settings() {
  return (
    <div className="stack">
      <div>
        <h1>Settings</h1>
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          How this club works, rather than what it is doing today. To see which bookings are waiting on you right now,
          go to <Link to="/booking-status">Booking Status</Link>.
        </p>
      </div>

      {/* Whether this user may save is the server's answer, carried on the
          settings it returns — not this component's guess from the role. */}
      <TriggerSettings />
      <GuestEmailSettings />
    </div>
  );
}
