import fs from 'node:fs';
import pg from 'pg';
import { logger } from './lib/logger.js';
import { databaseOptions, describeConnection, passwordHasOuterWhitespace } from './lib/db-ssl.js';
import { describePoolExhaustion as describeExhaustion } from './lib/db-budget.js';

const log = logger.child('db');

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  log.warn('DATABASE_URL is not set — database queries will fail.');
}

/** The CA bundle PGSSLROOTCERT names, or null (with a warning) if it cannot be read. */
export function readCaFile(file) {
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  log.warn(`PGSSLROOTCERT=${file} does not exist; the certificate will not be verified against it.`);
  return null;
}

// TLS for any non-local host, whatever the URL says: see lib/db-ssl.js.
const options = databaseOptions(process.env.DATABASE_URL, process.env, readCaFile);
// User and host, never the password: on a managed host the wrong one of several
// connection strings is the likeliest reason the server will not start, and the
// failure surfaces from the migration runner rather than from here.
log.info(`database: connecting as ${describeConnection(process.env.DATABASE_URL)}`);
if (passwordHasOuterWhitespace(process.env.DATABASE_URL)) {
  log.warn(
    "database: DATABASE_URL's password begins or ends with whitespace — a stray space or newline from " +
      'pasting it in. Postgres will reject it as a wrong password, with everything else looking correct.',
  );
}
if (options.mode === 'encrypt') {
  log.info('database: TLS without certificate verification (set PGSSLROOTCERT or DATABASE_SSL_VERIFY=true to verify)');
} else if (options.mode === 'disabled') {
  log.warn('database: TLS disabled by DATABASE_SSL=disable for a remote host');
}

/**
 * How many connections this service may hold at once.
 *
 * This is a SHARE of a fixed budget, not a performance dial. Supabase's
 * session-mode pooler caps a project at pool_size clients in total -- 15 by
 * default -- and that total is spent by every service pointed at the database,
 * not by this one alone. County Louth runs two: this dashboard and the email
 * bot. The bot's own pool is set in db_utils.py, and the two have to add up to
 * less than the project's cap with room left over for a migration run, a psql
 * session or the Supabase SQL editor.
 *
 * It used to default to 10 here and 20 in the bot: 30 against a budget of 15.
 * Nothing failed while both were quiet, because neither opened everything it
 * was allowed to. When they were both busy at once the pooler started refusing
 * connections with EMAXCONNSESSION, and because the refusal hits any query --
 * including the one that loads the signed-in user -- the whole dashboard went
 * blank at once rather than one page breaking.
 *
 * Five each then looked like it left five spare, and a deploy still ran out:
 * Render keeps the OLD instance serving until the new one passes its health
 * check, so for the length of a deploy there are TWO copies of this service
 * against the same budget. Five, five and the bot's five is the whole 15, with
 * nothing left for the migration run the new copy does before it can listen --
 * which is where it failed, taking the deploy with it, and again on each
 * restart.
 *
 * So the share is three: three, three and the bot's five leaves four, enough
 * for a migration run, a psql session and the SQL editor. Raise PGPOOL_MAX
 * only after raising the project's pool size to match (Supabase: Settings ->
 * Database -> Connection pooling), and raise it knowing a deploy doubles it.
 */
const POOL_MAX = Number(process.env.PGPOOL_MAX ?? 3);

export const pool = new Pool({
  connectionString: options.connectionString,
  ssl: options.ssl,
  max: POOL_MAX,
  idleTimeoutMillis: 30_000,
  // Fail in ten seconds with a reason rather than hanging until the request
  // times out: a saturated pool should look like a saturated pool in the log.
  connectionTimeoutMillis: 10_000,
});

log.info(`database: pool of ${POOL_MAX} connection(s) (PGPOOL_MAX)`);

/**
 * EMAXCONNSESSION reads as a Postgres FATAL with no table, column or hint, so
 * it looks like a database fault rather than a budget this deployment set for
 * itself. Said once, plainly, with the two numbers that matter.
 */
export function describePoolExhaustion(err) {
  return describeExhaustion(err, { poolMax: POOL_MAX });
}

pool.on('error', (err) => {
  const exhausted = describePoolExhaustion(err);
  if (exhausted) log.error(exhausted);
  else log.error('idle client error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}
