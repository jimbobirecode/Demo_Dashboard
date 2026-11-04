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
/**
 * The connection as `user@host:port/database`, for the boot log — never the
 * password, which is why this builds the string by hand rather than printing
 * the URL.
 *
 * It earns its place on a managed host. Supabase offers three connection
 * strings and getting the wrong one is three different failures that all look
 * like the migration runner falling over: the direct host resolves only to IPv6
 * (ENETUNREACH where there is no IPv6 route), the transaction pooler on 6543
 * breaks the runner's session-level advisory lock and the migrations' pg_temp
 * guards, and the session pooler needs the project ref in the username
 * (`postgres.abcdefgh`, not `postgres`) because that is how it picks the
 * project. Printing the user and host turns each of those from a guess into a
 * glance.
 *
 * Note what the log cannot tell you: the pooler strips that `.ref` suffix and
 * authenticates upstream as `postgres`, so a failure always reads
 * `password authentication failed for user "postgres"` whether the ref was
 * there or not. Read the username off this line, not out of the error.
 */
export function describeConnection(databaseUrl) {
  const text = String(databaseUrl ?? '').trim();
  if (!text) return 'not set';

  let url;
  try {
    url = new URL(text);
  } catch {
    return 'unparsed';
  }

  const user = url.username ? decodeURIComponent(url.username) : '(no user)';
  const database = url.pathname.replace(/^\//, '') || '(no database)';
  const host = url.hostname || '(no host)';
  const port = url.port || '5432';
  return `${user}@${host}:${port}/${database}`;
}

/**
 * True when the password carries leading or trailing whitespace, which a URL
 * keeps (as %20 or a raw space) and Postgres then rejects.
 *
 * It is worth its own check because it is invisible everywhere else: the host,
 * port, user and database all parse correctly, the connection reaches the
 * server, and the only symptom is `password authentication failed` — identical
 * to simply having the wrong password. A value pasted into a dashboard field
 * with a stray newline fails this way and looks like nothing at all. Reports
 * only that whitespace is present, never the password or its length.
 */
export function passwordHasOuterWhitespace(databaseUrl) {
  const text = String(databaseUrl ?? '').trim();
  if (!text) return false;
  try {
    const password = new URL(text).password;
    if (!password) return false;
    const decoded = decodeURIComponent(password);
    return decoded !== decoded.trim();
  } catch {
    return false;
  }
}

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
