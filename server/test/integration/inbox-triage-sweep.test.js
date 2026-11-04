/**
 * The schedule that keeps the Inbox triaged, against a real database.
 *
 * The model is stubbed throughout -- what these cover is the bookkeeping
 * around it, which is where a sweep goes wrong: paying to read the same email
 * every two minutes, retrying a poisonous one for ever, losing a whole batch
 * to one bad message, or quietly overwriting a reply a person has already
 * written.
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { createScratchDatabase, skip } from './helpers.js';

const GOOD = {
  intent: 'new_enquiry',
  summary: 'Four players want Friday 24 April.',
  needs_person: true,
  reason: 'The tee sheet needs checking for that date.',
  draft_reply: 'Thank you for your enquiry.\n\n[confirm availability]\n\nTeeMail Golf Club',
  confidence: 0.9,
};

function stubClient(behaviour) {
  const calls = [];
  return {
    calls,
    messages: {
      async parse(request) {
        calls.push(request);
        if (typeof behaviour === 'function') return behaviour(calls.length, request);
        return behaviour;
      },
    },
  };
}

describe('the Inbox triage sweep', { skip }, () => {
  let db;
  let client;
  let sweep;

  before(async () => {
    db = await createScratchDatabase('inbox_triage');
    await migrate({ connectionString: db.url });
    process.env.DATABASE_URL = db.url;
    process.env.DATABASE_SSL_MODE = 'disabled';
    sweep = await import('../../src/lib/inbox-triage-sweep.js');
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    await client.query(
      `INSERT INTO public.bookings (club, booking_id, guest_name, status, date, players, created_at)
       VALUES ('baltray', 'BOOK-1', 'Jamie', 'Inquiry', '2027-04-24', 4, NOW())`,
    );
  });

  after(async () => {
    await client?.end();
    await db?.drop();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE public.email_messages RESTART IDENTITY CASCADE');
    await client.query('TRUNCATE public.inbound_emails RESTART IDENTITY CASCADE');
  });

  /** One inbound email, as the 0019 trigger would have written it. */
  async function arrives({ subject = '', body = 'Friday 24th April\n\n4 players', type = 'unknown' } = {}) {
    const { rows } = await client.query(
      `INSERT INTO public.inbound_emails (message_id, from_email, to_email, subject, body_text, email_type)
       VALUES (NULL, 'Jamie <jamie@example.com>', 'tee@club.test', $1, $2, $3) RETURNING id`,
      [subject, body, type],
    );
    const mirrored = await client.query('SELECT id FROM public.email_messages WHERE source_inbound_id = $1', [
      rows[0].id,
    ]);
    assert.equal(mirrored.rows.length, 1, 'the trigger mirrored it');
    return mirrored.rows[0].id;
  }

  const read = async (id) =>
    (
      await client.query(
        `SELECT intent, summary, draft_reply, review_status, review_reason,
                triaged_at, triage_attempts, triage_error
           FROM public.email_messages WHERE id = $1`,
        [id],
      )
    ).rows[0];

  test('an email gains a summary, an intent and a draft', async () => {
    const id = await arrives();
    const result = await sweep.triagePending({ client: stubClient({ parsed_output: GOOD }), env: {} });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.triaged, [{ id, intent: 'new_enquiry', hasDraft: true }]);

    const row = await read(id);
    assert.equal(row.intent, 'new_enquiry');
    assert.equal(row.summary, GOOD.summary);
    assert.match(row.draft_reply, /TeeMail Golf Club/);
    assert.ok(row.triaged_at, 'and is marked as read');
  });

  test('it says why the email is waiting, in place of the line about the bot', async () => {
    const id = await arrives();
    assert.match((await read(id)).review_reason, /has not classified it yet/, 'what the trigger left');

    await sweep.triagePending({ client: stubClient({ parsed_output: GOOD }), env: {} });

    const row = await read(id);
    assert.equal(row.review_reason, GOOD.reason);
    assert.equal(row.review_status, 'open', 'triage describes; it does not close anything');
  });

  test('a triaged email is not read again, however often the sweep runs', async () => {
    // Otherwise every message is paid for again every couple of minutes.
    await arrives();
    const stub = stubClient({ parsed_output: GOOD });
    await sweep.triagePending({ client: stub, env: {} });
    await sweep.triagePending({ client: stub, env: {} });
    await sweep.triagePending({ client: stub, env: {} });
    assert.equal(stub.calls.length, 1, 'the model was asked exactly once');
  });

  test('one unreadable email does not take the batch down with it', async () => {
    const bad = await arrives({ body: 'first' });
    const good = await arrives({ body: 'second' });

    const stub = stubClient((n) => {
      if (n === 1) throw new Error('model exploded');
      return { parsed_output: GOOD };
    });
    const result = await sweep.triagePending({ client: stub, env: {} });

    assert.deepEqual(
      result.errors.map((e) => e.id),
      [bad],
    );
    assert.deepEqual(
      result.triaged.map((t) => t.id),
      [good],
    );
    assert.equal((await read(good)).summary, GOOD.summary, 'the rest of the batch went through');
    assert.match((await read(bad)).triage_error, /model exploded/, 'and the failure is recorded, not lost');
  });

  test('an email that keeps failing is given up on, not retried for ever', async () => {
    const id = await arrives();
    const stub = stubClient(() => {
      throw new Error('still broken');
    });
    for (let i = 0; i < 5; i += 1) await sweep.triagePending({ client: stub, env: {} });

    assert.equal(stub.calls.length, sweep.MAX_ATTEMPTS, 'it stops after the limit');
    const row = await read(id);
    assert.equal(row.triage_attempts, sweep.MAX_ATTEMPTS);
    assert.equal(row.triaged_at, null, 'and is left plainly unread');
    assert.match(row.triage_error, /still broken/);
  });

  test('it never overwrites a reply somebody has already written', async () => {
    const id = await arrives();
    await client.query(
      `UPDATE public.email_messages SET draft_reply = 'Mine, not the model’s', review_status = 'replied',
              handled_at = NOW(), handled_by = 'admin', triaged_at = NOW() WHERE id = $1`,
      [id],
    );
    const stub = stubClient({ parsed_output: GOOD });
    await sweep.triagePending({ client: stub, env: {} });

    assert.equal(stub.calls.length, 0, 'an answered email is not triage’s business');
    assert.equal((await read(id)).draft_reply, 'Mine, not the model’s');
  });

  test('a deleted email is not sent to the model', async () => {
    const id = await arrives();
    await client.query('UPDATE public.email_messages SET deleted_at = NOW() WHERE id = $1', [id]);
    const stub = stubClient({ parsed_output: GOOD });
    await sweep.triagePending({ client: stub, env: {} });
    assert.equal(stub.calls.length, 0);
  });

  test('the booking an email belongs to is given to the model', async () => {
    const { rows } = await client.query(
      `INSERT INTO public.inbound_emails (message_id, from_email, subject, body_text, email_type)
       VALUES ('<m1@test>', 'jamie@example.com', 'Re: BOOK-1', 'Can we move it?', 'modification') RETURNING id`,
    );
    await client.query(`UPDATE public.email_messages SET booking_id = 'BOOK-1' WHERE source_inbound_id = $1`, [
      rows[0].id,
    ]);

    const stub = stubClient({ parsed_output: { ...GOOD, intent: 'change_request' } });
    await sweep.triagePending({ client: stub, env: {} });

    const sent = stub.calls[0].messages[0].content;
    assert.match(sent, /BOOK-1/);
    assert.match(sent, /Jamie/, 'the guest’s name, so the draft can use it');
    assert.match(sent, /2027-04-24/, 'and the date it is currently booked for');
  });

  test('with no key the sweep is a no-op that says so', async () => {
    await arrives();
    const result = await sweep.triagePending({ env: {} });
    assert.match(result.skipped, /ANTHROPIC_API_KEY/);
    assert.equal(result.triaged.length, 0);
  });

  test('oldest first, so a backlog clears in the order it arrived', async () => {
    const first = await arrives({ body: 'oldest' });
    await client.query("UPDATE public.email_messages SET created_at = NOW() - INTERVAL '1 day' WHERE id = $1", [first]);
    await arrives({ body: 'newest' });

    const stub = stubClient({ parsed_output: GOOD });
    const result = await sweep.triagePending({ limit: 1, client: stub, env: {} });
    assert.deepEqual(
      result.triaged.map((t) => t.id),
      [first],
    );
  });
});
