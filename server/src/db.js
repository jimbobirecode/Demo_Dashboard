import fs from 'node:fs';
import pg from 'pg';
import { logger } from './lib/logger.js';

const log = logger.child('db');

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  log.warn('DATABASE_URL is not set — database queries will fail.');
}

// TLS is driven by the connection string (append ?sslmode=require for managed
// Postgres). Point PGSSLROOTCERT at the provider's CA bundle if its certificate
// chain is not in the system trust store.
function sslConfig() {
  const caPath = process.env.PGSSLROOTCERT;
  if (caPath && fs.existsSync(caPath)) {
    return { ca: fs.readFileSync(caPath, 'utf8') };
  }
  return undefined;
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  log.error('idle client error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}
