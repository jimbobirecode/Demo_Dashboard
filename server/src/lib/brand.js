/**
 * The club profile, API side — the server's half of what `web/src/lib/brand.js`
 * holds for the SPA.
 *
 * Only the values the API itself needs live here: how money and dates are
 * spelled in outgoing email, and the names a guest sees on it.
 *
 * Every name is overridable from the environment, because one deployment of
 * this dashboard now serves whichever club it is pointed at. The defaults are
 * TeeMail's own, so an install that sets nothing is branded rather than blank.
 */
import { toCurrencyCode } from './currency.js';

const env = process.env;

export const BRAND = {
  clubId: env.CLUB_ID ?? 'teemail',
  name: env.CLUB_NAME ?? 'TeeMail',
  fullName: env.CLUB_FULL_NAME ?? 'TeeMail Golf Club',

  /** The sender name on customer-journey email; FROM_NAME overrides it. */
  fromName: env.FROM_NAME ?? env.CLUB_FULL_NAME ?? 'TeeMail Golf Club',

  /** Used when a booking carries no course of its own. */
  defaultCourse: env.DEFAULT_COURSE ?? 'Championship Course',

  locale: env.CLUB_LOCALE ?? 'en-GB',
  // A CLUB_CURRENCY of "€" (or a mangled one) is read as EUR, not left to crash Intl.
  currency: toCurrencyCode(env.CLUB_CURRENCY, 'EUR'),
  timeZone: env.CLUB_TIMEZONE ?? 'Europe/London',
};
