/**
 * Booking references the dashboard issues itself (a waitlist conversion, a
 * tee-sheet row with no reference of its own), in the core API's format:
 *
 *   PREFIX-YYYYMMDD-XXXXXXXXXX
 *
 * PREFIX is the core API club profile's `booking_ref_prefix` (TMG for the
 * TeeMail Golf Club profile, RDG for the Royal Dornoch demo), the date is
 * today in the club's time zone, and the 10 characters come from [A-Z0-9]
 * through the CSPRNG — the same as `db.generate_booking_reference` and
 * `club_config.booking_ref_pattern` in the core API. Matching the format
 * matters beyond looks: the core API only recognises references of this
 * shape in a guest's email, so a reply quoting one is linked to its booking.
 *
 * The dashboard cannot read the core API's profile, so the prefix is
 * configured here as BOOKING_REF_PREFIX and must equal the core API's.
 */
import crypto from 'node:crypto';
import { BRAND } from './brand.js';

export const BOOKING_REF_RANDOM_LENGTH = 10;
export const DEFAULT_BOOKING_REF_PREFIX = 'TMG';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A reference under any prefix, as the core API's pattern accepts it (old 4-char ones too). */
export const BOOKING_REF_PATTERN = /^[A-Z]{2,6}-\d{8}-[A-Z0-9]{4,16}$/;

export function bookingRefPrefix(env = process.env) {
  const configured = String(env.BOOKING_REF_PREFIX ?? '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{2,6}$/.test(configured) ? configured : DEFAULT_BOOKING_REF_PREFIX;
}

/** YYYYMMDD of `now` in `timeZone`. */
export function datePart(now = new Date(), timeZone = BRAND.timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now)
    .replace(/-/g, '');
}

/** `length` characters from [A-Z0-9], uniformly, from the CSPRNG. */
export function randomCode(length, randomInt = crypto.randomInt) {
  let code = '';
  for (let i = 0; i < length; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export function mintBookingReference({
  now = new Date(),
  prefix = bookingRefPrefix(),
  timeZone = BRAND.timeZone,
  randomInt = crypto.randomInt,
} = {}) {
  return `${prefix}-${datePart(now, timeZone)}-${randomCode(BOOKING_REF_RANDOM_LENGTH, randomInt)}`;
}
