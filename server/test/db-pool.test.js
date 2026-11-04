/**
 * The connection budget.
 *
 * Supabase's session-mode pooler caps a project at pool_size clients in total
 * -- 15 by default -- shared by every service pointed at the database. County
 * Louth runs two: this dashboard and the email bot.
 *
 * The defaults were 10 here and 20 in the bot: 30 against 15. Nothing failed
 * while both were quiet, because neither opened everything it was allowed to.
 * Both busy at once and the pooler refused connections with EMAXCONNSESSION,
 * and because that hits EVERY query -- including the one that loads the
 * signed-in user -- the whole dashboard went blank rather than one page
 * breaking. These numbers are a shared budget, so they are asserted rather
 * than left to whoever edits one file without the other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.resolve(here, file), 'utf8');

/** What a default is, as its source file spells it. */
function defaultFor(source, pattern) {
  const match = pattern.exec(source);
  return match ? Number(match[1]) : null;
}

test('this service claims only a share of the pooler, not all of it', () => {
  const dashboard = defaultFor(read('../src/db.js'), /PGPOOL_MAX\s*\?\?\s*(\d+)/);
  assert.equal(typeof dashboard, 'number');
  assert.ok(dashboard > 0, 'a pool of none serves nobody');
  assert.ok(dashboard <= 6, `a pool of ${dashboard} leaves too little of a 15-client project for anything else`);
});

test('a deploy runs two copies of this service, and the budget covers both', () => {
  // Supabase's default for session mode. Raising it is a project setting, and
  // these numbers may only go up after it does.
  const PROJECT_LIMIT = 15;
  const dashboard = defaultFor(read('../src/db.js'), /PGPOOL_MAX\s*\?\?\s*(\d+)/);

  // The bot is a separate repository (jimbobirecode/TeeMailSG). Its default
  // lives in db_utils.py and is written here so the sum is checked somewhere.
  const bot = 5;

  // Render keeps the OLD instance serving until the new one passes its health
  // check, so for the length of a deploy this service is running twice. Five,
  // five and the bot's five was the whole 15 and the migration run the new copy
  // does before it can listen had nothing left to connect with: the 13 Oct 2026
  // deploy failed there, and failed again on every restart.
  const duringADeploy = dashboard * 2 + bot;
  const spare = PROJECT_LIMIT - duringADeploy;
  assert.ok(
    spare >= 3,
    `two copies of this service (${dashboard} each) and the bot (${bot}) hold ${duringADeploy} of ${PROJECT_LIMIT} ` +
      `during a deploy, leaving ${spare} for the migration run, a psql session and the Supabase SQL editor`,
  );
});

test('render.yaml sets the same share the code defaults to', () => {
  // The default is what a local run and a forgotten env var get; the Blueprint
  // is what the club actually deploys with. Two numbers, one budget.
  const dashboard = defaultFor(read('../src/db.js'), /PGPOOL_MAX\s*\?\?\s*(\d+)/);
  const blueprint = defaultFor(read('../../render.yaml'), /key:\s*PGPOOL_MAX\s*\n\s*value:\s*"(\d+)"/);
  assert.equal(blueprint, dashboard);
});

test('a refused connection is explained, not reported as a database fault', async () => {
  // EMAXCONNSESSION arrives as a Postgres FATAL with no table, column or hint,
  // so in the log it reads like the database broke rather than like a limit
  // this deployment set for itself. It took an outage to work that out once.
  const { describePoolExhaustion } = await import('../src/db.js');

  const real = new Error(
    '(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15',
  );
  const explained = describePoolExhaustion(real);
  assert.ok(explained, 'the pooler refusal is recognised');
  assert.match(explained, /15 clients in total/);
  assert.match(explained, /PGPOOL_MAX/, 'names the setting on this side');
  assert.match(explained, /MAX_DB_CONNECTIONS/, 'and the one on the bot');
  assert.match(explained, /Connection pooling/, 'and where to raise the limit');

  // Anything else is left to be reported as it is.
  assert.equal(describePoolExhaustion(new Error('connection terminated unexpectedly')), null);
  assert.equal(describePoolExhaustion(null), null);
});
