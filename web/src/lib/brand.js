/**
 * Everything club-specific in one place. The colour tokens live at the top of `theme.css`; this file
 * carries the names, the mark and the wording that changes per customer.
 *
 * Each value can be set at build time (`VITE_CLUB_NAME` and friends) because
 * one codebase now serves whichever club it is built for. The defaults are
 * TeeMail's own, so a build that sets nothing is branded rather than blank.
 * The server has a matching set — see `server/src/lib/brand.js`.
 */
const env = import.meta.env ?? {};

export const BRAND = {
  name: env.VITE_CLUB_NAME ?? 'TeeMail',
  fullName: env.VITE_CLUB_FULL_NAME ?? 'TeeMail Golf Club',
  tagline: env.VITE_CLUB_TAGLINE ?? 'Visitor Bookings',

  /** Served from `web/public`. Set to null to fall back to the wordmark. */
  logoUrl: env.VITE_CLUB_LOGO ?? '/logo.png',
  /**
   * Whether the artwork already reads on a dark surface. When false the mark
   * is given a light plate, which is what a dark-on-transparent logo needs.
   */
  logoOnDark: env.VITE_CLUB_LOGO_ON_DARK === 'true',

  /** What the stay is called on screen: 'Accommodation' here, 'Lodging' at a resort with its own rooms. */
  lodgingLabel: 'Accommodation',

  locale: env.VITE_CLUB_LOCALE ?? 'en-GB',
  currency: env.VITE_CLUB_CURRENCY ?? 'EUR',
  timeZone: env.VITE_CLUB_TIMEZONE ?? 'Europe/London',
};
