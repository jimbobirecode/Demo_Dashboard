import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
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
import BookingStatus from './pages/BookingStatus.jsx';
import Settings from './pages/Settings.jsx';
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
import Icon from './components/Icon.jsx';
import UserMenu from './components/UserMenu.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import { ToastProvider } from './lib/toast.jsx';

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
    <ToastProvider>
      <Shell
        user={user}
        logout={logout}
        inboxCount={inboxCount}
        setInboxCount={setInboxCount}
        completePasswordChange={completePasswordChange}
      />
    </ToastProvider>
  );
}

/**
 * The menu, as data: one list drives the sidebar and the command palette, so a
 * page cannot be in one and missing from the other.
 */
const NAV = [
  {
    group: 'Bookings',
    items: [
      { to: '/bookings', label: 'Bookings', icon: 'bookings' },
      { to: '/inbox', label: 'Inbox', icon: 'inbox', badge: 'inbox' },
      { to: '/requests', label: 'Guest Requests', icon: 'requests' },
      { to: '/waitlist', label: 'Waitlist', icon: 'waitlist' },
    ],
  },
  {
    group: 'Accounts',
    items: [
      { to: '/operators', label: 'Tour Operators', icon: 'operators' },
      { to: '/membership', label: 'Membership', icon: 'membership' },
    ],
  },
  {
    group: 'Outreach',
    items: [
      { to: '/emails', label: 'Guest Emails', icon: 'emails' },
      { to: '/booking-status', label: 'Booking Status', icon: 'status' },
    ],
  },
  {
    group: 'Records',
    items: [
      { to: '/import', label: 'Upload Tee Sheet', icon: 'upload' },
      { to: '/analytics', label: 'Analytics', icon: 'analytics' },
    ],
  },
  {
    group: 'Admin',
    items: [
      // Account administration is hidden from staff. The API refuses them
      // too — this only saves them clicking on a page they cannot use.
      { to: '/users', label: 'Users', icon: 'users', adminOnly: true },
      { to: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

/** The groups a user can see, without the pages they cannot. */
export function navFor(user) {
  return NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.adminOnly || user?.role === 'admin'),
  })).filter((section) => section.items.length);
}

/** ⌘ on a Mac, Ctrl everywhere else — said the way the keyboard says it. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

function Shell({ user, logout, inboxCount, setInboxCount, completePasswordChange }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sections = useMemo(() => navFor(user), [user]);
  const pages = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  // Ctrl/⌘ K from anywhere, including inside a field: it is a chord nobody
  // types by accident, and the palette is most wanted mid-task.
  useEffect(() => {
    function onKey(event) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Wordmark />

        <nav className="sidebar-nav" aria-label="Main">
          {sections.map((section) => (
            <div key={section.group} className="nav-section">
              <div className="nav-group">{section.group}</div>
              {section.items.map((item) => (
                <NavLink key={item.to} to={item.to} className={navClass}>
                  <Icon name={item.icon} />
                  <span className="nav-label">{item.label}</span>
                  {item.badge === 'inbox' && inboxCount > 0 && (
                    <span className="nav-badge" aria-label={`${inboxCount} to answer`}>
                      {inboxCount}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="app-body">
        <header className="topbar">
          <button type="button" className="search-trigger" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={16} />
            <span>Search bookings and pages</span>
            <kbd>{IS_MAC ? '⌘' : 'Ctrl'} K</kbd>
          </button>
          <UserMenu user={user} onSignOut={logout} />
        </header>

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
              <Route path="/booking-status" element={<BookingStatus />} />
              <Route path="/settings" element={<Settings />} />
              {/* The two pages Booking Status replaced. Old bookmarks still land. */}
              <Route path="/workflow" element={<Navigate to="/booking-status" replace />} />
              <Route path="/reminders" element={<Navigate to="/booking-status" replace />} />
              <Route path="/users" element={user.role === 'admin' ? <Users /> : <Navigate to="/bookings" replace />} />
              {/* A signed-in reader following an old reset link goes to the
                  bookings table rather than to a form they no longer need. */}
              <Route path="*" element={<Navigate to="/bookings" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} pages={pages} />
    </div>
  );
}

const navClass = ({ isActive }) => `nav-link${isActive ? ' active' : ''}`;
