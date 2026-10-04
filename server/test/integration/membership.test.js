/**
 * The membership routes end to end against a real Postgres: the admin-only
 * switch, categories, club scoping (IDOR) on applications, the review
 * transitions and the emails they send, and waitlist invitations.
 *
 * Runs only with TEST_DATABASE_URL; migrates its own scratch database and
 * drops it afterwards. SendGrid is never reached: fetch is replaced with a
 * recorder for its endpoint.
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { createScratchDatabase, skip } from './helpers.js';

const PASSWORD = 'Correct-horse-9';
const CSRF = { 'X-Requested-With': 'teemail' };
const LINK_SECRET = 'membership-link-secret';

let db;
let request;
let app;
let pool;
let verifyMembershipToken;
const ids = {};
const sent = [];
const realFetch = globalThis.fetch;

async function seed() {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const user = (username, club, role) =>
    pool.query(
      `INSERT INTO dashboard_users (username, email, password_hash, customer_id, full_name, role, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
      [username, username, hash, club, username, role],
    );
  await user('admin@club-a.test', 'club_a', 'admin');
  await user('staff@club-a.test', 'club_a', 'staff');
  await user('admin@club-b.test', 'club_b', 'admin');

  const category = async (club, name, joining, annual) =>
    (
      await pool.query(
        `INSERT INTO membership_categories (club, name, joining_fee, annual_fee) VALUES ($1, $2, $3, $4) RETURNING id`,
        [club, name, joining, annual],
      )
    ).rows[0].id;
  ids.full = await category('club_a', 'Full', 2500, 1850);
  ids.junior = await category('club_a', 'Junior', 0, 250);
  ids.unused = await category('club_a', 'Unused', 0, 0);
  ids.fullB = await category('club_b', 'Full', 100, 100);

  const { rows: inbound } = await pool.query(
    `INSERT INTO email_messages (club, direction, from_email, subject, body_text, intent, routed_to)
     VALUES ('club_a', 'inbound', 'isla@example.com', 'Membership', 'I would like to join the club.', 'membership_enquiry', 'membership')
     RETURNING id`,
  );

  const application = async (club, reference, status, extra = {}) =>
    (
      await pool.query(
        `INSERT INTO membership_applications
           (club, reference, kind, status, category_id, first_name, last_name, email, recommended_category_ids, source_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'Applicant', $7, $8, $9) RETURNING id`,
        [
          club,
          reference,
          extra.kind ?? 'application',
          status,
          extra.categoryId ?? null,
          extra.firstName ?? 'Isla',
          extra.email ?? `${reference.toLowerCase()}@example.com`,
          extra.recommended ?? [],
          extra.sourceMessageId ?? null,
        ],
      )
    ).rows[0].id;
  ids.submitted = await application('club_a', 'MEM-20261001-AAAAAAAA', 'submitted', {
    categoryId: ids.full,
    recommended: [ids.full, ids.junior],
    sourceMessageId: inbound[0].id,
  });
  ids.review = await application('club_a', 'MEM-20261001-BBBBBBBB', 'under_review', { categoryId: ids.junior });
  ids.waitA = await application('club_a', 'MEM-20261001-CCCCCCCC', 'waitlisted', { kind: 'waitlist' });
  ids.waitA2 = await application('club_a', 'MEM-20261001-DDDDDDDD', 'waitlisted', { kind: 'waitlist' });
  ids.formula = await application('club_a', 'MEM-20261001-EEEEEEEE', 'enquired', { firstName: '=HYPERLINK("x")' });
  await pool.query(
    `UPDATE membership_applications
        SET address = '4 Castle Street, Dornoch', postcode = 'IV25 3SN', home_club = 'Tain Golf Club',
            other_clubs = 'Brora Golf Club', cdh_number = '1000000101', handicap = '11.2'
      WHERE id = $1`,
    [ids.submitted],
  );
  ids.appB = await application('club_b', 'MEM-20261001-FFFFFFFF', 'submitted', { categoryId: ids.fullB });
  ids.waitB = await application('club_b', 'MEM-20261001-GGGGGGGG', 'waitlisted', { kind: 'waitlist' });
}

async function signIn(email) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set(CSRF).send({ email, password: PASSWORD });
  assert.equal(res.status, 200, `sign-in for ${email} failed: ${JSON.stringify(res.body)}`);
  return agent;
}

const statusOf = async (id) => (await pool.query('SELECT * FROM membership_applications WHERE id = $1', [id])).rows[0];

describe('membership routes against Postgres', { skip }, () => {
  let adminA;
  let staffA;
  let adminB;

  before(async () => {
    db = await createScratchDatabase('membership_test');
    Object.assign(process.env, {
      DATABASE_URL: db.url,
      JWT_SECRET: 'membership-jwt-secret',
      BOOKING_LINK_SECRET: LINK_SECRET,
      MEMBERSHIP_FORM_BASE_URL: 'https://core.example/',
      SENDGRID_API_KEY: 'SG.test',
      FROM_EMAIL: 'bookings@club.test',
      NODE_ENV: 'test',
    });
    delete process.env.STRIPE_SECRET_KEY;

    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://api.sendgrid.com/')) {
        sent.push(JSON.parse(init.body));
        return new Response(null, { status: 202 });
      }
      return realFetch(url, init);
    };

    ({ default: request } = await import('supertest'));
    ({ app } = await import('../../src/app.js'));
    ({ pool } = await import('../../src/db.js'));
    ({ verifyMembershipToken } = await import('../../src/lib/membership-domain.js'));
    const { migrate } = await import('../../src/db/migrate.js');
    await migrate({ pool });
    await seed();
    adminA = await signIn('admin@club-a.test');
    staffA = await signIn('staff@club-a.test');
    adminB = await signIn('admin@club-b.test');
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await pool?.end();
    await db?.drop();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  describe('the service switch', () => {
    test('signed out, nothing answers', async () => {
      const res = await request(app).get('/api/membership/settings');
      assert.equal(res.status, 401);
    });

    test('with no settings row the service reads as off, and staff may not edit', async () => {
      const res = await staffA.get('/api/membership/settings');
      assert.equal(res.status, 200);
      assert.equal(res.body.enabled, false);
      assert.equal(res.body.canEdit, false);
      assert.equal(res.body.linksConfigured, true);
      assert.ok(res.body.statuses.some((s) => s.id === 'under_review'));
    });

    test('staff cannot switch it on', async () => {
      const res = await staffA.put('/api/membership/settings').set(CSRF).send({ enabled: true });
      assert.equal(res.status, 403);
      assert.equal((await adminA.get('/api/membership/settings')).body.enabled, false);
    });

    test('a write without the CSRF header is refused', async () => {
      const res = await adminA.put('/api/membership/settings').send({ enabled: true });
      assert.equal(res.status, 403);
    });

    test('an admin switches it and the copy, and who did it is recorded', async () => {
      const bad = await adminA.put('/api/membership/settings').set(CSRF).send({ enabled: 'yes' });
      assert.equal(bad.status, 400);
      const badCopy = await adminA
        .put('/api/membership/settings')
        .set(CSRF)
        .send({ settings: { contact_email: 'nope' } });
      assert.equal(badCopy.status, 400);
      assert.equal((await adminA.put('/api/membership/settings').set(CSRF).send({})).status, 400);

      const res = await adminA
        .put('/api/membership/settings')
        .set(CSRF)
        .send({ enabled: true, settings: { committee_name: 'The Committee', unknown: 'x' } });
      assert.equal(res.status, 200);
      assert.equal(res.body.enabled, true);
      assert.deepEqual(res.body.settings, { committee_name: 'The Committee' });
      assert.equal(res.body.updatedBy, 'admin@club-a.test');

      // Copy alone keeps the switch where it is; the switch alone keeps the copy.
      const off = await adminA.put('/api/membership/settings').set(CSRF).send({ enabled: false });
      assert.equal(off.body.enabled, false);
      assert.deepEqual(off.body.settings, { committee_name: 'The Committee' });

      // Club B is untouched.
      assert.equal((await adminB.get('/api/membership/settings')).body.enabled, false);
    });
  });

  describe('categories', () => {
    test('everyone can read them, with how often each is used', async () => {
      const res = await staffA.get('/api/membership/categories');
      assert.equal(res.status, 200);
      const names = res.body.categories.map((c) => c.name);
      assert.deepEqual(names.sort(), ['Full', 'Junior', 'Unused']);
      assert.equal(res.body.categories.find((c) => c.name === 'Full').applications, 1);
    });

    test('staff cannot create, edit or delete them', async () => {
      assert.equal((await staffA.post('/api/membership/categories').set(CSRF).send({ name: 'Staff' })).status, 403);
      assert.equal(
        (await staffA.put(`/api/membership/categories/${ids.full}`).set(CSRF).send({ name: 'Full' })).status,
        403,
      );
      assert.equal((await staffA.delete(`/api/membership/categories/${ids.unused}`).set(CSRF)).status, 403);
    });

    test('an admin creates and edits them; names are unique per club; bad input is a 400', async () => {
      const created = await adminA
        .post('/api/membership/categories')
        .set(CSRF)
        .send({ name: 'Country', joiningFee: 1200, annualFee: 950, eligibility: 'Over 50 km away' });
      assert.equal(created.status, 201);
      assert.equal(created.body.category.annualFee, 950);

      const dup = await adminA.post('/api/membership/categories').set(CSRF).send({ name: 'Country' });
      assert.equal(dup.status, 409);
      assert.equal((await adminA.post('/api/membership/categories').set(CSRF).send({ name: '' })).status, 400);
      assert.equal(
        (await adminA.post('/api/membership/categories').set(CSRF).send({ name: 'X', joiningFee: -5 })).status,
        400,
      );

      const edited = await adminA
        .put(`/api/membership/categories/${created.body.category.id}`)
        .set(CSRF)
        .send({ name: 'Country', joiningFee: 1300, annualFee: 950 });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.category.joiningFee, 1300);
      const clash = await adminA
        .put(`/api/membership/categories/${created.body.category.id}`)
        .set(CSRF)
        .send({ name: 'Full' });
      assert.equal(clash.status, 409);
      assert.equal(
        (await adminA.put(`/api/membership/categories/${created.body.category.id}`).set(CSRF).send({})).status,
        400,
      );
    });

    test('another club’s category is a 404, for reads through writes', async () => {
      assert.equal(
        (await adminB.put(`/api/membership/categories/${ids.full}`).set(CSRF).send({ name: 'Taken' })).status,
        404,
      );
      assert.equal((await adminB.delete(`/api/membership/categories/${ids.full}`).set(CSRF)).status, 404);
      assert.equal((await adminA.delete('/api/membership/categories/abc').set(CSRF)).status, 404);
      assert.equal((await adminA.put('/api/membership/categories/0').set(CSRF).send({ name: 'x' })).status, 404);
      const { rows } = await pool.query('SELECT name FROM membership_categories WHERE id = $1', [ids.full]);
      assert.equal(rows[0].name, 'Full');
    });

    test('a category in use is retired, an unused one deleted', async () => {
      const retired = await adminA.delete(`/api/membership/categories/${ids.junior}`).set(CSRF);
      assert.equal(retired.status, 200);
      assert.equal(retired.body.retired, true);
      const { rows } = await pool.query('SELECT active FROM membership_categories WHERE id = $1', [ids.junior]);
      assert.equal(rows[0].active, false);

      const deleted = await adminA.delete(`/api/membership/categories/${ids.unused}`).set(CSRF);
      assert.equal(deleted.body.deleted, true);
      const gone = await pool.query('SELECT 1 FROM membership_categories WHERE id = $1', [ids.unused]);
      assert.equal(gone.rowCount, 0);

      // Restore Junior for the email tests below.
      await pool.query('UPDATE membership_categories SET active = TRUE WHERE id = $1', [ids.junior]);
    });
  });

  describe('applications', () => {
    test('the list is the club’s own, with counts, a status filter and search', async () => {
      const res = await staffA.get('/api/membership/applications');
      assert.equal(res.status, 200);
      assert.ok(res.body.applications.every((a) => a.reference !== 'MEM-20261001-FFFFFFFF'));
      assert.equal(res.body.counts.waitlisted, 2);
      assert.equal(res.body.counts.welcomed, 0);
      assert.equal(res.body.applications.find((a) => a.id === ids.submitted).categoryName, 'Full');

      const waiting = await staffA.get('/api/membership/applications?status=waitlisted');
      assert.equal(waiting.body.applications.length, 2);
      const searched = await staffA.get('/api/membership/applications?q=bbbbbbbb');
      assert.deepEqual(
        searched.body.applications.map((a) => a.id),
        [ids.review],
      );
      const wildcard = await staffA.get('/api/membership/applications?q=%25');
      assert.equal(wildcard.body.applications.length, 0, 'a % is searched for, not used as a wildcard');
      assert.equal((await staffA.get('/api/membership/applications?status=bogus')).status, 400);
    });

    test('the detail has the timeline, recommended categories and the enquiry email', async () => {
      const res = await staffA.get(`/api/membership/applications/${ids.submitted}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.application.reference, 'MEM-20261001-AAAAAAAA');
      assert.deepEqual(res.body.application.nextStatuses, ['under_review']);
      assert.equal(res.body.category.name, 'Full');
      assert.deepEqual(res.body.recommendedCategories.map((c) => c.name).sort(), ['Full', 'Junior']);
      assert.equal(res.body.sourceEmail.body, 'I would like to join the club.');
      assert.deepEqual(res.body.events, []);
      const a = res.body.application;
      assert.deepEqual(
        [a.address, a.postcode, a.homeClub, a.otherClubs, a.cdhNumber, a.handicap],
        ['4 Castle Street, Dornoch', 'IV25 3SN', 'Tain Golf Club', 'Brora Golf Club', '1000000101', '11.2'],
      );
    });

    test('another club’s application is a 404 everywhere (no IDOR)', async () => {
      assert.equal((await adminB.get(`/api/membership/applications/${ids.submitted}`)).status, 404);
      assert.equal(
        (
          await adminB
            .patch(`/api/membership/applications/${ids.submitted}/status`)
            .set(CSRF)
            .send({ status: 'under_review' })
        ).status,
        404,
      );
      assert.equal(
        (await adminB.post(`/api/membership/applications/${ids.submitted}/notes`).set(CSRF).send({ note: 'hi' }))
          .status,
        404,
      );
      assert.equal((await adminB.post(`/api/membership/applications/${ids.waitA}/invite`).set(CSRF)).status, 404);
      assert.equal((await staffA.get(`/api/membership/applications/${ids.appB}`)).status, 404);
      assert.equal((await staffA.get('/api/membership/applications/not-a-number')).status, 404);
      assert.equal((await statusOf(ids.submitted)).status, 'submitted');
      assert.equal(sent.length, 0);
    });

    test('an invalid transition is refused and changes nothing', async () => {
      const skipReview = await staffA
        .patch(`/api/membership/applications/${ids.submitted}/status`)
        .set(CSRF)
        .send({ status: 'approved' });
      assert.equal(skipReview.status, 409);
      assert.match(skipReview.body.error, /Under review/);
      assert.equal(
        (
          await staffA
            .patch(`/api/membership/applications/${ids.submitted}/status`)
            .set(CSRF)
            .send({ status: 'nonsense' })
        ).status,
        400,
      );
      const invite = await staffA
        .patch(`/api/membership/applications/${ids.waitA}/status`)
        .set(CSRF)
        .send({ status: 'invited' });
      assert.equal(invite.status, 400, 'invitations go through the invite action');
      assert.equal(
        (
          await staffA
            .patch(`/api/membership/applications/${ids.submitted}/status`)
            .set(CSRF)
            .send({ status: 'under_review', note: 'x'.repeat(2001) })
        ).status,
        400,
      );
      assert.equal((await statusOf(ids.submitted)).status, 'submitted');
      assert.equal(sent.length, 0);
    });

    test('starting review records the event, emails the applicant and logs the email', async () => {
      const res = await staffA
        .patch(`/api/membership/applications/${ids.submitted}/status`)
        .set(CSRF)
        .send({ status: 'under_review', note: 'Committee meets Thursday' });
      assert.equal(res.status, 200);
      assert.equal(res.body.application.status, 'under_review');
      assert.equal(res.body.emailed, true);
      assert.equal(res.body.emailKind, 'membership_under_review');

      assert.equal(sent.length, 1);
      assert.equal(sent[0].personalizations[0].to[0].email, 'mem-20261001-aaaaaaaa@example.com');
      assert.match(sent[0].subject, /The Committee/);
      assert.match(sent[0].content[0].value, /Full: joining fee €2,500, annual subscription €1,850/);

      const { rows: logged } = await pool.query(
        `SELECT kind, sent_by, direction FROM email_messages WHERE club = 'club_a' AND kind LIKE 'membership_%'`,
      );
      assert.deepEqual(logged, [
        { kind: 'membership_under_review', sent_by: 'staff@club-a.test', direction: 'outbound' },
      ]);

      const detail = await staffA.get(`/api/membership/applications/${ids.submitted}`);
      assert.deepEqual(
        detail.body.events.map((e) => [e.event, e.actor, e.note]),
        [
          ['status:under_review', 'staff@club-a.test', 'Committee meets Thursday'],
          ['email:membership_under_review', 'staff@club-a.test', ''],
        ],
      );

      // The second person to try the same move is told it has already happened.
      const again = await staffA
        .patch(`/api/membership/applications/${ids.submitted}/status`)
        .set(CSRF)
        .send({ status: 'under_review' });
      assert.equal(again.status, 409);
    });

    test('approve then welcome sets who decided and when, and sends both emails', async () => {
      const approved = await staffA
        .patch(`/api/membership/applications/${ids.submitted}/status`)
        .set(CSRF)
        .send({ status: 'approved', note: 'Delighted' });
      assert.equal(approved.status, 200);
      let row = await statusOf(ids.submitted);
      assert.equal(row.status, 'approved');
      assert.equal(row.decided_by, 'staff@club-a.test');
      assert.ok(row.decided_at);
      assert.equal(row.decision_note, 'Delighted');

      const welcomed = await staffA
        .patch(`/api/membership/applications/${ids.submitted}/status`)
        .set(CSRF)
        .send({ status: 'welcomed' });
      assert.equal(welcomed.status, 200);
      row = await statusOf(ids.submitted);
      assert.equal(row.status, 'welcomed');
      assert.ok(row.welcomed_at);
      assert.match(sent[0].subject, /has been approved/);
      assert.match(sent[0].content[0].value, /Delighted/);
      assert.match(sent[1].subject, /^Welcome to /);
      assert.match(sent[1].content[0].value, /Fees payable: €4,350/);

      const done = await staffA
        .patch(`/api/membership/applications/${ids.submitted}/status`)
        .set(CSRF)
        .send({ status: 'declined' });
      assert.equal(done.status, 409, 'welcomed is final');
    });

    test('a decline carries the note to the applicant', async () => {
      const res = await adminA
        .patch(`/api/membership/applications/${ids.review}/status`)
        .set(CSRF)
        .send({ status: 'declined', note: 'The Junior section is full this year.' });
      assert.equal(res.status, 200);
      assert.match(sent[0].content[0].value, /The Junior section is full this year\./);
      assert.equal((await statusOf(ids.review)).decision_note, 'The Junior section is full this year.');
    });

    test('notes are appended with who wrote them', async () => {
      assert.equal(
        (await staffA.post(`/api/membership/applications/${ids.formula}/notes`).set(CSRF).send({ note: ' ' })).status,
        400,
      );
      const first = await staffA
        .post(`/api/membership/applications/${ids.formula}/notes`)
        .set(CSRF)
        .send({ note: 'Called back' });
      assert.equal(first.status, 201);
      await adminA.post(`/api/membership/applications/${ids.formula}/notes`).set(CSRF).send({ note: 'Left voicemail' });
      const row = await statusOf(ids.formula);
      const lines = row.staff_notes.split('\n');
      assert.equal(lines.length, 2);
      assert.match(lines[0], /staff@club-a\.test\] Called back$/);
      assert.match(lines[1], /admin@club-a\.test\] Left voicemail$/);
    });

    test('the export is the club’s own and defuses formulas', async () => {
      const res = await staffA.get('/api/membership/applications.csv');
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /text\/csv/);
      assert.match(res.headers['content-disposition'], /membership_\d{4}-\d{2}-\d{2}\.csv/);
      assert.match(res.text, /^Reference,Status,/);
      assert.match(res.text.split('\n')[0], /Address,Postcode,Handicap,CDH number,Home club,Other clubs/);
      assert.match(res.text, /IV25 3SN/);
      assert.match(res.text, /Brora Golf Club/);
      assert.match(res.text, /"'=HYPERLINK\(""x""\)"/);
      assert.doesNotMatch(res.text, /FFFFFFFF/);
      assert.equal((await staffA.get('/api/membership/applications.csv?status=bogus')).status, 400);
    });
  });

  describe('waitlist invitations', () => {
    test('nobody can be invited while applications are closed', async () => {
      await adminA.put('/api/membership/settings').set(CSRF).send({ enabled: false });
      const one = await staffA.post(`/api/membership/applications/${ids.waitA}/invite`).set(CSRF);
      assert.equal(one.status, 409);
      assert.match(one.body.error, /closed/);
      const all = await adminA.post('/api/membership/applications/invite-waitlist').set(CSRF);
      assert.equal(all.status, 409);
      assert.equal((await statusOf(ids.waitA)).status, 'waitlisted');
      assert.equal(sent.length, 0);
    });

    test('when open, an invitation emails a signed apply link for the same reference', async () => {
      await adminA.put('/api/membership/settings').set(CSRF).send({ enabled: true });
      // As pasted into a host's settings: the core API strips the newline, so must we.
      process.env.BOOKING_LINK_SECRET = ` ${LINK_SECRET}\n`;
      let res;
      try {
        res = await staffA.post(`/api/membership/applications/${ids.waitA}/invite`).set(CSRF);
      } finally {
        process.env.BOOKING_LINK_SECRET = LINK_SECRET;
      }
      assert.equal(res.status, 200);
      assert.equal(res.body.application.status, 'invited');
      assert.equal(res.body.application.reference, 'MEM-20261001-CCCCCCCC');
      assert.equal(res.body.emailed, true);

      const text = sent[0].content[0].value;
      const link = new URL(text.match(/Apply for membership: (\S+)/)[1]);
      assert.equal(link.origin + link.pathname, 'https://core.example/membership/apply');
      assert.equal(link.searchParams.get('ref'), 'MEM-20261001-CCCCCCCC');
      assert.ok(verifyMembershipToken('MEM-20261001-CCCCCCCC', link.searchParams.get('token'), LINK_SECRET, 'club_a'));
      // The membership address, never the booking desk's FROM_EMAIL.
      assert.equal(sent[0].reply_to.email, 'memberships@club.teemail.io');
      assert.match(text, /write to memberships@club\.teemail\.io\./);
      assert.doesNotMatch(JSON.stringify(sent[0].content), /bookings@club\.test/);

      const { rows } = await pool.query(`SELECT event FROM membership_events WHERE application_id = $1 ORDER BY id`, [
        ids.waitA,
      ]);
      assert.deepEqual(
        rows.map((r) => r.event),
        ['invited', 'email:membership_invite'],
      );

      const again = await staffA.post(`/api/membership/applications/${ids.waitA}/invite`).set(CSRF);
      assert.equal(again.status, 409, 'only the waitlisted can be invited');
    });

    test('inviting the whole waitlist is for admins, and only reaches this club', async () => {
      assert.equal((await staffA.post('/api/membership/applications/invite-waitlist').set(CSRF)).status, 403);
      const res = await adminA.post('/api/membership/applications/invite-waitlist').set(CSRF);
      assert.equal(res.status, 200);
      assert.equal(res.body.invited, 1);
      assert.equal(res.body.emailed, 1);
      assert.equal((await statusOf(ids.waitA2)).status, 'invited');
      assert.equal((await statusOf(ids.waitB)).status, 'waitlisted', 'club B’s waitlist is not touched');
    });

    test('without the link settings an invitation is refused rather than sent without a link', async () => {
      await pool.query(`UPDATE membership_applications SET status = 'waitlisted' WHERE id = $1`, [ids.waitA2]);
      const base = process.env.MEMBERSHIP_FORM_BASE_URL;
      delete process.env.MEMBERSHIP_FORM_BASE_URL;
      try {
        const res = await staffA.post(`/api/membership/applications/${ids.waitA2}/invite`).set(CSRF);
        assert.equal(res.status, 409);
        assert.match(res.body.error, /MEMBERSHIP_FORM_BASE_URL/);
        assert.doesNotMatch(res.body.error, /BOOKING_LINK_SECRET/, 'names only what is missing');
        process.env.MEMBERSHIP_FORM_BASE_URL = '   ';
        const blank = await staffA.post(`/api/membership/applications/${ids.waitA2}/invite`).set(CSRF);
        assert.equal(blank.status, 409);
        assert.match(blank.body.error, /MEMBERSHIP_FORM_BASE_URL/);
      } finally {
        process.env.MEMBERSHIP_FORM_BASE_URL = base;
      }
    });

    test('without SendGrid the decision stands and the page is told no email went', async () => {
      const key = process.env.SENDGRID_API_KEY;
      delete process.env.SENDGRID_API_KEY;
      try {
        const res = await staffA.post(`/api/membership/applications/${ids.waitA2}/invite`).set(CSRF);
        assert.equal(res.status, 200);
        assert.equal(res.body.emailed, false);
        assert.match(res.body.emailNotice, /not set up/);
        assert.equal(sent.length, 0);
      } finally {
        process.env.SENDGRID_API_KEY = key;
      }
    });

    test('a SendGrid failure is reported, not thrown', async () => {
      await pool.query(`UPDATE membership_applications SET status = 'waitlisted' WHERE id = $1`, [ids.waitA2]);
      const ok = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ errors: [{ message: 'bad sender' }] }), { status: 403 });
      try {
        const res = await staffA.post(`/api/membership/applications/${ids.waitA2}/invite`).set(CSRF);
        assert.equal(res.status, 200);
        assert.equal(res.body.emailed, false);
        assert.match(res.body.emailNotice, /bad sender/);
      } finally {
        globalThis.fetch = ok;
      }
    });
  });

  test('the summary counts this club’s pipeline', async () => {
    const res = await staffA.get('/api/membership/summary');
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.newSubmissions, 0);
    assert.equal(res.body.underReview, 0);
    assert.equal(res.body.awaitingWelcome, 0);
    assert.equal(res.body.waitlist, 0);
    assert.equal(res.body.welcomedThisYear, 1);
    assert.equal(res.body.enquiriesThisMonth, 5);

    const b = await adminB.get('/api/membership/summary');
    assert.equal(b.body.newSubmissions, 1);
    assert.equal(b.body.waitlist, 1);
  });
});
