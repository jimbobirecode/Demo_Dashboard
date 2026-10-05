/**
 * The security-critical HTTP paths, end to end against a real Postgres:
 * sign-in and its throttle, session checks, CSRF, club scoping (IDOR),
 * admin-only routes, the operator portal's walls and the guest manage link.
 *
 * Runs only with TEST_DATABASE_URL; each run migrates its own scratch
 * database and drops it afterwards.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createScratchDatabase, skip } from './helpers.js';

const SECRET = 'integration-test-secret';
const LINK_SECRET = 'integration-link-secret';
const PASSWORD = 'Correct-horse-9';
const CSRF = { 'X-Requested-With': 'teemail' };

let db;
let request;
let app;
let pool;
let hashToken;
let signBooking;
const ids = {};

async function seed() {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const user = async (username, club, role) => {
    const { rows } = await pool.query(
      `INSERT INTO dashboard_users (username, email, password_hash, customer_id, full_name, role, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id`,
      [username, username, hash, club, username, role],
    );
    return rows[0].id;
  };
  ids.adminA = await user('admin@club-a.test', 'club_a', 'admin');
  ids.staffA = await user('staff@club-a.test', 'club_a', 'staff');
  ids.throttled = await user('throttled@club-a.test', 'club_a', 'staff');
  ids.adminB = await user('admin@club-b.test', 'club_b', 'admin');

  const operator = async (club, name, domain) => {
    const { rows } = await pool.query(
      `INSERT INTO tour_operators (club, name, contact_email, email_domains)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [club, name, `accounts@${domain}`, [domain]],
    );
    return rows[0].id;
  };
  ids.op1 = await operator('club_a', 'First Tours', 'first-tours.test');
  ids.op2 = await operator('club_a', 'Second Tours', 'second-tours.test');
  ids.opB = await operator('club_b', 'Club B Tours', 'b-tours.test');

  const booking = (id, email, club, operatorId = null) =>
    pool.query(
      `INSERT INTO bookings (booking_id, guest_email, guest_name, date, tee_time, players, total, status, note, club, tour_operator_id)
       VALUES ($1, $2, 'Guest', CURRENT_DATE + 30, '09:00 AM', 4, 400, 'Requested', 'note', $3, $4)`,
      [id, email, club, operatorId],
    );
  await booking('A-1', 'guest@a.test', 'club_a');
  await booking('B-1', 'guest@b.test', 'club_b');
  await booking('OP1-1', 'groups@first-tours.test', 'club_a', ids.op1);
  await booking('OP2-1', 'groups@second-tours.test', 'club_a', ids.op2);
}

/** A signed-in agent for a staff account. */
async function signIn(email) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set(CSRF).send({ email, password: PASSWORD });
  assert.equal(res.status, 200, `sign-in for ${email} failed: ${JSON.stringify(res.body)}`);
  return agent;
}

describe('HTTP routes against Postgres', { skip }, () => {
  before(async () => {
    db = await createScratchDatabase('routes_test');
    Object.assign(process.env, {
      DATABASE_URL: db.url,
      JWT_SECRET: SECRET,
      BOOKING_LINK_SECRET: LINK_SECRET,
      NODE_ENV: 'test',
    });
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.SENDGRID_API_KEY;

    ({ default: request } = await import('supertest'));
    ({ app } = await import('../../src/app.js'));
    ({ pool } = await import('../../src/db.js'));
    ({ hashToken } = await import('../../src/lib/password-reset-domain.js'));
    ({ signBooking } = await import('../../src/lib/change-request-domain.js'));
    const { migrate } = await import('../../src/db/migrate.js');
    await migrate({ pool });
    await seed();
  });

  after(async () => {
    await pool?.end();
    await db?.drop();
  });

  describe('sign-in', () => {
    test('the right password signs in and /me answers for that account', async () => {
      const agent = await signIn('staff@club-a.test');
      const me = await agent.get('/api/auth/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.user.customerId, 'club_a');
      assert.equal(me.body.user.role, 'staff');
    });

    test('a wrong password and an unknown account get the same 401', async () => {
      const wrong = await request(app)
        .post('/api/auth/login')
        .set(CSRF)
        .send({ email: 'admin@club-a.test', password: 'nope-nope-1' });
      const unknown = await request(app)
        .post('/api/auth/login')
        .set(CSRF)
        .send({ email: 'nobody@club-a.test', password: 'nope-nope-1' });
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.deepEqual(wrong.body, unknown.body);
      assert.equal(wrong.headers['set-cookie'], undefined);
    });

    test('five failures lock the account out, even for the right password', async () => {
      for (let i = 0; i < 5; i += 1) {
        const res = await request(app)
          .post('/api/auth/login')
          .set(CSRF)
          .send({ email: 'throttled@club-a.test', password: `wrong-${i}-pass` });
        assert.equal(res.status, 401);
      }
      const locked = await request(app)
        .post('/api/auth/login')
        .set(CSRF)
        .send({ email: 'throttled@club-a.test', password: PASSWORD });
      assert.equal(locked.status, 429);
      assert.ok(Number(locked.headers['retry-after']) > 0);
    });
  });

  describe('requireAuth', () => {
    const token = (claims, secret = SECRET) => jwt.sign(claims, secret, { expiresIn: '1h' });
    const cookie = (value) => `teemail_session=${value}`;
    const claimsFor = (id, extra = {}) => ({
      sub: String(id),
      username: 'staff@club-a.test',
      customerId: 'club_a',
      role: 'staff',
      sv: 0,
      ...extra,
    });

    test('no cookie, a garbage cookie or a foreign signature is refused', async () => {
      assert.equal((await request(app).get('/api/bookings')).status, 401);
      assert.equal((await request(app).get('/api/bookings').set('Cookie', cookie('not-a-jwt'))).status, 401);
      const forged = token(claimsFor(ids.staffA), 'some-other-secret');
      assert.equal((await request(app).get('/api/bookings').set('Cookie', cookie(forged))).status, 401);
    });

    test('a well-signed token from an older session version is refused', async () => {
      const fresh = token(claimsFor(ids.staffA));
      assert.equal((await request(app).get('/api/auth/me').set('Cookie', cookie(fresh))).status, 200);

      await pool.query('UPDATE dashboard_users SET session_version = session_version + 1 WHERE id = $1', [ids.staffA]);
      // The session cache holds a row for 20s; a new account id is not cached.
      const { forgetSessionUser } = await import('../../src/auth.js');
      forgetSessionUser(ids.staffA);
      const stale = await request(app).get('/api/auth/me').set('Cookie', cookie(fresh));
      assert.equal(stale.status, 401);

      const current = token(claimsFor(ids.staffA, { sv: 1 }));
      assert.equal((await request(app).get('/api/auth/me').set('Cookie', cookie(current))).status, 200);
    });

    test('a token claiming another club still gets the club on the account', async () => {
      const lying = token(claimsFor(ids.adminB, { customerId: 'club_a', role: 'admin' }));
      const res = await request(app).get('/api/bookings').set('Cookie', cookie(lying));
      assert.equal(res.status, 200);
      assert.deepEqual(
        res.body.bookings.map((b) => b.bookingId),
        ['B-1'],
      );
    });

    test('a portal token is never a staff session', async () => {
      const portal = token({ kind: 'operator', sub: String(ids.staffA), customerId: 'club_a', operatorId: ids.op1 });
      assert.equal((await request(app).get('/api/bookings').set('Cookie', cookie(portal))).status, 401);
    });
  });

  describe('CSRF header', () => {
    test('a state-changing call without the header is refused before the route runs', async () => {
      const agent = await signIn('admin@club-a.test');
      const res = await agent.patch('/api/bookings/A-1/status').send({ status: 'Booked' });
      assert.equal(res.status, 403);
      const { rows } = await pool.query("SELECT status FROM bookings WHERE booking_id = 'A-1'");
      assert.equal(rows[0].status, 'Requested');
    });

    test('sign-in itself needs the header, and a foreign Origin is refused', async () => {
      const bare = await request(app).post('/api/auth/login').send({ email: 'x@y.test', password: 'whatever-1' });
      assert.equal(bare.status, 403);
      const foreign = await request(app)
        .post('/api/auth/login')
        .set(CSRF)
        .set('Origin', 'https://evil.test')
        .send({ email: 'x@y.test', password: 'whatever-1' });
      assert.equal(foreign.status, 403);
    });
  });

  describe('club scoping (IDOR)', () => {
    test("club A's staff never see or change club B's booking", async () => {
      const agent = await signIn('admin@club-a.test');

      const list = await agent.get('/api/bookings');
      assert.equal(list.status, 200);
      const visible = list.body.bookings.map((b) => b.bookingId);
      assert.ok(visible.includes('A-1'));
      assert.ok(!visible.includes('B-1'));

      const patch = await agent.patch('/api/bookings/B-1/status').set(CSRF).send({ status: 'Cancelled' });
      assert.equal(patch.status, 404);
      const note = await agent.patch('/api/bookings/B-1/note').set(CSRF).send({ note: 'pwned' });
      assert.equal(note.status, 404);
      const { rows } = await pool.query("SELECT status, note FROM bookings WHERE booking_id = 'B-1'");
      assert.deepEqual(rows[0], { status: 'Requested', note: 'note' });

      assert.equal((await agent.get('/api/inbox/booking/B-1')).status, 404);
      assert.equal((await agent.get(`/api/operators/${ids.opB}`)).status, 404);
      const assign = await agent
        .post('/api/operators/assign')
        .set(CSRF)
        .send({ bookingIds: ['A-1'], operatorId: ids.opB });
      assert.equal(assign.status, 404, 'an operator id from another club is not accepted');
    });

    test("an administrator only ever sees their own club's accounts", async () => {
      const agent = await signIn('admin@club-a.test');
      const res = await agent.get('/api/users');
      assert.equal(res.status, 200);
      const names = res.body.users.map((u) => u.username);
      assert.ok(names.includes('staff@club-a.test'));
      assert.ok(!names.includes('admin@club-b.test'));
      const other = await agent.patch(`/api/users/${ids.adminB}`).set(CSRF).send({ fullName: 'Renamed' });
      assert.equal(other.status, 404);
    });
  });

  describe('administrator-only routes', () => {
    test('staff are refused user admin, deletes and payment diagnostics', async () => {
      const agent = await signIn('staff@club-a.test');
      assert.equal((await agent.get('/api/users')).status, 403);
      assert.equal((await agent.post('/api/users').set(CSRF).send({ username: 'new@club-a.test' })).status, 403);
      assert.equal((await agent.delete('/api/bookings/A-1').set(CSRF)).status, 403);
      assert.equal((await agent.delete('/api/imports/some-batch').set(CSRF)).status, 403);
      assert.equal((await agent.get('/api/payments/diagnostics')).status, 403);
      assert.equal((await agent.delete(`/api/operators/${ids.op1}`).set(CSRF)).status, 403);
      assert.equal((await agent.delete('/api/waitlist/WL-NONE').set(CSRF)).status, 403);
      const { rows } = await pool.query("SELECT 1 FROM bookings WHERE booking_id = 'A-1'");
      assert.equal(rows.length, 1);
      const { rows: ops } = await pool.query('SELECT 1 FROM tour_operators WHERE id = $1', [ids.op1]);
      assert.equal(ops.length, 1);
    });

    test('the payment webhook log shows a club only its own deliveries', async () => {
      const { logWebhook } = await import('../../src/lib/webhook-log.js');
      logWebhook({ outcome: 'recorded', bookingId: 'B-1', club: 'club_b', detail: 'club b' });
      logWebhook({ outcome: 'recorded', bookingId: 'A-1', club: 'club_a', detail: 'club a' });
      logWebhook({ outcome: 'rejected', detail: 'Signature mismatch' });
      const agent = await signIn('staff@club-a.test');
      const res = await agent.get('/api/payments/config');
      assert.equal(res.status, 200);
      const text = JSON.stringify(res.body.webhooks);
      assert.ok(text.includes('A-1') && text.includes('Signature mismatch'));
      assert.ok(!text.includes('B-1') && !text.includes('club b'), 'nothing of club B');
    });
  });

  describe('Inbox', () => {
    test('emails the core API is still processing are not counted or listed as needing a person', async () => {
      await pool.query(
        `INSERT INTO email_messages (club, direction, from_email, subject, body_text, routed_to, review_status, message_id)
         VALUES ('club_a', 'inbound', 'g@a.test', 'held', 'b', 'inbox', 'open', '<1@a.test>'),
                ('club_a', 'inbound', 'g@a.test', 'queued', 'b', 'queued', 'open', '<2@a.test>'),
                ('club_a', 'inbound', 'g@a.test', 'working', 'b', 'processing', 'open', '<3@a.test>')`,
      );
      const agent = await signIn('staff@club-a.test');
      const open = await agent.get('/api/inbox').query({ status: 'open' });
      assert.equal(open.status, 200);
      assert.equal(open.body.counts.open, 1);
      assert.deepEqual(
        open.body.messages.map((m) => m.subject),
        ['held'],
      );
      const all = await agent.get('/api/inbox').query({ status: 'all' });
      assert.ok(all.body.messages.some((m) => m.routeLabel === 'Being processed'));
      // The same Message-ID twice for one club is refused by the 0007 index.
      await assert.rejects(
        pool.query(
          `INSERT INTO email_messages (club, direction, message_id) VALUES ('club_a', 'inbound', '<1@a.test>')`,
        ),
        /uq_email_messages_inbound_message_id/,
      );
    });

    test('membership email is read on the Membership page, so it is in no Inbox list or count', async () => {
      const agent = await signIn('staff@club-a.test');
      const before = await agent.get('/api/inbox').query({ status: 'open' });

      await pool.query(
        `INSERT INTO email_messages (club, direction, from_email, subject, body_text, routed_to, review_status, review_reason, message_id)
         VALUES ('club_a', 'inbound', 'joiner@a.test', 'joining', 'b', 'membership', 'none', NULL, '<11@a.test>'),
                ('club_a', 'inbound', 'joiner@a.test', 'about my application', 'b', 'membership', 'none',
                 'Reply about membership application MEM-1 - for the team.', '<12@a.test>')`,
      );

      const open = await agent.get('/api/inbox').query({ status: 'open' });
      assert.equal(open.status, 200);
      assert.equal(open.body.counts.open, before.body.counts.open, 'membership email adds nothing to the Inbox');
      assert.deepEqual(
        open.body.messages.map((m) => m.subject),
        before.body.messages.map((m) => m.subject),
      );

      // Not under 'all' either: the Membership page is where it is read.
      const subjects = (await agent.get('/api/inbox').query({ status: 'all' })).body.messages.map((m) => m.subject);
      assert.ok(!subjects.includes('joining') && !subjects.includes('about my application'), subjects.join());
    });

    test('deleting takes an email out of every list and count, and putting it back undoes that', async () => {
      const { rows } = await pool.query(
        `INSERT INTO email_messages (club, direction, from_email, subject, body_text, routed_to, review_status, message_id)
         VALUES ('club_a', 'inbound', 'bin@a.test', 'delete me', 'b', 'inbox', 'open', '<20@a.test>') RETURNING id`,
      );
      const id = rows[0].id;
      const agent = await signIn('staff@club-a.test');
      const before = (await agent.get('/api/inbox').query({ status: 'open' })).body;

      const deleted = await agent.delete(`/api/inbox/${id}`).set(CSRF);
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.message.deletedBy, 'staff@club-a.test');
      assert.ok(deleted.body.message.deletedAt, 'stamped with when');

      for (const status of ['open', 'all']) {
        const list = (await agent.get('/api/inbox').query({ status })).body;
        assert.ok(!list.messages.some((m) => m.id === id), `still listed under ${status}`);
      }
      const after = (await agent.get('/api/inbox').query({ status: 'open' })).body;
      assert.equal(after.counts.open, before.counts.open - 1);
      assert.equal(after.counts.deleted, (before.counts.deleted ?? 0) + 1);

      // Only the filter of its own lists it, and it keeps the status it had.
      const bin = (await agent.get('/api/inbox').query({ status: 'deleted' })).body;
      const row = bin.messages.find((m) => m.id === id);
      assert.ok(row, 'not in the Deleted filter');
      assert.equal(row.reviewStatus, 'open');

      // Out of the conversation too, until it is back.
      await pool.query('UPDATE email_messages SET booking_id = $1 WHERE id = $2', ['A-1', id]);
      const thread = (await agent.get('/api/inbox/booking/A-1')).body;
      assert.ok(!thread.thread.some((m) => m.id === id), 'a deleted email is still in the booking conversation');

      // The only thing it accepts is being put back.
      assert.equal((await agent.post(`/api/inbox/${id}/reply`).set(CSRF).send({ body: 'hi' })).status, 409);
      assert.equal((await agent.post(`/api/inbox/${id}/status`).set(CSRF).send({ status: 'dismissed' })).status, 409);
      assert.equal((await agent.post(`/api/inbox/${id}/link`).set(CSRF).send({ bookingId: 'A-1' })).status, 409);
      assert.equal((await agent.post(`/api/inbox/${id}/notes`).set(CSRF).send({ note: 'x' })).status, 409);

      const restored = await agent.post(`/api/inbox/${id}/restore`).set(CSRF).send({});
      assert.equal(restored.status, 200);
      assert.equal(restored.body.message.deletedAt, null);
      assert.equal(restored.body.message.deletedBy, null);
      assert.equal(restored.body.message.reviewStatus, 'open', 'it comes back as it went');
      assert.ok(
        restored.body.thread.some((m) => m.id === id),
        'back in the conversation',
      );
    });

    test('an email the core API still has in hand cannot be deleted', async () => {
      const { rows } = await pool.query(
        `INSERT INTO email_messages (club, direction, from_email, subject, body_text, routed_to, review_status, message_id)
         VALUES ('club_a', 'inbound', 'busy@a.test', 'mid-flight', 'b', 'queued', 'open', '<21@a.test>') RETURNING id`,
      );
      const agent = await signIn('staff@club-a.test');
      const refused = await agent.delete(`/api/inbox/${rows[0].id}`).set(CSRF);
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /still working on this email/);
      const { rows: after } = await pool.query('SELECT deleted_at FROM email_messages WHERE id = $1', [rows[0].id]);
      assert.equal(after[0].deleted_at, null);
    });

    test('a note is stamped with the user who wrote it, and is another club\u2019s business never', async () => {
      const { rows } = await pool.query(
        `INSERT INTO email_messages (club, direction, from_email, subject, body_text, routed_to, review_status, message_id)
         VALUES ('club_a', 'inbound', 'noted@a.test', 'notes', 'b', 'inbox', 'open', '<22@a.test>') RETURNING id`,
      );
      const id = rows[0].id;
      const staff = await signIn('staff@club-a.test');
      const admin = await signIn('admin@club-a.test');

      assert.equal((await staff.post(`/api/inbox/${id}/notes`).set(CSRF).send({ note: '  ' })).status, 400);
      assert.equal(
        (
          await staff
            .post(`/api/inbox/${id}/notes`)
            .set(CSRF)
            .send({ note: 'x'.repeat(2001) })
        ).status,
        400,
      );

      await staff.post(`/api/inbox/${id}/notes`).set(CSRF).send({ note: 'Called her back' });
      const second = await admin.post(`/api/inbox/${id}/notes`).set(CSRF).send({ note: 'Moved to the Tuesday' });
      assert.equal(second.status, 200);
      assert.deepEqual(
        second.body.notes.map((n) => [n.note, n.createdBy]),
        [
          ['Called her back', 'staff@club-a.test'],
          ['Moved to the Tuesday', 'admin@club-a.test'],
        ],
        'oldest first, each with its own author',
      );
      assert.ok(second.body.notes.every((n) => n.createdAt));

      // The notes come back with the email every time it is read.
      assert.equal((await staff.get(`/api/inbox/${id}`)).body.notes.length, 2);

      // Another club cannot read or write them.
      const other = await signIn('admin@club-b.test');
      assert.equal((await other.get(`/api/inbox/${id}`)).status, 404);
      assert.equal((await other.post(`/api/inbox/${id}/notes`).set(CSRF).send({ note: 'x' })).status, 404);
      assert.equal((await other.delete(`/api/inbox/${id}`).set(CSRF)).status, 404);
      assert.equal((await other.post(`/api/inbox/${id}/restore`).set(CSRF).send({})).status, 404);
    });
  });

  describe('operator portal', () => {
    async function portalAgent(operatorId, email) {
      const token = `portal-test-token-${operatorId}-${Date.now()}`;
      await pool.query(
        `INSERT INTO operator_portal_links (club, operator_id, email, token_hash, expires_at)
         VALUES ('club_a', $1, $2, $3, NOW() + INTERVAL '10 minutes')`,
        [operatorId, email, hashToken(token)],
      );
      const agent = request.agent(app);
      const res = await agent.post('/api/portal/session').set(CSRF).send({ token });
      assert.equal(res.status, 200);
      const cookie = res.headers['set-cookie'].find((c) => c.startsWith('teemail_operator=')).split(';')[0];
      return { agent, token, cookie };
    }

    test('signing out revokes the session, so a copied cookie stops working', async () => {
      const { agent, cookie } = await portalAgent(ids.op1, 'accounts@first-tours.test');
      assert.equal((await request(app).get('/api/portal/me').set('Cookie', cookie)).status, 200);
      assert.equal((await agent.post('/api/portal/logout').set(CSRF)).status, 200);
      assert.equal((await request(app).get('/api/portal/me').set('Cookie', cookie)).status, 401);
    });

    test('a portal token without a session row is refused', async () => {
      const forged = jwt.sign(
        { kind: 'operator', operatorId: ids.op1, club: 'club_a', email: 'accounts@first-tours.test' },
        SECRET,
      );
      const res = await request(app).get('/api/portal/me').set('Cookie', `teemail_operator=${forged}`);
      assert.equal(res.status, 401);
    });

    test('asking for a new sign-in link retires the unused older ones', async () => {
      const email = 'accounts@first-tours.test';
      const old = `portal-old-${Date.now()}`;
      await pool.query(
        `INSERT INTO operator_portal_links (club, operator_id, email, token_hash, expires_at)
         VALUES ('club_a', $1, $2, $3, NOW() + INTERVAL '10 minutes')`,
        [ids.op1, email, hashToken(old)],
      );
      const before = (await pool.query('SELECT COUNT(*)::int AS n FROM operator_portal_links')).rows[0].n;
      assert.equal((await request(app).post('/api/portal/login').set(CSRF).send({ email })).status, 200);
      // The link is written after the reply, so wait for it.
      for (let i = 0; i < 50; i += 1) {
        const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM operator_portal_links');
        if (rows[0].n > before) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const res = await request(app).post('/api/portal/session').set(CSRF).send({ token: old });
      assert.equal(res.status, 400);
    });

    test("an operator sees only their own bookings and cannot act on another's", async () => {
      const { agent, token } = await portalAgent(ids.op1, 'accounts@first-tours.test');

      const list = await agent.get('/api/portal/bookings');
      assert.equal(list.status, 200);
      assert.deepEqual(
        list.body.bookings.map((b) => b.bookingId),
        ['OP1-1'],
      );

      const theirs = await agent
        .post('/api/portal/bookings/OP2-1/request')
        .set(CSRF)
        .send({ kind: 'cancel', message: 'cancel it' });
      assert.equal(theirs.status, 404);
      const otherClub = await agent.post('/api/portal/bookings/B-1/pay').set(CSRF).send({});
      assert.notEqual(otherClub.status, 200);

      // A link works once.
      const again = await request(app).post('/api/portal/session').set(CSRF).send({ token });
      assert.equal(again.status, 400);
    });

    test('a portal session is no use on the staff dashboard', async () => {
      const { agent } = await portalAgent(ids.op1, 'accounts@first-tours.test');
      assert.equal((await agent.get('/api/bookings')).status, 401);
    });

    test('retiring the operator ends the session', async () => {
      const { agent } = await portalAgent(ids.op2, 'accounts@second-tours.test');
      assert.equal((await agent.get('/api/portal/me')).status, 200);
      await pool.query('UPDATE tour_operators SET active = FALSE WHERE id = $1', [ids.op2]);
      assert.equal((await agent.get('/api/portal/me')).status, 401);
    });
  });

  describe('guest manage-booking link', () => {
    test('a bad or missing token is refused without saying whether the booking exists', async () => {
      const bad = await request(app)
        .get('/api/changes/booking')
        .query({ ref: 'A-1', token: 'x'.repeat(32) });
      const missing = await request(app)
        .get('/api/changes/booking')
        .query({ ref: 'NO-SUCH', token: 'x'.repeat(32) });
      assert.equal(bad.status, 404);
      assert.equal(missing.status, 404);
      assert.deepEqual(bad.body, missing.body);
    });

    test("a token signed for one club does not open another club's booking", async () => {
      const wrongClub = signBooking('B-1', LINK_SECRET, 'club_a');
      const res = await request(app).get('/api/changes/booking').query({ ref: 'B-1', token: wrongClub });
      assert.equal(res.status, 404);
    });

    test('the right token opens the booking without its private fields', async () => {
      const res = await request(app)
        .get('/api/changes/booking')
        .query({ ref: 'A-1', token: signBooking('A-1', LINK_SECRET, 'club_a') });
      assert.equal(res.status, 200);
      const text = JSON.stringify(res.body);
      assert.ok(!text.includes('"note"'), 'no staff note');
      assert.ok(!text.includes('amountPaid'), 'no payment state');
    });
  });
});
