/**
 * TLS for the database connection, decided here rather than left to the URL.
 *
 * A remote database is always reached over TLS. Without this, a DATABASE_URL
 * that forgot `?sslmode=require` connected in plain text, and pg reads its
 * own TLS settings from the URL in ways that changed between versions
 * (`sslmode=require` is treated as full verification by current pg).
 *
 * - Local hosts (localhost, 127.0.0.1, ::1, a Unix socket) keep whatever the
 *   URL says, so development and CI need no certificates.
 * - Any other host gets TLS. The certificate is verified when
 *   PGSSLROOTCERT names a CA bundle (the provider's CA, e.g. Supabase's) or
 *   when the URL asks for `sslmode=verify-ca|verify-full` or
 *   DATABASE_SSL_VERIFY=true (system trust store). Otherwise the connection is
 *   encrypted without verifying the certificate — the core API's
 *   `sslmode=require` behaviour — because some managed providers present a
 *   chain that is not in the public trust store.
 * - DATABASE_SSL=disable turns TLS off for a remote host, for a private
 *   network that cannot offer it. It is logged at every start.
 *
 * Pure: returns the options for pg.Pool; db.js and the migration runner use it.
 */
import fs from 'node:fs';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);
const TLS_PARAMS = ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

export function isLocalDatabase(url) {
  if (url.searchParams.get('host')?.startsWith('/')) return true;
  return LOCAL_HOSTS.has(url.hostname);
}

/**
 * { connectionString, ssl, mode } for a DATABASE_URL. `mode` is one of
 * 'local', 'verify', 'encrypt' (no certificate check) or 'disabled'.
 */
export function databaseOptions(databaseUrl, env = process.env, readFile = (file) => fs.readFileSync(file, 'utf8')) {
  if (!databaseUrl) return { connectionString: databaseUrl, ssl: undefined, mode: 'unset' };

  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    return { connectionString: databaseUrl, ssl: undefined, mode: 'unparsed' };
  }

  const ca = env.PGSSLROOTCERT ? readFile(env.PGSSLROOTCERT) : null;
  if (isLocalDatabase(url)) {
    return { connectionString: databaseUrl, ssl: ca ? { ca } : undefined, mode: 'local' };
  }

  const sslmode = (url.searchParams.get('sslmode') ?? '').toLowerCase();
  for (const param of TLS_PARAMS) url.searchParams.delete(param);
  const connectionString = url.toString();

  if (String(env.DATABASE_SSL ?? '').toLowerCase() === 'disable') {
    return { connectionString, ssl: false, mode: 'disabled' };
  }
  const verify =
    Boolean(ca) || sslmode === 'verify-ca' || sslmode === 'verify-full' || env.DATABASE_SSL_VERIFY === 'true';
  if (verify)
    return {
      connectionString,
      ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true },
      mode: 'verify',
    };
  return { connectionString, ssl: { rejectUnauthorized: false }, mode: 'encrypt' };
}
