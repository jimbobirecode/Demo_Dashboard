import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { MIGRATIONS_DIR, MigrationError, checksum, migrate, readMigrations } from '../../src/db/migrate.js';
import { createScratchDatabase, skip } from './helpers.js';

function tempMigrations(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

describe('readMigrations', () => {
  test('reads the repository migrations in order with stable checksums', () => {
    const migrations = readMigrations();
    assert.ok(migrations.length >= 5);
    assert.deepEqual(
      migrations.map((m) => m.version),
      [...migrations.map((m) => m.version)].sort((a, b) => a - b),
    );
    assert.equal(migrations[0].file, '0001_baseline_bookings.sql');
  });

  test('a checksum ignores CRLF line endings', () => {
    assert.equal(checksum('a\r\nb\r\n'), checksum('a\nb\n'));
  });

  test('refuses badly named files, duplicate versions and files that manage their own transaction', () => {
    assert.throws(() => readMigrations(tempMigrations({ '1_x.sql': 'SELECT 1;' })), MigrationError);
    assert.throws(
      () => readMigrations(tempMigrations({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 1;' })),
      /also used by/,
    );
    assert.throws(
      () => readMigrations(tempMigrations({ '0001_a.sql': 'BEGIN;\nSELECT 1;\nCOMMIT;' })),
      /own transaction/,
    );
  });
});

describe('migrate against Postgres', { skip }, () => {
  let db;
  before(async () => {
    db = await createScratchDatabase('migrate_test');
  });
  after(async () => {
    await db?.drop();
  });

  test('applies every migration to an empty database, then finds nothing to do', async () => {
    const applied = await migrate({ connectionString: db.url });
    assert.deepEqual(
      applied,
      readMigrations().map((m) => m.file),
    );

    const again = await migrate({ connectionString: db.url });
    assert.deepEqual(again, []);

    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
      assert.deepEqual(
        rows.map((r) => [r.version, r.checksum]),
        readMigrations().map((m) => [m.version, m.checksum]),
      );
    } finally {
      await client.end();
    }
  });

  test('re-running the baseline SQL by hand on a migrated database changes nothing', async () => {
    // The baseline must be a no-op on a database that already has the schema
    // (production, the first time the runner meets it).
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      for (const m of readMigrations(MIGRATIONS_DIR)) await client.query(m.sql);
    } finally {
      await client.end();
    }
  });
});

describe('migrate runner behaviour', { skip }, () => {
  let db;
  before(async () => {
    db = await createScratchDatabase('migrate_runner');
  });
  after(async () => {
    await db?.drop();
  });

  test('two runners at once apply each file exactly once', async () => {
    const dir = tempMigrations({
      '0001_one.sql': 'CREATE TABLE one (id INT); SELECT pg_sleep(0.2);',
      '0002_two.sql': 'CREATE TABLE two (id INT);',
    });
    const [a, b] = await Promise.all([
      migrate({ connectionString: db.url, dir }),
      migrate({ connectionString: db.url, dir }),
    ]);
    assert.equal(a.length + b.length, 2);
  });

  test('editing an applied migration is refused', async () => {
    const dir = tempMigrations({
      '0001_one.sql': 'CREATE TABLE one (id INT); SELECT pg_sleep(0.2);',
      '0002_two.sql': 'CREATE TABLE two (id INT, edited INT);',
    });
    await assert.rejects(migrate({ connectionString: db.url, dir }), /0002_two\.sql has changed/);
  });

  test('a failing migration is rolled back and not recorded; earlier ones stay applied', async () => {
    const dir = tempMigrations({
      '0001_one.sql': 'CREATE TABLE one (id INT); SELECT pg_sleep(0.2);',
      '0002_two.sql': 'CREATE TABLE two (id INT);',
      '0003_bad.sql': 'CREATE TABLE three (id INT);\nSELECT * FROM no_such_table;',
    });
    await assert.rejects(migrate({ connectionString: db.url, dir }), /0003_bad\.sql failed/);

    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
      assert.deepEqual(
        rows.map((r) => r.version),
        [1, 2],
      );
      const three = await client.query("SELECT to_regclass('public.three') AS t");
      assert.equal(three.rows[0].t, null);
    } finally {
      await client.end();
    }
  });
});
