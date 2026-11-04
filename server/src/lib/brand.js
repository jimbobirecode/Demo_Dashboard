/**
 * The club profile, API side — the server's half of what `web/src/lib/brand.js`
 * holds for the SPA.
 *
 * Only the values the API itself needs live here: how money and dates are
 * spelled in outgoing email, the names a guest sees on it, and the contact
 * details the footer carries.
 *
 * Every value is overridable from the environment, because one deployment of
 * this dashboard serves whichever club it is pointed at. THE DEFAULTS ARE
 * TEEMAIL'S, because this is the demo install: it is not any one club's
 * dashboard, and it is what a prospective club is shown before it has an
 * environment of its own.
 *
 * That is the one deliberate difference from Dashboard_Beta, which is County
 * Louth's single-club install and therefore defaults to County Louth. The
 * lesson that drove it still applies here: a confirmation once went out signed
 * with the wrong club's name because a service was missing CLUB_FULL_NAME and
 * nothing minded. On a real club's install the fallback should be that club;
 * on this one there is no such club, so it stays the vendor — and any club
 * served from here must set the CLUB_* variables rather than inherit them.
 */
import { toCurrencyCode } from './currency.js';

const env = process.env;

/** Where the dashboard lives when APP_URL / PUBLIC_URL say nothing. */
export const DEFAULT_APP_URL = 'https://democlub.teemail.io';

/**
 * The dashboard's public address: what every emailed link - invitations,
 * password resets, manage-booking links, the logo - is built on. APP_URL
 * (or PUBLIC_URL) wins; without either it is this dashboard, never a blank
 * that would put a relative, useless link in an email.
 *
 * A setting with no scheme is given https://. Without that, APP_URL set to
 * "democlub.teemail.io" produced href="democlub.teemail.io/manage-..."
 * — which a mail client reads as a path relative to wherever it thinks it is,
 * so every manage-booking link in every email was dead, and looked fine in
 * the source. A hostname is what someone types when asked for an address, so
 * it is accepted rather than punished.
 */
export function appBaseUrl(source = env) {
  const configured = String(source.APP_URL || source.PUBLIC_URL || '').trim();
  const base = (configured || DEFAULT_APP_URL).replace(/\/+$/, '');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : `https://${base}`;
}

export const BRAND = {
  clubId: env.CLUB_ID ?? 'teemail',
  /** The short name, on screen and in a subject line. */
  name: env.CLUB_NAME ?? 'TeeMail',
  /** The formal name, on anything a guest reads. */
  fullName: env.CLUB_FULL_NAME ?? 'TeeMail Golf Club',

  /** The sender name on customer-journey email; FROM_NAME overrides it. */
  fromName: env.FROM_NAME ?? env.CLUB_FULL_NAME ?? 'TeeMail Golf Club',

  /** Used when a booking carries no course of its own. */
  defaultCourse: env.DEFAULT_COURSE ?? 'Championship Course',

  /**
   * The footer's contact line. Read through here rather than straight from
   * the environment so an unset variable drops the club's own details, not
   * the line itself — a footer with no address on it is how an email stops
   * looking like it came from a golf club at all.
   *
   * The demo has no real premises, so these are the vendor's own and a club
   * served from this deployment is expected to set CLUB_PHONE, CLUB_ADDRESS
   * and CLUB_WEBSITE to its own.
   */
  phone: env.CLUB_PHONE ?? '+44 20 7946 0000',
  address: env.CLUB_ADDRESS ?? 'TeeMail Golf Club, London, United Kingdom',
  website: env.CLUB_WEBSITE ?? 'https://www.teemail.io',

  locale: env.CLUB_LOCALE ?? 'en-GB',
  // A CLUB_CURRENCY of "€" (or a mangled one) is read as EUR, not left to crash Intl.
  currency: toCurrencyCode(env.CLUB_CURRENCY, 'EUR'),
  timeZone: env.CLUB_TIMEZONE ?? 'Europe/London',
};
