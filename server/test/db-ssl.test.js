import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseOptions, describeConnection, passwordHasOuterWhitespace } from '../src/lib/db-ssl.js';

const noFile = () => null;

test('local databases keep what the URL says', () => {
  for (const url of [
    'postgresql://u:p@localhost:5432/db',
    'postgresql://u:p@127.0.0.1/db?sslmode=disable',
    'postgresql://u:p@[::1]/db',
    'postgresql:///db?host=/var/run/postgresql',
  ]) {
    const options = databaseOptions(url, {}, noFile);
    assert.equal(options.mode, 'local', url);
    assert.equal(options.connectionString, url);
    assert.equal(options.ssl, undefined);
  }
});

test('a remote database always gets TLS, even when the URL forgot it or disabled it', () => {
  for (const url of ['postgresql://u:p@db.example.com/db', 'postgresql://u:p@db.example.com/db?sslmode=disable']) {
    const options = databaseOptions(url, {}, noFile);
    assert.equal(options.mode, 'encrypt');
    assert.deepEqual(options.ssl, { rejectUnauthorized: false });
    assert.ok(!options.connectionString.includes('sslmode'));
  }
});

test('certificates are verified with a CA bundle, verify-full or DATABASE_SSL_VERIFY', () => {
  const ca = databaseOptions('postgresql://u:p@db.example.com/db', { PGSSLROOTCERT: '/ca.pem' }, () => 'PEM');
  assert.deepEqual(ca.ssl, { ca: 'PEM', rejectUnauthorized: true });
  assert.equal(databaseOptions('postgresql://u:p@h.example/db?sslmode=verify-full', {}, noFile).mode, 'verify');
  assert.equal(
    databaseOptions('postgresql://u:p@h.example/db', { DATABASE_SSL_VERIFY: 'true' }, noFile).mode,
    'verify',
  );
});

test('DATABASE_SSL=disable is the only way to a plain-text remote connection', () => {
  const options = databaseOptions('postgresql://u:p@dpg-internal/db', { DATABASE_SSL: 'disable' }, noFile);
  assert.equal(options.mode, 'disabled');
  assert.equal(options.ssl, false);
});

test('the connection is described for the log without its password', () => {
  // Supabase's session pooler, which needs the project ref in the username.
  assert.equal(
    describeConnection('postgresql://postgres.abcdefghijkl:s3cr3t@aws-0-eu-west-1.pooler.supabase.com:5432/postgres'),
    'postgres.abcdefghijkl@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
  );

  // The password never appears, whatever it contains.
  const described = describeConnection('postgresql://user:p%40ss%3Aword@db.example.com:6543/app');
  assert.equal(described, 'user@db.example.com:6543/app');
  assert.ok(!described.includes('ss'), 'the password must not reach the log');
});

test('a connection with pieces missing still describes itself', () => {
  assert.equal(describeConnection('postgresql://localhost/teemail_dev'), '(no user)@localhost:5432/teemail_dev');
  assert.equal(describeConnection(''), 'not set');
  assert.equal(describeConnection(null), 'not set');
  assert.equal(describeConnection('not a url'), 'unparsed');
});

test('whitespace around the password is spotted, since nothing else reveals it', () => {
  const base = 'postgresql://postgres.ref:PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';
  assert.equal(passwordHasOuterWhitespace(base.replace('PASSWORD', 'secret')), false);

  // A trailing newline or space from pasting into a dashboard field.
  assert.equal(passwordHasOuterWhitespace(base.replace('PASSWORD', 'secret%0A')), true);
  assert.equal(passwordHasOuterWhitespace(base.replace('PASSWORD', 'secret%20')), true);
  assert.equal(passwordHasOuterWhitespace(base.replace('PASSWORD', '%20secret')), true);

  // Spaces inside a password are legitimate and must not be flagged.
  assert.equal(passwordHasOuterWhitespace(base.replace('PASSWORD', 'two%20words')), false);

  // Nothing to look at.
  assert.equal(passwordHasOuterWhitespace('postgresql://localhost/dev'), false);
  assert.equal(passwordHasOuterWhitespace(''), false);
  assert.equal(passwordHasOuterWhitespace('not a url'), false);
});
