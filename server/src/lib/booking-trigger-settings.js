/**
 * The booking trigger workflow's settings, per club.
 *
 * The switches and the deadlines started life in the environment (see
 * `readTriggerConfig`), which is where a deployer sets things and nobody at the
 * club can reach. Migration 0027 gives each club a JSONB column of its own in
 * `club_settings`, and this module reads and writes it. The environment stays
 * as the fallback: a key the club has never saved inherits whatever the
 * deployer set, so an install configured by environment carries on exactly as
 * it did until somebody presses Save.
 */
import { query } from '../db.js';
import { readTriggerConfig } from './booking-triggers-domain.js';

/** The migration that adds the column. Named in the error below. */
export const SETTINGS_MIGRATION = '0027_trigger_settings_and_auto_chase.sql';

/** Postgres' code for "column does not exist". */
const UNDEFINED_COLUMN = '42703';

/**
 * The settings column is not there.
 *
 * Reading copes without it — no column means nothing saved, and the
 * environment decides, which is exactly the state before the migration. Saving
 * cannot, and says so with the remedy rather than a bare 500.
 */
export class SettingsMissingError extends Error {
  constructor() {
    super(
      'The booking trigger settings need a database column it cannot find ' +
        `(public.club_settings.trigger_settings, from migration ${SETTINGS_MIGRATION}). ` +
        'Run "npm run migrate" against this database, then try again.',
    );
    this.name = 'SettingsMissingError';
    this.status = 409;
    this.migration = SETTINGS_MIGRATION;
  }
}

/** What this club has saved: an object of the keys it has set, or `{}`. */
export async function loadTriggerSettings(club) {
  try {
    const { rows } = await query(`SELECT trigger_settings FROM public.club_settings WHERE club = $1`, [club]);
    const stored = rows[0]?.trigger_settings;
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch (err) {
    // A database one migration behind reads as a club that has saved nothing,
    // which is true. The page will say what is missing the moment it saves.
    if (err?.code === UNDEFINED_COLUMN || err?.code === '42P01') return {};
    throw err;
  }
}

/**
 * Merge `patch` into what the club has saved, and return the result.
 *
 * A merge, not a replacement: the settings page sends only the keys that
 * changed, and the ones it did not mention must survive. `patch` is expected
 * to have been through `validateTriggerSettings` already.
 */
export async function saveTriggerSettings(club, patch, username) {
  try {
    const { rows } = await query(
      `INSERT INTO public.club_settings (club, trigger_settings, updated_at, updated_by)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (club) DO UPDATE SET
         trigger_settings = public.club_settings.trigger_settings || $2::jsonb,
         updated_at = NOW(),
         updated_by = $3
       RETURNING trigger_settings`,
      [club, JSON.stringify(patch), username ?? null],
    );
    return rows[0]?.trigger_settings ?? patch;
  } catch (err) {
    if (err?.code === UNDEFINED_COLUMN) throw new SettingsMissingError();
    throw err;
  }
}

/** The workflow as this club has it: the environment with the club's own saves laid over it. */
export async function clubTriggerConfig(club, env = process.env) {
  return readTriggerConfig(env, await loadTriggerSettings(club));
}
