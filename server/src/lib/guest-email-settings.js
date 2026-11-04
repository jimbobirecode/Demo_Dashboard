/**
 * The emails this club sends guests off its own bat, per club.
 *
 * One so far: the acknowledgement a guest gets the moment they ask to move or
 * cancel a booking. It used to go out with the request itself, chosen by
 * nobody, and the club's real answer followed from the Requests page — two
 * emails about one question, the first saying nothing the page the guest had
 * just submitted did not already say. Migration 0028 makes it a switch.
 *
 * The default is off. This is a setting that exists because the sending was
 * taken away; a club that wants a guest told straight away turns it back on.
 *
 * What is NOT here: the answer itself — approved, declined, cancelled. That is
 * sent because somebody pressed a button, and a guest whose cancellation is
 * agreed has to be told.
 */
import { query } from '../db.js';

/** The migration that adds the column. Named in the error below. */
export const SETTINGS_MIGRATION = '0028_guest_request_emails_are_a_choice.sql';

/** Postgres' codes for "no such column" and "no such table". */
const UNDEFINED_COLUMN = '42703';
const UNDEFINED_TABLE = '42P01';

/** Off unless the club has said otherwise. */
export const GUEST_EMAIL_DEFAULTS = Object.freeze({ requestReceived: false });

/** The settings column is not there. Reading copes; saving says the remedy. */
export class GuestEmailSettingsMissingError extends Error {
  constructor() {
    super(
      'The guest email settings need a database column it cannot find ' +
        `(public.club_settings.guest_email_settings, from migration ${SETTINGS_MIGRATION}). ` +
        'Run "npm run migrate" against this database, then try again.',
    );
    this.name = 'GuestEmailSettingsMissingError';
    this.status = 409;
    this.migration = SETTINGS_MIGRATION;
  }
}

/** Only the keys this module knows, coerced to booleans. */
export function readGuestEmailSettings(stored) {
  const saved = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  return Object.fromEntries(
    Object.entries(GUEST_EMAIL_DEFAULTS).map(([key, fallback]) => [key, key in saved ? Boolean(saved[key]) : fallback]),
  );
}

/** What this club has settled on, with the defaults filled in. */
export async function loadGuestEmailSettings(club) {
  try {
    const { rows } = await query(`SELECT guest_email_settings FROM public.club_settings WHERE club = $1`, [club]);
    return readGuestEmailSettings(rows[0]?.guest_email_settings);
  } catch (err) {
    // A database one migration behind reads as a club that has saved nothing,
    // which is true. Saving will say what is missing.
    if (err?.code === UNDEFINED_COLUMN || err?.code === UNDEFINED_TABLE) return readGuestEmailSettings(null);
    throw err;
  }
}

/**
 * Keep only the switches this module owns, as booleans.
 *
 * Returns `{ ok, value, errors }` so a route answers 400 with a reason rather
 * than quietly writing a key nothing reads.
 */
export function validateGuestEmailSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, value: {}, errors: ['Settings must be an object'] };
  }
  const value = {};
  const errors = [];
  for (const [key, given] of Object.entries(patch)) {
    if (!(key in GUEST_EMAIL_DEFAULTS)) {
      errors.push(`${key} is not a setting`);
      continue;
    }
    if (typeof given !== 'boolean') {
      errors.push(`${key} must be true or false`);
      continue;
    }
    value[key] = given;
  }
  return { ok: errors.length === 0, value, errors };
}

/** Merge `patch` into what the club has saved, and return the result. */
export async function saveGuestEmailSettings(club, patch, username) {
  try {
    const { rows } = await query(
      `INSERT INTO public.club_settings (club, guest_email_settings, updated_at, updated_by)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (club) DO UPDATE SET
         guest_email_settings = public.club_settings.guest_email_settings || $2::jsonb,
         updated_at = NOW(),
         updated_by = $3
       RETURNING guest_email_settings`,
      [club, JSON.stringify(patch), username ?? null],
    );
    return readGuestEmailSettings(rows[0]?.guest_email_settings ?? patch);
  } catch (err) {
    if (err?.code === UNDEFINED_COLUMN) throw new GuestEmailSettingsMissingError();
    throw err;
  }
}
