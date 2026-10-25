import { Link } from 'react-router-dom';
import LifecycleSettings from '../components/LifecycleSettings.jsx';

/**
 * The club's own settings.
 *
 * One section so far — the booking lifecycle — but a section rather than a
 * page of its own, because this is where the next one goes too. Membership
 * keeps its settings on the Membership page for now; moving them here is a
 * change to a working screen and belongs in its own piece of work, not
 * smuggled into this one.
 *
 * Reading is open to anyone signed in; saving is an administrator's. That
 * split is deliberate rather than incidental: everybody on the desk should be
 * able to see why a guest was chased on a Tuesday, and far fewer people
 * should be able to change it.
 */
export default function Settings() {
  return (
    <div className="stack">
      <div>
        <h1>Settings</h1>
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          How this club works, as opposed to what it is doing today. For the bookings the lifecycle has stopped at, and
          for a dry run, see <Link to="/lifecycle">Booking Lifecycle</Link>.
        </p>
      </div>

      {/* Whether this user may save is the server's answer, carried on the
          settings it returns — not this component's guess from the role. */}
      <LifecycleSettings />
    </div>
  );
}
