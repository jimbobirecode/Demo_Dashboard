import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { MIGRATIONS_DIR, MigrationError, checksum, migrate, readMigrations } from '../../src/db/migrate.js';
import { TEST_DATABASE_URL, createScratchDatabase, skip } from './helpers.js';

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

async function sql(url, text) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(text);
  } finally {
    await client.end();
  }
}

describe('migrations on a database that already has the schema', { skip }, () => {
  const role = `migrate_nonowner_${process.pid}`;
  let db;
  before(async () => {
    db = await createScratchDatabase('migrate_existing');
  });
  after(async () => {
    await db?.drop();
    await sql(TEST_DATABASE_URL, `DROP ROLE IF EXISTS ${role}`).catch(() => {});
  });

  test('a role that owns no table can run them: every statement is a no-op', async () => {
    // Production meets the runner with its tables in place, owned by whoever
    // created them, and no schema_migrations table yet.
    await migrate({ connectionString: db.url });
    await sql(db.url, 'DROP TABLE schema_migrations');
    await sql(TEST_DATABASE_URL, `DROP ROLE IF EXISTS ${role}`);
    await sql(TEST_DATABASE_URL, `CREATE ROLE ${role} LOGIN PASSWORD 'nonowner'`);
    await sql(
      db.url,
      `GRANT USAGE, CREATE ON SCHEMA public TO ${role};
       GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA public TO ${role};
       GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role};`,
    );

    const url = new URL(db.url);
    url.username = role;
    url.password = 'nonowner';
    const applied = await migrate({ connectionString: url.toString() });
    assert.deepEqual(
      applied,
      readMigrations().map((m) => m.file),
    );
    assert.deepEqual(await migrate({ connectionString: url.toString() }), []);

    // Hand the database back so it can be dropped with its role.
    await sql(db.url, `DROP OWNED BY ${role}`);
  });
});

describe('migrations meeting rows that break a new constraint', { skip }, () => {
  let db;
  before(async () => {
    db = await createScratchDatabase('migrate_bad_rows');
  });
  after(async () => {
    await db?.drop();
  });

  test('a CHECK is left NOT VALID and a unique index skipped, nothing deleted, deploy not failed', async () => {
    // A database that has the tables but not yet the constraint or the index,
    // and rows that would break them.
    await migrate({ connectionString: db.url });
    await sql(
      db.url,
      `DROP TABLE schema_migrations;
       ALTER TABLE bookings DROP CONSTRAINT bookings_source_check;
       DROP INDEX idx_tour_operators_club_name;
       INSERT INTO bookings (booking_id, source) VALUES ('A-1', 'legacy');
       INSERT INTO tour_operators (club, name) VALUES ('c', 'Acme'), ('c', 'ACME');`,
    );

    await migrate({ connectionString: db.url });

    const check = await sql(db.url, "SELECT convalidated FROM pg_constraint WHERE conname = 'bookings_source_check'");
    assert.equal(check.rows[0].convalidated, false);
    const index = await sql(db.url, "SELECT to_regclass('public.idx_tour_operators_club_name') AS i");
    assert.equal(index.rows[0].i, null);
    const rows = await sql(
      db.url,
      'SELECT (SELECT COUNT(*) FROM bookings)::int AS b, (SELECT COUNT(*) FROM tour_operators)::int AS o',
    );
    assert.deepEqual(rows.rows[0], { b: 1, o: 2 });

    // New rows are held to the constraint all the same.
    await assert.rejects(sql(db.url, "INSERT INTO bookings (booking_id, source) VALUES ('A-2', 'other')"), /check/);
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
