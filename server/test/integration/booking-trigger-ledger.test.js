/**
 * The booking trigger ledger (migration 0026).
 *
 * The engine's whole no-double-send guarantee rests on one partial unique
 * index: a rung that reached a settled outcome can never be written twice,
 * whoever runs the sweep and however often two runs overlap. That is SQL, and
 * it is not worth asserting anywhere but against a real Postgres — a mocked
 * insert would happily accept the duplicate the index exists to refuse.
 *
 * The matching half, that a *failed* send is retried, is the same index read
 * the other way: failures are deliberately outside it.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { createScratchDatabase, skip } from './helpers.js';

describe('the booking trigger ledger', { skip }, () => {
  let db;
  let client;
  let next = 0;

  /** A booking reference nothing else in this file uses. */
  function reference() {
    next += 1;
    return `BT-${next}`;
  }

  function insert(bookingId, step, outcome = 'sent') {
    return client.query(
      `INSERT INTO public.booking_trigger_sends (club, booking_id, step, flow, due_on, outcome, detail)
       VALUES ('baltray', $1, $2, 'visitor', CURRENT_DATE, $3, 'from the test')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [bookingId, step, outcome],
    );
  }

  before(async () => {
    db = await createScratchDatabase('triggers');
    const pool = new pg.Pool({ connectionString: db.url, max: 2 });
    try {
      await migrate({ pool });
    } finally {
      await pool.end();
    }
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
  });

  after(async () => {
    await client?.end();
    await db?.drop();
  });

  test('the migration creates the table the engine reads', async () => {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'booking_trigger_sends'`,
    );
    const columns = rows.map((row) => row.column_name);
    for (const column of ['club', 'booking_id', 'step', 'flow', 'due_on', 'sent_at', 'outcome', 'to_email']) {
      assert.ok(columns.includes(column), column);
    }
  });

  test('a rung that has been sent cannot be sent again', async () => {
    const bookingId = reference();
    const first = await insert(bookingId, 'deposit_request');
    assert.equal(first.rowCount, 1);

    // What two overlapping runs do: a person pressing Send while the schedule
    // is mid-pass. The second claims nothing.
    const second = await insert(bookingId, 'deposit_request');
    assert.equal(second.rowCount, 0, 'the second write claimed nothing');

    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS count FROM public.booking_trigger_sends WHERE booking_id = $1',
      [bookingId],
    );
    assert.equal(rows[0].count, 1);
  });

  test('the guard is per rung, not per booking', async () => {
    const bookingId = reference();
    assert.equal((await insert(bookingId, 'deposit_request')).rowCount, 1);
    assert.equal((await insert(bookingId, 'deposit_reminder')).rowCount, 1);
    assert.equal((await insert(bookingId, 'final_details')).rowCount, 1);
  });

  test('a rung skipped or superseded is settled too, and never fires later', async () => {
    for (const outcome of ['skipped', 'superseded', 'cleared', 'cancelled']) {
      const bookingId = reference();
      assert.equal((await insert(bookingId, 'deposit_reminder', outcome)).rowCount, 1, outcome);
      assert.equal((await insert(bookingId, 'deposit_reminder', 'sent')).rowCount, 0, `${outcome} blocks a later send`);
    }
  });

  test('a failed send is retried, and every attempt is kept', async () => {
    const bookingId = reference();
    assert.equal((await insert(bookingId, 'deposit_request', 'failed')).rowCount, 1);
    assert.equal((await insert(bookingId, 'deposit_request', 'failed')).rowCount, 1, 'a second attempt is allowed');
    // And once it works, the rung settles and closes.
    assert.equal((await insert(bookingId, 'deposit_request', 'sent')).rowCount, 1);
    assert.equal((await insert(bookingId, 'deposit_request', 'sent')).rowCount, 0);

    const { rows } = await client.query(
      `SELECT outcome, COUNT(*)::int AS count FROM public.booking_trigger_sends
        WHERE booking_id = $1 GROUP BY outcome ORDER BY outcome`,
      [bookingId],
    );
    assert.deepEqual(rows, [
      { outcome: 'failed', count: 2 },
      { outcome: 'sent', count: 1 },
    ]);
  });

  test('two clubs climb their own ladders', async () => {
    const bookingId = reference();
    await insert(bookingId, 'deposit_request');
    const other = await client.query(
      `INSERT INTO public.booking_trigger_sends (club, booking_id, step, outcome)
       VALUES ('another_club', $1, 'deposit_request', 'sent')
       ON CONFLICT DO NOTHING RETURNING id`,
      [bookingId],
    );
    assert.equal(other.rowCount, 1);
  });

  test('running the migrations twice changes nothing', async () => {
    const pool = new pg.Pool({ connectionString: db.url, max: 2 });
    try {
      await migrate({ pool });
    } finally {
      await pool.end();
    }
    const { rows } = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'booking_trigger_sends' ORDER BY indexname`,
    );
    assert.deepEqual(
      rows.map((row) => row.indexname),
      [
        'booking_trigger_sends_pkey',
        'idx_booking_trigger_sends_club',
        'idx_booking_trigger_sends_recent',
        'idx_booking_trigger_sends_step',
      ],
    );
  });
});
