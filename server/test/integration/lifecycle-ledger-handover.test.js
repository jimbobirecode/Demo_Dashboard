/**
 * Upgrading a database that ran the RETIRED Booking Lifecycle ladder.
 *
 * This dashboard used to have a ladder of its own, at migrations 0012-0014,
 * and it kept its ledger in a table called `booking_trigger_sends`. The
 * booking trigger workflow that replaced it (0026) uses that same name with
 * different columns: `step` and `flow` where the old one had `rung` and
 * `phase`, `to_email` for `email_to`, `sent_at` for `created_at`.
 *
 * So on a database that ran the old ladder, 0026's guarded CREATE used to find
 * a table already there, leave it alone, and then fail on
 * `CREATE UNIQUE INDEX ... (club, booking_id, step)` with "column step does not
 * exist" -- a migration failure, mid-deploy, on exactly the databases that
 * matter. Every other test in this repository passed throughout, because they
 * all start from an empty database and never meet the old table.
 *
 * That is what this file is for: the only path on which the two ladders meet.
 * The old table is constructed by hand rather than by replaying 0012, because
 * 0012 is deleted -- the schema it left behind outlives the file that made it,
 * which is the whole reason this case exists.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { createScratchDatabase, skip } from './helpers.js';

/** `booking_trigger_sends` exactly as the retired ladder's 0012 left it. */
const RETIRED_LEDGER = `
  CREATE TABLE public.booking_trigger_sends (
    id         SERIAL PRIMARY KEY,
    club       TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    rung       TEXT NOT NULL,
    phase      TEXT NOT NULL,
    outcome    TEXT NOT NULL
      CHECK (outcome IN ('sent', 'skipped', 'superseded', 'held', 'failed')),
    due_on     DATE,
    detail     TEXT,
    email_to   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX idx_booking_trigger_sends_once
    ON public.booking_trigger_sends (club, booking_id, rung) WHERE outcome <> 'failed';
  CREATE INDEX idx_booking_trigger_sends_booking
    ON public.booking_trigger_sends (club, booking_id, created_at DESC);
`;

async function columnsOf(client, table) {
  const { rows } = await client.query(
    `SELECT attname
       FROM pg_attribute
      WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
      ORDER BY attnum`,
    [`public.${table}`],
  );
  return rows.map((row) => row.attname);
}

describe('a database that ran the retired lifecycle ladder', { skip }, () => {
  let db;
  let client;

  before(async () => {
    db = await createScratchDatabase('lifecycle_handover');
    client = new pg.Client({ connectionString: db.url });
    await client.connect();

    // The old ladder's ledger, with a send in it that really went to a guest.
    await client.query(RETIRED_LEDGER);
    await client.query(
      `INSERT INTO public.booking_trigger_sends (club, booking_id, rung, phase, outcome, email_to)
       VALUES ('teemail', 'BOOK-1', 'deposit_request', 'deposit', 'sent', 'guest@example.com')`,
    );

    // Then the whole current migration set, as a deploy would.
    await migrate({ connectionString: db.url });
  });

  after(async () => {
    await client?.end();
    await db?.drop();
  });

  test('every migration applies — the ladders do not collide', async () => {
    // The assertion is that before() got here at all: a failure in 0026 would
    // have thrown out of migrate(). This states the end of it.
    const { rows } = await client.query('SELECT max(version) AS latest FROM public.schema_migrations');
    assert.ok(rows[0].latest >= 29, `migrated to ${rows[0].latest}`);
  });

  test('booking_trigger_sends is the new ladder’s, not the old one’s', async () => {
    const columns = await columnsOf(client, 'booking_trigger_sends');
    for (const column of ['step', 'flow', 'sent_at', 'to_email', 'subject', 'sent_by']) {
      assert.ok(columns.includes(column), `the workflow's ${column} is there`);
    }
    for (const column of ['rung', 'phase', 'email_to']) {
      assert.ok(!columns.includes(column), `the retired ladder's ${column} is gone from it`);
    }
  });

  test('the index that used to fail is there', async () => {
    // The actual breakage: (club, booking_id, step) over a table with no step.
    const { rows } = await client.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_booking_trigger_sends_step'`,
    );
    assert.equal(rows.length, 1, 'the unique index on the step exists');
    assert.match(rows[0].indexdef, /\bstep\b/);
  });

  test('the retired ledger is kept, with the sends it recorded', async () => {
    // Renamed, not dropped: these are emails that really reached guests, and a
    // migration replacing the feature has no business destroying the record.
    const { rows } = await client.query(
      `SELECT club, booking_id, rung, email_to
         FROM public.booking_trigger_sends_retired_lifecycle`,
    );
    assert.equal(rows.length, 1, 'the old send is still on the record');
    assert.equal(rows[0].rung, 'deposit_request');
    assert.equal(rows[0].email_to, 'guest@example.com');
  });

  test('re-running the migrations changes nothing', async () => {
    // A second deploy, or a retry of a half-finished one, must not rescue the
    // table twice or move the new ledger aside as if it were the old one.
    const applied = await migrate({ connectionString: db.url });
    assert.deepEqual(applied, [], 'nothing was pending');

    const columns = await columnsOf(client, 'booking_trigger_sends');
    assert.ok(columns.includes('step'), 'still the workflow’s table');

    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM pg_tables
        WHERE schemaname = 'public' AND tablename LIKE 'booking_trigger_sends_retired%'`,
    );
    assert.equal(rows[0].n, 1, 'exactly one retired ledger, not one per run');
  });

  test('the workflow can write to its own ledger afterwards', async () => {
    // The point of the whole exercise: the new ladder works on this database.
    await client.query(
      `INSERT INTO public.booking_trigger_sends
         (club, booking_id, step, flow, outcome, to_email, sent_by)
       VALUES ('teemail', 'BOOK-2', 'deposit_request', 'tour_operator', 'sent', 'ops@example.com', 'schedule')`,
    );
    const { rows } = await client.query(
      `SELECT step, flow, sent_by FROM public.booking_trigger_sends WHERE booking_id = 'BOOK-2'`,
    );
    assert.equal(rows[0].step, 'deposit_request');
    assert.equal(rows[0].flow, 'tour_operator');
    assert.equal(rows[0].sent_by, 'schedule');

    // And the rung is still sent only once, which is what the index is for.
    await assert.rejects(
      client.query(
        `INSERT INTO public.booking_trigger_sends (club, booking_id, step, outcome)
         VALUES ('teemail', 'BOOK-2', 'deposit_request', 'sent')`,
      ),
      /duplicate key value|idx_booking_trigger_sends_step/,
      'the same step cannot fire twice for one booking',
    );
  });
});
