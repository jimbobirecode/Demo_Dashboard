/**
 * Versioned schema migrations.
 *
 *   npm run migrate              apply every pending migration
 *   npm run migrate -- --status  list applied and pending migrations, change nothing
 *
 * Migrations are the numbered files in db/migrations (NNNN_name.sql), applied
 * in order, each in its own transaction, and recorded in schema_migrations
 * with a checksum of the file. The server runs this before it starts
 * listening, so code can rely on the schema the migrations describe.
 *
 * - A pg advisory lock serialises runners, so two instances booting together
 *   cannot both apply the same file; the second waits, then finds nothing to do.
 * - Editing a file that has already been applied is an error: the checksum no
 *   longer matches what the database ran. Add a new migration instead.
 * - A file must not manage its own transaction (BEGIN/COMMIT): the runner
 *   wraps it, so a failure leaves nothing half-applied.
 *
 * Plain `pg` on purpose: the whole mechanism is this file, and a dependency
 * would bring its own migration table and conventions for no extra safety.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { logger } from '../lib/logger.js';
import { databaseOptions } from '../lib/db-ssl.js';

const log = logger.child('migrate');

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/** Arbitrary but fixed: every runner against this database contends for it. */
const LOCK_KEY = 7_311_420_042;

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const OWN_TRANSACTION = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im;

export class MigrationError extends Error {}

/** CRLF and LF checkouts of the same file must agree. */
export function checksum(sql) {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/** Every migration file, in order, with its contents and checksum. */
export function readMigrations(dir = MIGRATIONS_DIR) {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const seen = new Map();

  return files.map((file) => {
    const match = FILE_PATTERN.exec(file);
    if (!match) {
      throw new MigrationError(`${file}: migration files are named NNNN_lower_snake_name.sql`);
    }
    const version = Number(match[1]);
    if (seen.has(version)) {
      throw new MigrationError(`${file}: version ${match[1]} is also used by ${seen.get(version)}`);
    }
    seen.set(version, file);

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    if (OWN_TRANSACTION.test(sql)) {
      throw new MigrationError(`${file}: remove BEGIN/COMMIT — each migration already runs in its own transaction`);
    }
    return { version, name: match[2], file, sql, checksum: checksum(sql) };
  });
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INTEGER
    )`);
}

async function appliedVersions(client) {
  const { rows } = await client.query(
    'SELECT version, name, checksum, applied_at FROM public.schema_migrations ORDER BY version',
  );
  return new Map(rows.map((row) => [row.version, row]));
}

/** Applied and pending, compared against the files, failing on any edited file. */
function plan(migrations, applied) {
  const known = new Set(migrations.map((m) => m.version));
  for (const [version, row] of applied) {
    if (!known.has(version)) {
      // A newer release may have applied it (a rollback to older code); that
      // code keeps working, so this is worth a warning, not a refusal.
      log.warn(`schema_migrations has version ${version} (${row.name}) but no such file exists here`);
    }
  }

  const pending = [];
  for (const migration of migrations) {
    const row = applied.get(migration.version);
    if (!row) {
      pending.push(migration);
    } else if (row.checksum !== migration.checksum) {
      throw new MigrationError(
        `${migration.file} has changed since it was applied on ${new Date(row.applied_at).toISOString()} ` +
          '(checksum mismatch). Applied migrations must not be edited — revert the file and add a new migration.',
      );
    }
  }
  return pending;
}

async function apply(client, migration) {
  const started = Date.now();
  await client.query('BEGIN');
  try {
    // A migration that cannot get its lock should fail the deploy, not hang it
    // behind a long-running transaction.
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query(migration.sql);
    await client.query(
      'INSERT INTO public.schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
      [migration.version, migration.name, migration.checksum, Date.now() - started],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const where = err.position ? ` (at character ${err.position})` : '';
    const wrapped = new MigrationError(`${migration.file} failed${where}: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }
  log.info(`applied ${migration.file} in ${Date.now() - started}ms`);
}

/** pg options for a URL: TLS for remote hosts, as the server's own pool (lib/db-ssl.js). */
function connectionOptions(url) {
  const { connectionString, ssl } = databaseOptions(url, process.env, (file) =>
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
  );
  return { connectionString, ssl };
}

/**
 * Apply every pending migration. Pass a pg Pool or a connection string; with
 * neither, DATABASE_URL is used. Resolves to the list of files applied.
 */
export async function migrate({ pool, connectionString, dir = MIGRATIONS_DIR, statusOnly = false } = {}) {
  const migrations = readMigrations(dir);
  const ownPool = pool
    ? null
    : new pg.Pool({ ...connectionOptions(connectionString ?? process.env.DATABASE_URL), max: 1 });
  const client = await (pool ?? ownPool).connect();
  const onNotice = (notice) => {
    // RAISE WARNING from a migration is something an operator must see.
    if (notice.severity === 'WARNING') log.warn(notice.message);
  };
  client.on('notice', onNotice);

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await ensureTable(client);
      const applied = await appliedVersions(client);
      const pending = plan(migrations, applied);

      if (statusOnly) {
        for (const m of migrations) {
          const row = applied.get(m.version);
          log.info(
            `${row ? 'applied' : 'pending'}  ${m.file}${row ? `  ${new Date(row.applied_at).toISOString()}` : ''}`,
          );
        }
        return pending.map((m) => m.file);
      }

      if (!pending.length) {
        log.info(`schema up to date (${migrations.length} migration(s))`);
        return [];
      }
      for (const migration of pending) await apply(client, migration);
      log.info(`applied ${pending.length} migration(s)`);
      return pending.map((m) => m.file);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.off('notice', onNotice);
    client.release();
    if (ownPool) await ownPool.end();
  }
}

/* CLI: node server/src/db/migrate.js [--status] */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await import('../env.js');
  if (!process.env.DATABASE_URL) {
    log.error('DATABASE_URL is not set. Point it at the dashboard database and retry.');
    process.exit(1);
  }
  try {
    await migrate({ statusOnly: process.argv.includes('--status') });
  } catch (err) {
    log.error(err.message);
    process.exitCode = 1;
  }
}
