/**
 * Reading an inbound email: what is sent to the model, and what is allowed
 * back out of it.
 *
 * No test here calls the API. What is worth pinning down is not the model's
 * prose -- that is not a thing a test can assert -- but the contract around
 * it: the club's own details go in, the vocabulary the dashboard understands
 * comes back, a refusal or a malformed answer is an error rather than a
 * silently empty summary, and nothing in this path can send an email.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL,
  INTENTS,
  SYSTEM_PROMPT,
  TRIAGE_SCHEMA,
  buildUserContent,
  clubBrief,
  normaliseTriage,
  triageConfig,
  triageEmail,
} from '../src/lib/inbox-triage.js';

const EMAIL = {
  fromEmail: 'jamie@example.com',
  subject: '',
  bodyText: 'Friday 24th April\n\n4 players',
  createdAt: '2026-10-11T15:34:18Z',
};

const GOOD = {
  intent: 'new_enquiry',
  summary: 'Asking for four players on Friday 24 April.',
  needs_person: true,
  reason: 'Needs the tee sheet checked for that date.',
  draft_reply: 'Thank you for your enquiry.\n\n[confirm availability]\n\nTeeMail Golf Club',
  confidence: 0.9,
};

/** A client that answers with one canned response, and records the request. */
function stubClient(response, calls = []) {
  return {
    calls,
    messages: {
      async parse(request) {
        calls.push(request);
        return response;
      },
    },
  };
}

test('the model is asked in the club’s own terms, with the email and its booking', async () => {
  const calls = [];
  await triageEmail({
    email: EMAIL,
    booking: { bookingId: 'BOOK-1', guestName: 'Jamie', status: 'Inquiry', date: '2027-04-24', players: 4 },
    client: stubClient({ parsed_output: GOOD }, calls),
    env: {},
  });

  const [request] = calls;
  assert.equal(request.model, DEFAULT_MODEL);
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.deepEqual(request.output_config.format.schema, TRIAGE_SCHEMA);

  const sent = request.messages[0].content;
  assert.match(sent, /TeeMail Golf Club/, 'the club, so the draft sounds like it');
  assert.match(sent, /EUR/);
  assert.match(sent, /Europe\/London/);
  assert.match(sent, /Friday 24th April/, 'the email itself');
  assert.match(sent, /\(no subject\)/, 'an empty subject is said, not left blank');
  assert.match(sent, /BOOK-1/, 'the booking it is about');
});

test('an email with no booking says so, rather than leaving a gap to fill in', async () => {
  const calls = [];
  await triageEmail({ email: EMAIL, client: stubClient({ parsed_output: GOOD }, calls), env: {} });
  assert.match(calls[0].messages[0].content, /No booking is attached/);
});

test('the system prompt forbids inventing, which is the whole risk here', () => {
  // A draft goes out in the club's name. A plausible invented green fee is
  // worse than no draft, and this is the only thing standing in its way.
  assert.match(SYSTEM_PROMPT, /do not invent/i);
  assert.match(SYSTEM_PROMPT, /square brackets/i);
  assert.match(SYSTEM_PROMPT, /never a plausible-looking number/i);
  // And it must be clear nothing is sent automatically.
  assert.match(SYSTEM_PROMPT, /Nothing you write is sent/i);
});

test('only intents the dashboard understands get through', () => {
  // The schema holds the model to the list, but a stored value the Inbox
  // cannot filter on would be invisible, so it is checked again on the way in.
  assert.deepEqual(TRIAGE_SCHEMA.properties.intent.enum, INTENTS);
  assert.equal(TRIAGE_SCHEMA.additionalProperties, false);
  assert.equal(normaliseTriage({ ...GOOD, intent: 'wedding_enquiry' }).intent, 'other');
  assert.equal(normaliseTriage({ ...GOOD, intent: 'cancellation' }).intent, 'cancellation');
});

test('what comes back is cut to what the screen and the column can hold', () => {
  const long = normaliseTriage({ ...GOOD, summary: 'x'.repeat(400), reason: 'y'.repeat(400) });
  assert.ok(long.summary.length <= 200, 'the summary is one line in a list');
  assert.ok(long.summary.endsWith('…'), 'and is visibly cut, not silently truncated');
  assert.ok(long.reason.length <= 200);

  // Confidence is clamped: a model that says 1.4 does not get to say 1.4.
  assert.equal(normaliseTriage({ ...GOOD, confidence: 1.4 }).confidence, 1);
  assert.equal(normaliseTriage({ ...GOOD, confidence: -2 }).confidence, 0);
  assert.equal(normaliseTriage({ ...GOOD, confidence: 'very' }).confidence, null);

  // needs_person defaults to true: the safe side is a person looking.
  assert.equal(normaliseTriage({ ...GOOD, needs_person: undefined }).needsPerson, true);
  assert.equal(normaliseTriage({ ...GOOD, needs_person: false }).needsPerson, false);
});

test('a refusal and a malformed answer both raise, rather than storing nothing', async () => {
  // Either way the email keeps its place in the queue and a person reads it.
  // Storing an empty summary would make it look as though it had been read.
  await assert.rejects(
    triageEmail({
      email: EMAIL,
      client: stubClient({ stop_reason: 'refusal', stop_details: { category: 'cyber' } }),
      env: {},
    }),
    /declined to read this email \(cyber\)/,
  );

  await assert.rejects(
    triageEmail({ email: EMAIL, client: stubClient({ parsed_output: null }), env: {} }),
    /did not match the schema/,
  );
});

test('with no API key it is off, and says so, rather than failing obscurely', async () => {
  assert.equal(triageConfig({}).configured, false);
  assert.equal(triageConfig({ ANTHROPIC_API_KEY: 'sk-test' }).configured, true);
  await assert.rejects(triageEmail({ email: EMAIL, env: {} }), /ANTHROPIC_API_KEY is not set/);
});

test('the model and its effort are one environment variable away', () => {
  // So a club can drop to a cheaper model without a release.
  const config = triageConfig({ ANTHROPIC_API_KEY: 'k', INBOX_TRIAGE_MODEL: 'claude-haiku-5-5' });
  assert.equal(config.model, 'claude-haiku-5-5');
  assert.equal(triageConfig({ ANTHROPIC_API_KEY: 'k' }).model, DEFAULT_MODEL);
  assert.equal(triageConfig({ ANTHROPIC_API_KEY: 'k', INBOX_TRIAGE_EFFORT: 'high' }).effort, 'high');
});

test('the club brief carries the details a reply needs, and no secrets', () => {
  const brief = clubBrief();
  assert.match(brief, /TeeMail Golf Club/);
  assert.match(brief, /TeeMail Golf Club, London/);
  assert.ok(!/API|KEY|postgres|password/i.test(brief), 'nothing from the environment leaks into the prompt');
});

test('this path cannot send an email', async () => {
  // The draft is a suggestion in a composer. If this module ever grew a send,
  // a bad classification would become a bad email to a guest.
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/lib/inbox-triage.js', import.meta.url), 'utf8'),
  );
  assert.ok(!/sendHtmlEmail|sendTemplateEmail|sendgrid/i.test(source), 'triage must not be able to send');
});

test('a date column is written as the day it is, not as a timestamp', async () => {
  // bookings.date is a DATE, so pg returns a Date object. Interpolated raw it
  // renders "Sat Apr 24 2027 00:00:00 GMT+0000 (Coordinated Universal Time)" --
  // noise, plus a time and a zone the column does not hold.
  const { asDay } = await import('../src/lib/inbox-triage.js');
  assert.equal(asDay(new Date('2027-04-24T00:00:00Z')), '2027-04-24');
  assert.equal(asDay('2027-04-24'), '2027-04-24');
  assert.equal(asDay(null), null);
  assert.equal(asDay(new Date('nonsense')), null);

  const content = buildUserContent({
    email: EMAIL,
    booking: { bookingId: 'BOOK-1', date: new Date('2027-04-24T00:00:00Z') },
  });
  assert.match(content, /Date: 2027-04-24/);
  assert.ok(!/GMT|Coordinated Universal/.test(content));
});

test('the prompt says who the draft is written to, and marks the lead guest as not the sender', () => {
  // A tour operator writes in about a group booked in somebody else's name.
  // Handed the booking's name with nothing to tell it apart by, the model
  // opens the draft "Dear John" to a travel agent, and the club's reply is
  // addressed to a person who never wrote.
  assert.match(SYSTEM_PROMPT, /reply to whoever sent the email/i);
  assert.match(SYSTEM_PROMPT, /Greet the sender, never the lead guest/i);

  const operator = buildUserContent({
    email: { ...EMAIL, fromEmail: 'groups@tours.test' },
    booking: { bookingId: 'BOOK-1', guestName: 'John Smith', guestEmail: 'john@example.com' },
  });
  assert.match(operator, /Lead guest: John Smith \(the name on the booking - NOT the sender of this email\)/);

  // The guest wrote themselves: the booking's name is the sender's own.
  const guest = buildUserContent({
    email: { ...EMAIL, fromEmail: 'John@example.com' },
    booking: { bookingId: 'BOOK-1', guestName: 'John Smith', guestEmail: 'john@example.com' },
  });
  assert.match(guest, /Lead guest: John Smith \(who sent this email\)/);
});
