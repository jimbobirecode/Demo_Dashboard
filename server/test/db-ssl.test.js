import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseOptions } from '../src/lib/db-ssl.js';

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
