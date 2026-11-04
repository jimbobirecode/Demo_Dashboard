/**
 * The project's connection budget, and what a refusal of it looks like.
 *
 * Supabase's session-mode pooler caps a whole project at `pool_size` clients
 * -- 15 by default -- shared by every service pointed at the database, every
 * psql session and the SQL editor. Spend them all and the next connection is
 * refused with EMAXCONNSESSION: a Postgres FATAL with no table, column or
 * hint, which in a log reads like the database broke rather than like a limit
 * this deployment set for itself.
 *
 * Pure, so both the pool and the migration runner can recognise it without
 * either importing the other.
 */

/** Whether this error is the pooler refusing a connection for want of room. */
export function looksLikePoolExhaustion(err) {
  const text = String(err?.message ?? '');
  if (/EMAXCONNSESSION/.test(text) || /max clients reached/i.test(text)) return true;
  // Postgres' own limit, when something connects straight to the database
  // rather than through the pooler.
  return err?.code === '53300' || /too many clients already/i.test(text);
}

/** The project's limit as the refusal states it, or null. */
export function statedLimit(err) {
  return /pool_size:\s*(\d+)/.exec(String(err?.message ?? ''))?.[1] ?? null;
}

/**
 * The refusal in words an operator can act on: the two numbers that matter,
 * the setting on each side, and where the limit itself is raised.
 */
export function describePoolExhaustion(err, { poolMax } = {}) {
  if (!looksLikePoolExhaustion(err)) return null;
  const limit = statedLimit(err) ?? 'the project limit';
  return (
    `the database pooler refused a connection: this project allows ${limit} clients in total and they are all in use. ` +
    `This service holds up to ${poolMax ?? process.env.PGPOOL_MAX ?? 'its share'} (PGPOOL_MAX); the email bot ` +
    'has its own pool ' +
    '(MAX_DB_CONNECTIONS). A deploy runs two copies of this service at once, so the budget has to cover both, or ' +
    'raise the limit in Supabase under Settings -> Database -> Connection pooling.'
  );
}
