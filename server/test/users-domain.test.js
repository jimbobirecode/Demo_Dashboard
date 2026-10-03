import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES,
  buildUserUpdate,
  guardDelete,
  guardSelfLockout,
  isAdmin,
  isPending,
  normaliseRole,
  serialiseUser,
  validateNewUser,
  validateUserPatch,
} from '../src/lib/users-domain.js';

const ADMIN = { id: 1, username: 'boss', role: 'admin', is_active: true };
const STAFF = { id: 2, username: 'ann', role: 'staff', is_active: true };

test('roles are a closed set, and anything unknown is the safe one', () => {
  assert.deepEqual(ROLES, ['admin', 'staff']);
  assert.equal(normaliseRole('ADMIN'), 'admin');
  assert.equal(normaliseRole('superuser'), 'staff', 'an unknown role never grants more');
  assert.equal(normaliseRole(undefined), 'staff');
  assert.equal(isAdmin(ADMIN), true);
  assert.equal(isAdmin(STAFF), false);
  assert.equal(isAdmin({}), false, 'a row with no role is not an administrator');
});

test('an account with no password of any kind is still pending', () => {
  assert.equal(isPending({ password_hash: null, temp_password: null }), true);
  assert.equal(isPending({ password_hash: 'x' }), false);
  assert.equal(isPending({ temp_password: 'letmein' }), false, 'the Streamlit-era path counts');
});

test('the serialised user never carries a password', () => {
  const user = serialiseUser({
    id: 7,
    username: 'Ann',
    email: 'ann@club.com',
    full_name: 'Ann Bell',
    role: 'staff',
    customer_id: 'royal_dornoch',
    is_active: true,
    password_hash: '$2a$12$secret',
    temp_password: 'letmein',
    last_login: new Date('2026-09-01T09:00:00Z'),
    created_by: 'boss',
  });

  const text = JSON.stringify(user);
  assert.ok(!text.includes('$2a$12$secret'), 'the hash is a secret too');
  assert.ok(!text.includes('letmein'));
  assert.equal(user.pending, false);
  assert.equal(user.role, 'staff');
  assert.equal(user.lastLogin, '2026-09-01T09:00:00.000Z');
  assert.equal(user.active, true);
  assert.equal(serialiseUser({ id: 1, is_active: false }).active, false);
  assert.equal(serialiseUser({ id: 1 }).active, true, 'an install with no column is not locked out');
});

test('a new account needs a name, a usable login and somewhere to send the invitation', () => {
  const good = validateNewUser({ username: 'Ann.Bell', email: ' Ann@Club.com ', fullName: 'Ann Bell' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.value, {
    username: 'ann.bell',
    email: 'ann@club.com',
    fullName: 'Ann Bell',
    role: 'staff',
  });

  assert.equal(validateNewUser({ username: 'ab', email: 'a@b.co', fullName: 'A' }).ok, false, 'too short');
  assert.match(validateNewUser({ username: 'ann bell', email: 'a@b.co', fullName: 'A' }).errors[0], /letters, numbers/);
  assert.match(validateNewUser({ username: 'ann', email: 'nope', fullName: 'A' }).errors[0], /does not look valid/);
  assert.match(validateNewUser({ username: 'ann', fullName: 'A' }).errors[0], /required to send the invitation/);
  assert.match(validateNewUser({ username: 'ann', email: 'a@b.co' }).errors[0], /Full name/);
  assert.match(
    validateNewUser({ username: 'ann', email: 'a@b.co', fullName: 'A', role: 'root' }).errors[0],
    /Role must be/,
  );

  // An email-shaped username needs no separate address.
  const byUsername = validateNewUser({ username: 'ann@club.com', fullName: 'Ann Bell' });
  assert.equal(byUsername.ok, true);
  assert.equal(byUsername.value.email, 'ann@club.com');
});

test('the address is the login, so it is the username unless one is given', () => {
  const derived = validateNewUser({ email: 'Ann@Club.com', fullName: 'Ann Bell' });
  assert.equal(derived.ok, true, 'no username need be invented');
  assert.equal(derived.value.username, 'ann@club.com');
  assert.equal(derived.value.email, 'ann@club.com');

  // An install that already has usernames can still set one explicitly.
  const explicit = validateNewUser({ email: 'ann@club.com', username: 'annb', fullName: 'Ann Bell' });
  assert.equal(explicit.value.username, 'annb');
  assert.equal(explicit.value.email, 'ann@club.com');

  // A bad address must not also be reported as a bad username: the form no
  // longer shows a username field, so that error would be uncorrectable.
  const bad = validateNewUser({ email: 'nope', fullName: 'Ann Bell' });
  assert.deepEqual(bad.errors, ['That email address does not look valid']);
  assert.deepEqual(validateNewUser({ fullName: 'Ann Bell' }).errors, [
    'A valid email address is required to send the invitation',
  ]);
});

test('a patch may only touch the fields it is allowed to', () => {
  const patch = validateUserPatch({ fullName: ' Ann Bell ', role: 'ADMIN', active: false, email: 'A@B.co' });
  assert.deepEqual(patch.patch, {
    full_name: 'Ann Bell',
    email: 'a@b.co',
    role: 'admin',
    is_active: false,
  });

  assert.deepEqual(validateUserPatch({ email: '' }).patch, { email: null }, 'an address can be cleared');
  assert.match(validateUserPatch({ role: 'root' }).errors[0], /Role must be/);
  assert.match(validateUserPatch({ fullName: '  ' }).errors[0], /cannot be empty/);
  assert.match(validateUserPatch({}).errors[0], /Nothing to change/);
  assert.equal(
    validateUserPatch({ username: 'somebody-else', password_hash: 'x' }).ok,
    false,
    'a username or a hash is not a field this route accepts',
  );
});

test('an administrator cannot lock themselves out', () => {
  const many = { activeAdmins: 3 };

  assert.match(guardSelfLockout(ADMIN, ADMIN, { role: 'staff' }, many).reason, /your own administrator/);
  assert.match(guardSelfLockout(ADMIN, ADMIN, { is_active: false }, many).reason, /your own account/);
  assert.match(guardDelete(ADMIN, ADMIN, many).reason, /your own account/);

  assert.equal(guardSelfLockout(ADMIN, STAFF, { role: 'admin' }, many).ok, true);
  assert.equal(guardSelfLockout(ADMIN, STAFF, { is_active: false }, many).ok, true);
});

test('the last active administrator cannot be demoted, deactivated or deleted', () => {
  const alone = { activeAdmins: 1 };
  const other = { id: 9, username: 'second', role: 'admin', is_active: true };

  assert.match(guardSelfLockout(ADMIN, other, { role: 'staff' }, alone).reason, /last active administrator/);
  assert.match(guardSelfLockout(ADMIN, other, { is_active: false }, alone).reason, /last active administrator/);
  assert.match(guardDelete(ADMIN, other, alone).reason, /last active administrator/);

  // With a second admin in place the same edits are fine.
  assert.equal(guardSelfLockout(ADMIN, other, { role: 'staff' }, { activeAdmins: 2 }).ok, true);
  // Demoting somebody who is already deactivated cannot remove the last admin.
  assert.equal(guardSelfLockout(ADMIN, { ...other, is_active: false }, { role: 'staff' }, alone).ok, true);
  // A rename is not a loss of access, however few admins there are.
  assert.equal(guardSelfLockout(ADMIN, other, { full_name: 'New Name' }, alone).ok, true);
});

test('the update clause numbers its placeholders from where the caller is', () => {
  const { clauses, values } = buildUserUpdate({ full_name: 'Ann', role: 'admin' }, 1);
  assert.deepEqual(clauses, ['"full_name" = $1', '"role" = $2']);
  assert.deepEqual(values, ['Ann', 'admin']);

  assert.deepEqual(buildUserUpdate({ is_active: false }, 5).clauses, ['"is_active" = $5']);
  assert.deepEqual(buildUserUpdate({}).clauses, []);
});
