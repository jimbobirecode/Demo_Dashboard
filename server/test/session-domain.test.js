import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedDuringPasswordChange,
  evaluateSession,
  isBcryptHash,
  patchRevokesSessions,
  sessionClaims,
} from '../src/lib/session-domain.js';

const ROW = {
  id: 7, username: 'ann', customer_id: 'royal_dornoch', full_name: 'Ann',
  role: 'staff', is_active: true, session_version: 3, must_change_password: false,
};

test('a token carries the session version it was issued at', () => {
  const claims = sessionClaims(ROW);
  assert.equal(claims.sub, '7');
  assert.equal(claims.sv, 3);
  assert.equal(sessionClaims({ ...ROW, session_version: undefined }).sv, 0, 'pre-migration rows read as 0');
  assert.equal(sessionClaims({ ...ROW, role: undefined }).role, 'admin', 'pre-roles installs');
});

test('a matching, active account passes, with authority read from the row', () => {
  const verdict = evaluateSession({ sub: '7', sv: 3, role: 'admin', customerId: 'elsewhere' }, ROW, { hasVersion: true });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.user.role, 'staff', 'a demoted admin is staff on the next request');
  assert.equal(verdict.user.customerId, 'royal_dornoch', 'the club is the row\'s, not the token\'s');
  assert.equal(verdict.user.mustChangePassword, false);
});

test('a bumped version, a deactivation or a deletion ends the session', () => {
  assert.equal(evaluateSession({ sv: 2 }, ROW, { hasVersion: true }).ok, false);
  assert.equal(evaluateSession({ sv: 3 }, { ...ROW, is_active: false }, { hasVersion: true }).ok, false);
  assert.equal(evaluateSession({ sv: 3 }, null, { hasVersion: true }).ok, false);
  assert.equal(evaluateSession({ sv: 3 }, { ...ROW, customer_id: null }, { hasVersion: true }).ok, false);
});

test('without the column, versions are ignored but the row still decides', () => {
  assert.equal(evaluateSession({ sv: 99 }, ROW, { hasVersion: false }).ok, true);
  assert.equal(evaluateSession({}, { ...ROW, is_active: false }, { hasVersion: false }).ok, false);
});

test('a token minted before versions existed matches a fresh column', () => {
  assert.equal(evaluateSession({ sub: '7' }, { ...ROW, session_version: 0 }, { hasVersion: true }).ok, true);
});

test('a temporary-password session reaches only the password screens', () => {
  assert.equal(allowedDuringPasswordChange('/api/auth/me'), true);
  assert.equal(allowedDuringPasswordChange('/api/auth/change-password'), true);
  assert.equal(allowedDuringPasswordChange('/api/auth/logout/'), true);
  assert.equal(allowedDuringPasswordChange('/api/bookings'), false);
  assert.equal(allowedDuringPasswordChange('/api/users'), false);
  assert.equal(
    evaluateSession({ sv: 3 }, { ...ROW, must_change_password: true }, { hasVersion: true }).user.mustChangePassword,
    true,
  );
});

test('bcrypt hashes are told apart from plaintext temp passwords', () => {
  assert.equal(isBcryptHash('$2a$12$abcdefghijklmnopqrstuuJ2y5c6m5o1yQyY3vOe2m8wzv1E5S8yS'), true);
  assert.equal(isBcryptHash('$2b$10$' + 'a'.repeat(53)), true);
  assert.equal(isBcryptHash('Dornoch2026!'), false);
  assert.equal(isBcryptHash('$2a$12$short'), false);
  assert.equal(isBcryptHash(null), false);
});

test('losing access or a role ends sessions; a new name does not', () => {
  assert.equal(patchRevokesSessions({ is_active: false }), true);
  assert.equal(patchRevokesSessions({ role: 'staff' }), true);
  assert.equal(patchRevokesSessions({ role: 'admin' }), true);
  assert.equal(patchRevokesSessions({ full_name: 'Ann B' }), false);
  assert.equal(patchRevokesSessions({ is_active: true }), false);
});
