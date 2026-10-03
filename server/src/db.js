import fs from 'node:fs';
import pg from 'pg';
import { logger } from './lib/logger.js';
import { databaseOptions } from './lib/db-ssl.js';

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
if (options.mode === 'encrypt') {
  log.info('database: TLS without certificate verification (set PGSSLROOTCERT or DATABASE_SSL_VERIFY=true to verify)');
} else if (options.mode === 'disabled') {
  log.warn('database: TLS disabled by DATABASE_SSL=disable for a remote host');
}

export const pool = new Pool({
  connectionString: options.connectionString,
  ssl: options.ssl,
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  log.error('idle client error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}
