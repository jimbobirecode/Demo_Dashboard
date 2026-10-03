import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeSyncResult } from '../src/lib/payment-sync.js';
import { logWebhook, recentWebhooks } from '../src/lib/webhook-log.js';

test('a sync run is reported to a club with only its own bookings', () => {
  const run = {
    reason: 'manual',
    startedAt: 't0',
    finishedAt: 't1',
    checked: 3,
    checkedClubs: ['a', 'b', 'b'],
    recorded: [
      { bookingId: 'A-1', club: 'a', result: 'Paid' },
      { bookingId: 'B-1', club: 'b', result: 'Paid' },
    ],
    errors: [
      { bookingId: 'B-2', club: 'b', error: 'Stripe 500' },
      { bookingId: null, club: null, error: 'run failed' },
    ],
    skipped: null,
  };
  const view = scopeSyncResult(run, 'a');
  assert.equal(view.checked, 1);
  assert.deepEqual(view.recorded, [{ bookingId: 'A-1', result: 'Paid' }]);
  assert.deepEqual(view.errors, [{ bookingId: null, error: 'run failed' }]);
  assert.equal(view.checkedClubs, undefined);
  assert.equal(JSON.stringify(view).includes('B-'), false);
});

test("the webhook log hides other clubs' entries and the booking of club-less ones", () => {
  logWebhook({ outcome: 'recorded', bookingId: 'X-1', club: 'x', detail: 'x' });
  logWebhook({ outcome: 'skipped', bookingId: 'Y-1', club: null, detail: 'skipped: no matching booking' });
  const { entries } = recentWebhooks('z');
  assert.ok(entries.every((entry) => entry.bookingId === null && !('club' in entry)));
  assert.equal(entries.length >= 1, true);
  assert.equal(
    recentWebhooks('x').entries.some((entry) => entry.bookingId === 'X-1'),
    true,
  );
});
