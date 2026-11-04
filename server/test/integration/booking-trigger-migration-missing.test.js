/**
 * The booking trigger workflow on a database that has not had migration 0026.
 *
 * This is the feature's normal first state on a real install. Migrations are
 * applied deliberately with `npm run migrate` before a deploy, never at boot
 * (see `db/migrate.js` and `render.yaml`), so the first thing that happens to
 * the workflow in production is a deploy of the code against a database with no
 * ledger table — and it answered "Internal server error", which tells the club
 * nothing and the one person who could fix it nothing either.
 *
 * So every way in has to name the table, name the migration and name the
 * command. A file of its own because it migrates to 0025 and stops there: the
 * other suites all want the whole schema.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createScratchDatabase, skip } from './helpers.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

let db;
let pool;
let query;
let planClub;
let recentSends;
let recordStep;
let runTriggers;
let sweepTriggers;
let LedgerMissingError;
let LEDGER_MIGRATION;

const env = () => ({
  TRIGGER_WORKFLOW: 'true',
  TRIGGER_WORKFLOW_AUTO: 'true',
  SENDGRID_API_KEY: 'SG.test',
  FROM_EMAIL: 'golf@club.test',
  PAYMENTS_TRACKED_FROM: 'all',
});

/** Every assertion about the refusal, in one place. */
function namesTheRemedy(err) {
  assert.ok(err instanceof LedgerMissingError, `expected a LedgerMissingError, got ${err?.name}`);
  assert.equal(err.status, 409, 'a 409: the request was fine, the database is behind');
  assert.equal(err.migration, LEDGER_MIGRATION);
  assert.match(err.message, /booking_trigger_sends/, 'names the table');
  assert.match(err.message, /0026_booking_trigger_workflow\.sql/, 'names the migration');
  assert.match(err.message, /npm run migrate/, 'names the command that fixes it');
  return true;
}

describe('the workflow on a database without migration 0026', { skip }, () => {
  before(async () => {
    db = await createScratchDatabase('trigger_nomig');
    Object.assign(process.env, { DATABASE_URL: db.url, NODE_ENV: 'test' });

    // Everything up to 0025, by hand, and nothing after it -- so 0027 (the
    // settings column and the operators' auto_chase switch) is missing too,
    // which is exactly the state a deploy of this code meets on a database
    // nobody has migrated. Reading the trade book has to survive that, or
    // every page answers "Internal server error" before the ledger is ever
    // asked for; the last test below is the one that proves it.
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      for (const file of fs.readdirSync(MIGRATIONS).sort()) {
        if (file >= '0026') continue;
        await client.query(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
      }
      const { rows } = await client.query("SELECT to_regclass('public.booking_trigger_sends') AS table");
      assert.equal(rows[0].table, null, 'the ledger table must not exist for these tests to mean anything');
    } finally {
      await client.end();
    }

    ({ pool, query } = await import('../../src/db.js'));
    ({ planClub, recentSends, recordStep, runTriggers, LedgerMissingError, LEDGER_MIGRATION } =
      await import('../../src/lib/booking-trigger-runner.js'));
    ({ sweepTriggers } = await import('../../src/lib/booking-trigger-sweep.js'));

    await query(
      `INSERT INTO public.bookings
         (booking_id, club, guest_email, guest_name, date, tee_time, players, total, status, payment_status, amount_paid)
       VALUES ('NOMIG-1', 'club_a', 'g@x.test', 'Guest', CURRENT_DATE + 100, '10:00', 4, 1000, 'Booked', 'Unpaid', 0)`,
    );
  });

  after(async () => {
    await pool?.end();
    await db?.drop();
  });

  test('planning names the table, the migration and the command', async () => {
    await assert.rejects(() => planClub('club_a', { env: env() }), namesTheRemedy);
  });

  test('reading the history says the same thing', async () => {
    await assert.rejects(() => recentSends('club_a'), namesTheRemedy);
  });

  test('writing to the ledger says the same thing', async () => {
    await assert.rejects(
      () => recordStep({ club: 'club_a', bookingId: 'NOMIG-1', step: 'deposit_request' }),
      namesTheRemedy,
    );
  });

  test('a run refuses outright rather than reporting a quiet success', async () => {
    // Swallowed into a result, this would read "0 sent, 0 failed" — the page
    // would say every booking is where it should be, which is the one thing
    // nobody can know without the ledger.
    await assert.rejects(() => runTriggers({ club: 'club_a', sentBy: 'tester', env: env() }), namesTheRemedy);
  });

  test('the schedule stands down after saying it once, rather than once per club', async () => {
    const run = await sweepTriggers({ reason: 'test', env: env() });
    assert.match(run.skipped, /npm run migrate/);
    assert.deepEqual(run.clubs, [], 'it did not go on to try the next club with the same table missing');
    assert.equal(run.error, undefined, 'and it is a stand-down, not a crash');
  });

  test('the trade book still reads without 0027, with every account chased as before', async () => {
    // auto_chase does not exist on this database. It is read out of the row
    // as JSON so a missing column is NULL, and NULL serialises as the default.
    const { OPERATOR_SELECT } = await import('../../src/lib/schema.js');
    const { serialiseOperator } = await import('../../src/lib/operators-domain.js');
    await query(`INSERT INTO public.tour_operators (club, name) VALUES ('club_a', 'Carr Golf')`);
    const { rows } = await query(`SELECT ${OPERATOR_SELECT} FROM public.tour_operators WHERE club = 'club_a'`);
    assert.equal(rows.length, 1);
    assert.equal(serialiseOperator(rows[0]).autoChase, true);
  });

  test('the config endpoint still answers, so the page can render the message', async () => {
    // The page reads /config first and /pending second. If /config needed the
    // ledger too, a club behind on migrations would get a blank screen instead
    // of a banner telling them what to run.
    const { readTriggerConfig, publicTriggerConfig } = await import('../../src/lib/booking-triggers-domain.js');
    const config = publicTriggerConfig(readTriggerConfig(env()));
    assert.equal(config.enabled, true);
    assert.ok(config.steps.length > 0);
  });
});
