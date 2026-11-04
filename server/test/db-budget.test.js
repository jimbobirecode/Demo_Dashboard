/**
 * Waiting out a full pooler, and failing fast on everything else.
 *
 * The migration run is the one connection most likely to be refused: it
 * happens before the new instance can listen, while the old one is still up
 * and still holding its share of the project's clients. A runner that gave up
 * on the first refusal failed the deploy, and failed it again on every restart,
 * because each restart arrived into the same crowd.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describePoolExhaustion, looksLikePoolExhaustion, statedLimit } from '../src/lib/db-budget.js';
import { CONNECT_ATTEMPTS, connectForMigration } from '../src/db/migrate.js';

const REFUSAL = () =>
  new Error('(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15');

test('a pooler with no room is recognised, however it words the refusal', () => {
  assert.ok(looksLikePoolExhaustion(REFUSAL()));
  assert.equal(statedLimit(REFUSAL()), '15');
  // Postgres' own limit, hit by connecting straight to the database.
  assert.ok(looksLikePoolExhaustion(Object.assign(new Error('sorry, too many clients already'), { code: '53300' })));

  // Everything else is somebody else's problem to report.
  assert.ok(!looksLikePoolExhaustion(new Error('password authentication failed for user "postgres"')));
  assert.ok(!looksLikePoolExhaustion(new Error('connection terminated unexpectedly')));
  assert.ok(!looksLikePoolExhaustion(null));
  assert.equal(describePoolExhaustion(new Error('getaddrinfo ENOTFOUND db.example')), null);
  assert.match(describePoolExhaustion(REFUSAL(), { poolMax: 3 }), /holds up to 3 \(PGPOOL_MAX\)/);
  // The arithmetic that was missing when the deploy failed.
  assert.match(describePoolExhaustion(REFUSAL()), /deploy runs two copies/);
});

test('the migration runner waits for a connection the pooler has no room for', async () => {
  let attempts = 0;
  const waited = [];
  const source = {
    connect: async () => {
      attempts += 1;
      if (attempts < 3) throw REFUSAL();
      return 'client';
    },
  };

  const client = await connectForMigration(source, {
    backoff: [10, 20, 30],
    sleep: async (ms) => waited.push(ms),
  });
  assert.equal(client, 'client');
  assert.equal(attempts, 3);
  assert.deepEqual(waited, [10, 20], 'it backs off between tries rather than hammering the pooler');
});

test('it gives up eventually, and never waits on a refusal that waiting cannot fix', async () => {
  let attempts = 0;
  const alwaysFull = {
    connect: async () => {
      attempts += 1;
      throw REFUSAL();
    },
  };
  await assert.rejects(
    connectForMigration(alwaysFull, { sleep: async () => {} }),
    /EMAXCONNSESSION/,
    'a pooler that is still full after every try fails the deploy with the pooler’s own reason',
  );
  assert.equal(attempts, CONNECT_ATTEMPTS);

  // A wrong password does not improve with waiting: one try, then out.
  let tries = 0;
  const wrongPassword = {
    connect: async () => {
      tries += 1;
      throw new Error('password authentication failed for user "postgres"');
    },
  };
  await assert.rejects(connectForMigration(wrongPassword, { sleep: async () => {} }), /password authentication/);
  assert.equal(tries, 1);
});

test('migrations are not applied at boot unless somebody asks for it', async () => {
  // Applying them there made every deploy depend on a connection at the moment
  // connections are scarcest, and bought nothing on a database whose migrations
  // are applied deliberately beforehand. 'check' reports and serves anyway.
  const { STARTUP_MODES, startupMode } = await import('../src/db/migrate.js');

  assert.equal(startupMode({}), 'check', 'the default never applies');
  assert.equal(startupMode({ MIGRATE_ON_START: '' }), 'check');
  assert.equal(startupMode({ MIGRATE_ON_START: 'nonsense' }), 'check', 'a typo must not start applying migrations');
  assert.equal(startupMode({ MIGRATE_ON_START: ' APPLY ' }), 'apply');
  assert.equal(startupMode({ MIGRATE_ON_START: 'off' }), 'off');

  // What somebody sets when they read it as a switch.
  assert.equal(startupMode({ MIGRATE_ON_START: 'true' }), 'apply');
  assert.equal(startupMode({ MIGRATE_ON_START: 'false' }), 'off');

  assert.deepEqual(STARTUP_MODES, ['check', 'apply', 'off']);
});

test('the boot check cannot stop the server, whatever the database says', async () => {
  // It runs after listen and swallows its own failure on purpose: a database
  // this instance cannot reach is reported by /api/health, not by refusing to
  // serve the pages that do not need it.
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'),
  );
  const check = source.slice(source.indexOf('async function reportSchema'), source.indexOf('async function start'));
  assert.match(check, /catch \(err\)/, 'it catches');
  assert.ok(!/process\.exit/.test(check), 'and never exits');

  // Only the 'apply' path may exit, and only before listening.
  const start = source.slice(source.indexOf('async function start'));
  const exits = start.slice(0, start.indexOf('app.listen'));
  assert.match(exits, /mode === 'apply'/);
  assert.ok(!/process\.exit/.test(start.slice(start.indexOf('app.listen'))), 'nothing after listen exits');
});

test('the boot check does not wait for a connection; the migration run does', async () => {
  // Reporting is not worth waiting for: a refused connection should let the
  // boot carry on, not spend 90 seconds of log saying it is still trying.
  const { connectForMigration } = await import('../src/db/migrate.js');
  let tries = 0;
  const alwaysFull = {
    connect: async () => {
      tries += 1;
      throw REFUSAL();
    },
  };
  await assert.rejects(connectForMigration(alwaysFull, { attempts: 1, sleep: async () => {} }), /EMAXCONNSESSION/);
  assert.equal(tries, 1, 'one attempt, no backoff');

  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/db/migrate.js', import.meta.url), 'utf8'),
  );
  const check = source.slice(source.indexOf('export async function pendingMigrations'));
  assert.match(check, /connectForMigration\(pool \?\? ownPool, \{ attempts: 1 \}\)/);
});
