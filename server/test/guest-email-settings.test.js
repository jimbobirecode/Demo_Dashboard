/**
 * What the club sends guests without anybody pressing a button.
 *
 * The acknowledgement of a change request went out with the request itself,
 * chosen by nobody. These cover the shape of the switch that replaced it: off
 * unless the club says otherwise, and nothing else writable through it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUEST_EMAIL_DEFAULTS,
  readGuestEmailSettings,
  validateGuestEmailSettings,
} from '../src/lib/guest-email-settings.js';

test('a club that has saved nothing sends nothing', () => {
  assert.deepEqual(readGuestEmailSettings(null), { requestReceived: false });
  assert.deepEqual(readGuestEmailSettings({}), { requestReceived: false });
  // Not an object: a column holding junk still reads as the defaults rather
  // than throwing on a guest's request.
  assert.deepEqual(readGuestEmailSettings([1, 2]), { requestReceived: false });
  assert.deepEqual(readGuestEmailSettings('yes'), { requestReceived: false });
  assert.equal(GUEST_EMAIL_DEFAULTS.requestReceived, false);
});

test('a club that turned it on gets it back, and only the keys this module owns', () => {
  assert.deepEqual(readGuestEmailSettings({ requestReceived: true }), { requestReceived: true });
  // A key written by some future version, or by hand, is not carried through.
  assert.deepEqual(readGuestEmailSettings({ requestReceived: true, somethingElse: true }), {
    requestReceived: true,
  });
});

test('saving takes booleans, and refuses anything else with a reason', () => {
  assert.deepEqual(validateGuestEmailSettings({ requestReceived: true }), {
    ok: true,
    value: { requestReceived: true },
    errors: [],
  });

  const unknown = validateGuestEmailSettings({ sendEverything: true });
  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.errors, ['sendEverything is not a setting']);

  const wrongType = validateGuestEmailSettings({ requestReceived: 'on' });
  assert.equal(wrongType.ok, false);
  assert.deepEqual(wrongType.errors, ['requestReceived must be true or false']);

  assert.equal(validateGuestEmailSettings(null).ok, false);
  assert.equal(validateGuestEmailSettings([]).ok, false);
});
