import { Suspense, lazy } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './lib/useSession.js';
import Login from './pages/Login.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import ManageBooking from './pages/ManageBooking.jsx';
import Bookings from './pages/Bookings.jsx';
import Emails from './pages/Emails.jsx';
import Operators from './pages/Operators.jsx';
import Reminders from './pages/Reminders.jsx';
import Users from './pages/Users.jsx';
import Waitlist from './pages/Waitlist.jsx';
import Import from './pages/Import.jsx';
import Requests from './pages/Requests.jsx';
import Inbox from './pages/Inbox.jsx';
import Portal from './pages/Portal.jsx';
import Membership from './pages/Membership.jsx';
import { useInboxCount } from './lib/useInboxCount.js';

// The charting library is only needed on the analytics route — keep it out of
// the initial bundle so the bookings table loads fast.
const Analytics = lazy(() => import('./pages/Analytics.jsx'));

import Wordmark from './components/Wordmark.jsx';

export default function App() {
  // The tour operator portal has its own sign-in and session; staff sign-in
  // never comes into it.
  const { pathname } = useLocation();
  if (pathname === '/portal' || pathname.startsWith('/portal/')) return <Portal />;
  return <StaffApp />;
}

function StaffApp() {
  const { user, mustChangePassword, loading, login, logout, completePasswordChange } = useSession();
  const [inboxCount, setInboxCount] = useInboxCount(Boolean(user) && !mustChangePassword);

  if (loading) {
    return <div className="empty">Loading dashboard…</div>;
  }

  // Signed out, the reset screens are routes of their own: an emailed link
  // lands on /reset-password directly and must not be swallowed by the login
  // form. Everything else falls back to signing in.
  if (!user) {
    return (
      <Routes>
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/manage-booking" element={<ManageBooking />} />
        {/* An invitation is the same screen and the same token — only the
            address bar differs, so it agrees with the email that sent it. */}
        <Route path="/accept-invite" element={<ResetPassword />} />
        <Route path="*" element={<Login onLogin={login} />} />
      </Routes>
    );
  }

  if (mustChangePassword) {
    return <ChangePassword onSubmit={completePasswordChange} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Wordmark />

        <div className="divider" />

        <nav className="stack" style={{ gap: '0.25rem' }}>
          <NavLink to="/bookings" className={navClass}>
            Bookings
          </NavLink>
          <NavLink to="/inbox" className={navClass}>
            Inbox
            {inboxCount > 0 && (
              <span
                aria-label={`${inboxCount} to answer`}
                style={{
                  marginLeft: '0.5rem',
                  background: 'var(--brand-gold)',
                  color: 'var(--surface-0)',
                  borderRadius: '999px',
                  padding: '0 0.45rem',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                }}
              >
                {inboxCount}
              </span>
            )}
          </NavLink>
          <NavLink to="/requests" className={navClass}>
            Guest Requests
          </NavLink>
          <NavLink to="/waitlist" className={navClass}>
            Waitlist
          </NavLink>
          <NavLink to="/membership" className={navClass}>
            Membership
          </NavLink>
          <NavLink to="/operators" className={navClass}>
            Tour Operators
          </NavLink>
          <NavLink to="/emails" className={navClass}>
            Guest Emails
          </NavLink>
          <NavLink to="/reminders" className={navClass}>
            Operator Reminders
          </NavLink>
          <NavLink to="/import" className={navClass}>
            Upload Tee Sheet
          </NavLink>
          <NavLink to="/analytics" className={navClass}>
            Analytics
          </NavLink>
          {/* Account administration is hidden from staff. The API refuses them
              too — this only saves them clicking on a page they cannot use. */}
          {user.role === 'admin' && (
            <NavLink to="/users" className={navClass}>
              Users
            </NavLink>
          )}
        </nav>

        <div style={{ marginTop: 'auto' }} className="stack">
          <div className="divider" />
          <div>
            <div style={{ fontWeight: 600 }}>{user.fullName}</div>
            <div className="muted" style={{ fontSize: '0.75rem' }}>
              {user.clubName}
            </div>
          </div>
          <NavLink to="/account/password" className={navClass}>
            Change password
          </NavLink>
          <button type="button" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <Routes>
            <Route path="/bookings" element={<Bookings user={user} />} />
            {/* A guest's link works for a signed-in member of staff too —
                they are often the one checking it. */}
            <Route path="/manage-booking" element={<ManageBooking />} />
            <Route path="/import" element={<Import user={user} />} />
            <Route
              path="/account/password"
              element={<ChangePassword requireCurrent onSubmit={completePasswordChange} />}
            />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/requests" element={<Requests />} />
            <Route path="/inbox" element={<Inbox onCountChange={setInboxCount} />} />
            <Route path="/waitlist" element={<Waitlist user={user} />} />
            <Route path="/operators" element={<Operators user={user} />} />
            <Route path="/membership" element={<Membership user={user} />} />
            <Route path="/emails" element={<Emails />} />
            <Route path="/reminders" element={<Reminders />} />
            <Route path="/users" element={user.role === 'admin' ? <Users /> : <Navigate to="/bookings" replace />} />
            {/* A signed-in reader following an old reset link goes to the
                bookings table rather than to a form they no longer need. */}
            <Route path="*" element={<Navigate to="/bookings" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

const navClass = ({ isActive }) => `nav-link${isActive ? ' active' : ''}`;
