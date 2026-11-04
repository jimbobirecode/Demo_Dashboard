/**
 * The bridge from the email bot's mailbox to the Inbox (migration 0019).
 *
 * The bot writes inbound_emails; every screen in this dashboard reads
 * email_messages. Nothing joined them, so mail arrived into a table no page
 * reads and the Inbox stayed empty. A trigger mirrors each row across.
 *
 * These tests are the real behaviour of that trigger against Postgres, because
 * all of it is SQL: there is no JavaScript to unit test. What they pin down is
 * the part a club would notice if it broke — that mail shows up, that only the
 * messages needing a person are left open, and that an email somebody has
 * already answered is never dragged back into the queue.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { createScratchDatabase, skip } from './helpers.js';

describe('the Inbox reads the bot’s mail', { skip }, () => {
  let db;
  let client;

  /** One row as the bot writes it, straight into its own audit table. */
  async function botReceives({
    messageId,
    from,
    to = 'teetimes@example.com',
    subject = 'Subject',
    body = 'Body',
    type = 'unknown',
    error = null,
  }) {
    await client.query(
      `INSERT INTO public.inbound_emails
         (message_id, from_email, to_email, subject, body_text, email_type, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [messageId, from, to, subject, body, type, error],
    );
  }

  /** What the Inbox would show for one message. */
  async function mirrored(messageId) {
    const { rows } = await client.query(
      `SELECT booking_id, from_email, to_email, subject, body_text, intent,
              direction, routed_to, review_status, review_reason, handled_by
         FROM public.email_messages
        WHERE message_id = $1`,
      [messageId],
    );
    assert.ok(rows.length <= 1, `${messageId} was mirrored ${rows.length} times`);
    return rows[0] ?? null;
  }

  before(async () => {
    db = await createScratchDatabase('inbox_bot_mail');
    await migrate({ connectionString: db.url });
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    await client.query(
      `INSERT INTO public.bookings (club, booking_id, guest_name, status, created_at)
       VALUES ('baltray', 'BOOK-TEST-1', 'Alice', 'Inquiry', NOW())`,
    );
  });

  after(async () => {
    await client?.end();
    await db?.drop();
  });

  test('mail appears the moment it arrives, open, before the bot has classified it', async () => {
    // The bot inserts with email_type 'unknown' and only later says what the
    // message was. A club watching an inbox needs to see it now, not then.
    await botReceives({ messageId: '<arrived@test>', from: 'guest@example.com', subject: 'Four on Saturday?' });

    const row = await mirrored('<arrived@test>');
    assert.equal(row.direction, 'inbound');
    assert.equal(row.routed_to, 'inbox');
    assert.equal(row.subject, 'Four on Saturday?');
    assert.equal(row.review_status, 'open');
    assert.match(row.review_reason, /not classified it yet/);
  });

  test('a From header is reduced to the address, so the email joins its own thread', async () => {
    // The bot stores From as it arrived. A booking's conversation is found by
    // lower(from_email) = the guest's address, which 'Name <addr>' never matches.
    await botReceives({
      messageId: '<header@test>',
      from: 'Bob Brown <Bob.Brown@Example.COM>',
      to: 'Tee Times <t@example.com>',
    });

    const row = await mirrored('<header@test>');
    assert.equal(row.from_email, 'bob.brown@example.com');
    assert.equal(row.to_email, 't@example.com');
  });

  test('the sender is kept by name as well as by address', async () => {
    // The Inbox had no name of its own for a sender, so it borrowed the linked
    // booking's guest_name -- which at County Louth is the lead golfer named
    // inside a tour operator's enquiry, not the person who sent it. The name
    // was in the From header the whole time (migration 0023).
    await botReceives({ messageId: '<named@test>', from: 'Adam Gordon <adam@halcyongolftravel.com>' });

    const { rows } = await client.query(
      `SELECT from_name, from_email FROM public.email_messages WHERE message_id = '<named@test>'`,
    );
    assert.equal(rows[0].from_name, 'Adam Gordon');
    assert.equal(rows[0].from_email, 'adam@halcyongolftravel.com', 'the address is still an address');
  });

  test('a quoted name is unquoted, and punctuation in it is kept', async () => {
    // Operators' shared mailboxes write themselves this way, and the quotes
    // are the header's syntax rather than part of the name.
    await botReceives({
      messageId: '<quoted@test>',
      from: '"Bookings | Halcyon Golf Travel" <bookings@halcyongolftravel.com>',
    });

    const { rows } = await client.query(
      `SELECT from_name FROM public.email_messages WHERE message_id = '<quoted@test>'`,
    );
    assert.equal(rows[0].from_name, 'Bookings | Halcyon Golf Travel');
  });

  test('a header carrying no real name leaves the name empty rather than guessing', async () => {
    // Three shapes that arrive in practice. In each, the address on its own is
    // clearer than anything that could be made of the name.
    const cases = [
      ['<bare@test>', '<normcook59@gmail.com>', 'no name before the brackets'],
      ['<repeat@test>', '"dave@ramaley.com" <dave@ramaley.com>', 'the address repeated as a name'],
      ['<encoded@test>', '=?UTF-8?B?Tm9ybSBDb29r?= <norm@example.com>', 'an RFC 2047 encoded word we do not decode'],
      ['<plain@test>', 'plain@example.com', 'no brackets at all'],
    ];
    for (const [messageId, from, why] of cases) {
      await botReceives({ messageId, from });
      const { rows } = await client.query(`SELECT from_name FROM public.email_messages WHERE message_id = $1`, [
        messageId,
      ]);
      assert.equal(rows[0].from_name, null, why);
    }
  });

  test('mail already in the Inbox is named from the header it arrived on', async () => {
    // 0024 has to name the mail that 0019 and 0020 had already mirrored, or
    // every email the club has is nameless until the next one arrives.
    await botReceives({ messageId: '<backfill@test>', from: 'Maja Simlesa <msimlesa@jorireland.com>' });
    await client.query(`UPDATE public.email_messages SET from_name = NULL WHERE message_id = '<backfill@test>'`);

    await client.query('DELETE FROM public.schema_migrations WHERE version = 24');
    await migrate({ connectionString: db.url });

    const { rows } = await client.query(
      `SELECT from_name FROM public.email_messages WHERE message_id = '<backfill@test>'`,
    );
    assert.equal(rows[0].from_name, 'Maja Simlesa');
  });

  test('once the bot has handled it, it leaves the queue but stays on the record', async () => {
    await botReceives({ messageId: '<handled@test>', from: 'guest@example.com' });
    assert.equal((await mirrored('<handled@test>')).review_status, 'open');

    await client.query(
      `UPDATE public.inbound_emails SET email_type = 'cancellation' WHERE message_id = '<handled@test>'`,
    );

    const row = await mirrored('<handled@test>');
    assert.equal(row.intent, 'cancellation');
    assert.equal(row.review_status, 'none', 'the bot dealt with it, so it is not the club’s to answer');
    assert.equal(row.review_reason, null);
  });

  test('what the bot could not handle stays open, saying why', async () => {
    await botReceives({
      messageId: '<failed@test>',
      from: 'guest@example.com',
      type: 'error',
      error: 'OpenAI timeout',
    });

    const row = await mirrored('<failed@test>');
    assert.equal(row.review_status, 'open');
    assert.match(row.review_reason, /OpenAI timeout/);
  });

  test('an email somebody has answered is never pulled back into the queue', async () => {
    // The club replies while the bot is still thinking. When the bot then
    // reports what the message was, that must not reopen it.
    await botReceives({ messageId: '<answered@test>', from: 'guest@example.com' });
    await client.query(
      `UPDATE public.email_messages
          SET review_status = 'replied', handled_at = NOW(), handled_by = 'admin'
        WHERE message_id = '<answered@test>'`,
    );

    await client.query(
      `UPDATE public.inbound_emails SET email_type = 'booking_request' WHERE message_id = '<answered@test>'`,
    );

    const row = await mirrored('<answered@test>');
    assert.equal(row.review_status, 'replied');
    assert.equal(row.handled_by, 'admin');
    // What the email IS is still brought up to date: that is the bot's to say.
    assert.equal(row.intent, 'new_enquiry');
  });

  test('it is filed against the booking the same email created', async () => {
    // Migration 0018 gave bookings the Message-ID of the email behind them,
    // which is what puts the email in that booking's conversation.
    await client.query(`UPDATE public.bookings SET message_id = '<booked@test>' WHERE booking_id = 'BOOK-TEST-1'`);
    await botReceives({ messageId: '<booked@test>', from: 'guest@example.com', type: 'new_booking' });

    assert.equal((await mirrored('<booked@test>')).booking_id, 'BOOK-TEST-1');
  });

  test('an email with no Message-ID still reaches the Inbox', async () => {
    // 0019 skipped these, reasoning that a row with no Message-ID could not be
    // re-found when the bot updated it. The first real email to arrive had no
    // Message-ID -- the webhook's `headers` field was empty, so the bot never
    // saw one -- and was dropped silently. 0020 matches on inbound_emails.id,
    // which is ours and always there.
    const { rows: inserted } = await client.query(
      `INSERT INTO public.inbound_emails (message_id, from_email, subject, body_text, email_type)
       VALUES (NULL, 'Jamie Kenny <jamie@example.com>', '', 'Can I move my booking?', 'unknown')
       RETURNING id`,
    );
    const sourceId = inserted[0].id;

    const { rows } = await client.query(
      `SELECT message_id, from_email, subject, review_status, review_reason
         FROM public.email_messages WHERE source_inbound_id = $1`,
      [sourceId],
    );
    assert.equal(rows.length, 1, 'it is in the Inbox');
    assert.equal(rows[0].message_id, null, 'and honest about having no Message-ID');
    assert.equal(rows[0].from_email, 'jamie@example.com');
    assert.equal(rows[0].subject, null, 'an empty subject is stored as none, not as blank text');
    assert.equal(rows[0].review_status, 'open', 'unclassified, so a person should see it');

    // The bot comes back to it: still no Message-ID, and still the same row.
    await client.query(
      `UPDATE public.inbound_emails SET email_type = 'modification', subject = 'Re: booking' WHERE id = $1`,
      [sourceId],
    );
    const after = await client.query(
      `SELECT intent, subject, review_status FROM public.email_messages WHERE source_inbound_id = $1`,
      [sourceId],
    );
    assert.equal(after.rows.length, 1, 'updated, not duplicated');
    assert.equal(after.rows[0].intent, 'change_request');
    assert.equal(after.rows[0].subject, 'Re: booking');
    assert.equal(after.rows[0].review_status, 'none');
  });

  test('two emails with no Message-ID are two emails, not one', async () => {
    // The old matching key would have collapsed these, or dropped both.
    const a = await client.query(
      `INSERT INTO public.inbound_emails (message_id, from_email, subject, email_type)
       VALUES (NULL, 'one@example.com', 'First', 'unknown') RETURNING id`,
    );
    const b = await client.query(
      `INSERT INTO public.inbound_emails (message_id, from_email, subject, email_type)
       VALUES (NULL, 'two@example.com', 'Second', 'unknown') RETURNING id`,
    );
    const { rows } = await client.query(
      `SELECT from_email FROM public.email_messages
        WHERE source_inbound_id = ANY($1::int[]) ORDER BY source_inbound_id`,
      [[a.rows[0].id, b.rows[0].id]],
    );
    assert.deepEqual(
      rows.map((r) => r.from_email),
      ['one@example.com', 'two@example.com'],
    );
  });

  test('the bot touching a row repeatedly never duplicates it', async () => {
    await botReceives({ messageId: '<busy@test>', from: 'guest@example.com' });
    for (const type of ['booking_request', 'modification', 'cancellation', 'new_booking']) {
      await client.query(`UPDATE public.inbound_emails SET email_type = $1 WHERE message_id = '<busy@test>'`, [type]);
    }

    // mirrored() asserts there is at most one row.
    assert.equal((await mirrored('<busy@test>')).intent, 'new_enquiry');
  });

  test('mail the bot wrote before the trigger existed is brought across, once', async () => {
    // 0019 has to be correct on a database where mail arrived between 0018 and
    // it — and re-running it must not double anything up.
    //
    // The whole bridge (0019-0024) is replayed rather than 0019 alone. Each
    // file replaces the same trigger function, so replaying one in the middle
    // would leave the database on an older version of it than the code
    // expects, for this test and every test after it.
    await client.query('ALTER TABLE public.inbound_emails DISABLE TRIGGER trg_inbox_mirror_inbound_email');
    await botReceives({
      messageId: '<before-0019@test>',
      from: 'Early Bird <early@example.com>',
      type: 'cancellation',
    });
    await botReceives({ messageId: '<before-0019-unknown@test>', from: 'early2@example.com', type: 'unknown' });
    await client.query('ALTER TABLE public.inbound_emails ENABLE TRIGGER trg_inbox_mirror_inbound_email');

    assert.equal(await mirrored('<before-0019@test>'), null, 'not mirrored while the trigger was off');

    const before = await client.query('SELECT count(*)::int AS n FROM public.email_messages');
    await client.query('DELETE FROM public.schema_migrations WHERE version >= 19');
    await migrate({ connectionString: db.url });

    const handled = await mirrored('<before-0019@test>');
    assert.equal(handled.from_email, 'early@example.com');
    assert.equal(handled.intent, 'cancellation');
    assert.equal(handled.review_status, 'none');
    assert.equal((await mirrored('<before-0019-unknown@test>')).review_status, 'open');

    // Twice more: the backfill must find nothing left to do.
    await client.query('DELETE FROM public.schema_migrations WHERE version >= 19');
    await migrate({ connectionString: db.url });
    const after = await client.query('SELECT count(*)::int AS n FROM public.email_messages');
    assert.equal(after.rows[0].n, before.rows[0].n + 2);
  });

  test('the club it files under is the one the dashboard scopes queries to', async () => {
    // Every query is scoped to the signed-in user's dashboard_users.customer_id.
    // A mirrored row carrying anything else is invisible on every screen.
    const { rows } = await client.query(`SELECT DISTINCT club FROM public.email_messages WHERE direction = 'inbound'`);
    assert.deepEqual(
      rows.map((r) => r.club),
      ['baltray'],
    );
  });
});
