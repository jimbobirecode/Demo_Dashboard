/**
 * The dashboard's line icons: one stroke weight, one grid, drawn inline.
 *
 * Inline rather than an icon font or a package, because there are two dozen of
 * them and the content security policy allows scripts and fonts from this
 * origin only. Every icon is decoration beside a written label — it is always
 * `aria-hidden`, and nothing in the dashboard is an icon alone.
 */
const PATHS = {
  bookings: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  inbox: 'M4 5h16v14H4zM4 13h5l1 2h4l1-2h5',
  requests: 'M7 7h11l-3-3M17 17H6l3 3',
  waitlist: 'M12 4a8 8 0 1 0 0 16a8 8 0 0 0 0-16zM12 8v4l3 2',
  operators: 'M4 8h16v11H4zM9 8V5h6v3',
  membership: 'M12 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8zM5 20c1-4 4-5 7-5s6 1 7 5',
  emails: 'M4 6h16v12H4zM4 7l8 6l8-6',
  status: 'M5 18h4v-4h4v-4h4V6h2',
  upload: 'M12 16V5M8 9l4-4l4 4M5 19h14',
  analytics: 'M5 19V10M12 19V5M19 19v-7',
  users: 'M9 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6zM3 19c.5-3 3-4 6-4s5.5 1 6 4M17 11a2.5 2.5 0 1 0 0-5M18 15c2 .3 3 1.5 3 4',
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14zM20 20l-4-4',
  chevronDown: 'M6 9l6 6l6-6',
  chevronLeft: 'M15 6l-6 6l6 6',
  chevronRight: 'M9 6l6 6l-6 6',
  key: 'M14 10a4 4 0 1 0-3.5 4L12 16h2v2h2v2h4v-3l-6.2-6.2c.1-.3.2-.5.2-.8z',
  signOut: 'M10 5H5v14h5M15 8l4 4l-4 4M19 12H9',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  download: 'M12 4v11M8 11l4 4l4-4M5 19h14',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l5 5l9-10',
  close: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  arrowRight: 'M5 12h14M13 6l6 6l-6 6',
  flag: 'M7 21V4l10 4l-10 4',
};

export const ICON_NAMES = Object.keys(PATHS);

export default function Icon({ name, size = 17, strokeWidth = 1.8 }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg
      className="icon"
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}
