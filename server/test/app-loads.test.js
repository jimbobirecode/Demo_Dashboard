/**
 * Every route module is imported by app.js, so loading it catches a syntax
 * error or a broken import anywhere in the server without a database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('the app and every route module load', async () => {
  const { app } = await import('../src/app.js');
  assert.equal(typeof app.listen, 'function');
});

test('the migration runner and seed script load', async () => {
  const { readMigrations } = await import('../src/db/migrate.js');
  assert.ok(readMigrations().length > 0);
  await import('../../scripts/seed.mjs');
});
