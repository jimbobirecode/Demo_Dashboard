/**
 * requireAuth and the password helpers against a stand-in database: the
 * pool's query method is replaced, so these run without Postgres.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-secret';
const { pool } = await import('../src/db.js');
const auth = await import('../src/auth.js');

let users;
pool.query = async (text, params = []) => {
  if (text.includes('session_version = session_version + 1') && text.trim().startsWith('UPDATE')) {
    const user = users.get(Number(params.at(-1)));
    if (user) user.session_version += 1;
    if (text.includes('password_hash = $1')) {
      Object.assign(user, { password_hash: params[0], temp_password: null, must_change_password: false });
      return { rows: [{ ...user }], rowCount: 1 };
    }
    return { rows: [], rowCount: user ? 1 : 0 };
  }
  if (text.includes('SET temp_password = $1')) {
    const user = users.get(Number(params[1]));
    user.temp_password = params[0];
    return { rows: [], rowCount: 1 };
  }
  if (text.includes('WHERE temp_password IS NOT NULL')) {
    return { rows: [...users.values()].filter((u) => u.temp_password).map((u) => ({ ...u })) };
  }
  if (text.includes('FROM public.dashboard_users WHERE id = $1')) {
    const user = users.get(Number(params[0]));
    return { rows: user ? [{ ...user }] : [] };
  }
  if (text.includes('LOWER(username) = LOWER($1)')) {
    const user = [...users.values()].find((u) => u.username === String(params[0]).toLowerCase());
    return { rows: user ? [{ ...user }] : [] };
  }
  if (text.includes('last_login = NOW()')) return { rows: [], rowCount: 1 };
  throw new Error(`unexpected query: ${text}`);
};

function reset() {
  users = new Map([[1, {
    id: 1, username: 'ann', email: 'ann@club.test', password_hash: null, temp_password: null,
    customer_id: 'royal_dornoch', full_name: 'Ann', is_active: true, must_change_password: false,
    role: 'admin', session_version: 0,
  }]]);
  auth.forgetSessionUser(1);
}

function tokenFor(user, extra = {}) {
  return jwt.sign({ sub: String(user.id), customerId: user.customer_id, sv: user.session_version, ...extra }, 'test-secret');
}

async function call(token, path = '/api/bookings') {
  const req = { cookies: { teemail_session: token }, baseUrl: path, path: '' };
  const res = {
    statusCode: 200, body: null, cleared: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    clearCookie() { this.cleared = true; },
  };
  let passed = false;
  await auth.requireAuth(req, res, () => { passed = true; });
  return { passed, res, req };
}

test('a current session passes, with role and club from the database', async () => {
  reset();
  const token = tokenFor(users.get(1), { role: 'staff', customerId: 'royal_dornoch' });
  const { passed, req } = await call(token);
  assert.equal(passed, true);
  assert.equal(req.user.role, 'admin', 'the row says admin, whatever the token says');
});

test('bumping the version ends the session at once on this instance', async () => {
  reset();
  const token = tokenFor(users.get(1));
  assert.equal((await call(token)).passed, true, 'cached now');
  await auth.bumpSessionVersion(1);
  const after = await call(token);
  assert.equal(after.passed, false);
  assert.equal(after.res.statusCode, 401);
  assert.equal(after.res.cleared, true);
});

test('deactivating or deleting the account ends the session', async () => {
  reset();
  const token = tokenFor(users.get(1));
  users.get(1).is_active = false;
  assert.equal((await call(token)).passed, false);

  reset();
  users.delete(1);
  assert.equal((await call(tokenFor({ id: 1, customer_id: 'royal_dornoch', session_version: 0 }))).passed, false);
});

test('a token carrying another session version is refused', async () => {
  reset();
  const token = tokenFor(users.get(1), { sv: 42 });
  assert.equal((await call(token)).passed, false);
});

test('deactivating an account ends its session', async () => {
  reset();
  const token = tokenFor(users.get(1));
  assert.equal((await call(token)).passed, true);
  users.get(1).is_active = false;
  auth.forgetSessionUser(1);
  assert.equal((await call(token)).passed, false);
});

test('a portal token is never a staff session', async () => {
  reset();
  const token = jwt.sign({ kind: 'operator', sub: '1', customerId: 'royal_dornoch' }, 'test-secret');
  assert.equal((await call(token)).res.statusCode, 401);
});

test('a temporary-password session is held on the password screens', async () => {
  reset();
  users.get(1).must_change_password = true;
  const token = tokenFor(users.get(1));
  const blocked = await call(token, '/api/bookings');
  assert.equal(blocked.res.statusCode, 403);
  assert.equal(blocked.res.body.mustChangePassword, true);
  assert.equal((await call(token, '/api/auth/me')).passed, true);
  assert.equal((await call(token, '/api/auth/change-password')).passed, true);
});

test('a plaintext temp password still works once, and is hashed on use', async () => {
  reset();
  Object.assign(users.get(1), { temp_password: 'Temp-pass-1', must_change_password: true });
  const result = await auth.authenticateUser('ann', 'Temp-pass-1');
  assert.equal(result.mustChangePassword, true);
  assert.match(users.get(1).temp_password, /^\$2[aby]\$/);

  assert.ok(await auth.authenticateUser('ann', 'Temp-pass-1'), 'and the hash then matches');
  assert.equal(await auth.authenticateUser('ann', 'wrong'), null);
});

test('startup hashes every plaintext temp password left in the table', async () => {
  reset();
  Object.assign(users.get(1), { temp_password: 'Temp-pass-1', must_change_password: true });
  // The guarded UPDATE matches on the old value; the stub accepts it.
  assert.equal(await auth.hashLegacyTempPasswords(), 1);
  assert.equal(await bcrypt.compare('Temp-pass-1', users.get(1).temp_password), true);
  assert.equal(await auth.hashLegacyTempPasswords(), 0, 'nothing left to hash');
});

test('changing a password ends other sessions and needs the current one', async () => {
  reset();
  users.get(1).password_hash = await bcrypt.hash('old-password', 4);
  const before = tokenFor(users.get(1));

  assert.equal(await auth.verifyCurrentPassword(1, 'nope'), false);
  assert.equal(await auth.verifyCurrentPassword(1, undefined), false);
  assert.equal(await auth.verifyCurrentPassword(1, 'old-password'), true);

  const updated = await auth.setPermanentPassword(1, 'new-password');
  assert.equal(updated.session_version, 1);
  assert.equal((await call(before)).passed, false, 'the old cookie is dead');
  assert.equal((await call(tokenFor(updated))).passed, true, 'a re-issued one works');
});
