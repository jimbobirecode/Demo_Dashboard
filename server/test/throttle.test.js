import test from 'node:test';
import assert from 'node:assert/strict';
import { createThrottle } from '../src/lib/throttle.js';
import { createThrottle as legacyImport } from '../src/lib/password-reset-domain.js';

test('the throttle is still importable from where it used to live', () => {
  assert.equal(legacyImport, createThrottle);
});

test('failures are counted only when reported, and block at the limit', () => {
  const throttle = createThrottle({ limit: 3, windowMs: 60_000 });
  const now = 1_000_000;

  assert.equal(throttle.blocked('ann', now), false);
  throttle.fail('ann', now);
  throttle.fail('ann', now);
  assert.equal(throttle.blocked('ann', now), false, 'two of three used');
  throttle.fail('ann', now);
  assert.equal(throttle.blocked('ann', now), true, 'the third failure uses the budget');
  assert.equal(throttle.blocked('bob', now), false, 'keys are independent');
  assert.equal(throttle.blocked('ann', now + 60_001), false, 'the window rolls');
});

test('blocked() does not itself count as an attempt', () => {
  const throttle = createThrottle({ limit: 1, windowMs: 60_000 });
  for (let i = 0; i < 10; i += 1) assert.equal(throttle.blocked('ann', 5), false);
});

test('clear() forgets a key — a successful sign-in wipes its failures', () => {
  const throttle = createThrottle({ limit: 2, windowMs: 60_000 });
  throttle.fail('ann', 1);
  throttle.fail('ann', 1);
  assert.equal(throttle.blocked('ann', 2), true);
  throttle.clear('ann');
  assert.equal(throttle.blocked('ann', 2), false);
});

test('retryAfterSeconds says when the oldest counted failure ages out', () => {
  const throttle = createThrottle({ limit: 2, windowMs: 60_000 });
  assert.equal(throttle.retryAfterSeconds('ann', 0), 0, 'nothing to wait for');
  throttle.fail('ann', 0);
  throttle.fail('ann', 10_000);
  assert.equal(throttle.retryAfterSeconds('ann', 30_000), 30, 'the first failure frees a slot at 60s');
  assert.equal(throttle.retryAfterSeconds('ann', 59_999), 1, 'never rounds down to zero while blocked');
  assert.equal(throttle.retryAfterSeconds('ann', 60_001), 0);
});

test('check() still counts every call, for limits on asking', () => {
  const throttle = createThrottle({ limit: 2, windowMs: 1000 });
  assert.equal(throttle.check('k', 0), true);
  assert.equal(throttle.check('k', 0), true);
  assert.equal(throttle.check('k', 0), false);
});
