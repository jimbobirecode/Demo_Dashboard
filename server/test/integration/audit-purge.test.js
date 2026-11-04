/**
 * The 12-month retention, enforced for real.
 *
 * The rows name staff and carry request bodies: keeping them forever would
 * be holding personal data with nothing to point at as a purpose. A policy
 * that is only written in a document is not a policy, so this runs the purge
 * against a real table.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createScratchDatabase, skip } from './helpers.js';
import { migrate } from '../../src/db/migrate.js';

describe('audit retention', { skip }, () => {
  let db;
  let client;

  before(async () => {
    db = await createScratchDatabase('audit_purge');
    await migrate({ connectionString: db.url });
    process.env.DATABASE_URL = db.url;
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
  });

  after(async () => {
    await client?.end();
    await db?.drop();
  });

  test('deletes what is past a year and keeps everything inside it', async () => {
    await client.query(`
      INSERT INTO public.audit_log (club, at, actor, action, outcome)
      VALUES
        ('baltray', NOW() - interval '400 days', 'alice', 'booking.note.update', 'applied'),
        ('baltray', NOW() - interval '366 days', 'alice', 'booking.note.update', 'applied'),
        ('baltray', NOW() - interval '364 days', 'alice', 'booking.note.update', 'applied'),
        ('baltray', NOW(),                       'alice', 'auth.login',          'applied')`);

    // Imported here so it picks up DATABASE_URL set above.
    const { purgeAudit, RETENTION_DAYS } = await import('../../src/lib/audit.js');
    const gone = await purgeAudit();

    assert.equal(gone, 2, 'the two older than a year, and only those');
    const { rows } = await client.query('SELECT count(*)::int AS n, min(at) AS oldest FROM public.audit_log');
    assert.equal(rows[0].n, 2);
    const ageDays = (Date.now() - new Date(rows[0].oldest).getTime()) / 86_400_000;
    assert.ok(ageDays < RETENTION_DAYS, 'nothing left is older than the retention period');
  });

  test('running it again when there is nothing to purge is a no-op', async () => {
    assert.equal(await (await import('../../src/lib/audit.js')).purgeAudit(), 0);
  });
});
