/**
 * The SendGrid client's failure reporting. What matters here is that a refusal
 * tells whoever reads it what to do: these messages surface on the Accounts and
 * Guest Emails pages, where the reader is a club administrator rather than
 * someone who can read the code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendHtmlEmail, sendTemplateEmail } from '../src/lib/sendgrid.js';

/** A fetch that answers with one canned SendGrid response. */
function stubFetch(status, payload) {
  return async () => ({
    status,
    json: async () => payload,
  });
}

const base = {
  apiKey: 'SG.test',
  fromEmail: 'bookings@democlub.teemail.io',
  fromName: 'TeeMail Golf Club',
  toEmail: 'guest@example.com',
  subject: 'Subject',
  text: 'Text',
  html: '<p>Text</p>',
};

test('a 202 is a send', async () => {
  const result = await sendHtmlEmail({ ...base, fetchImpl: stubFetch(202, {}) });
  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.match(result.message, /guest@example\.com/);
});

test('an unverified sender names the address and says where to fix it', async () => {
  // SendGrid's own wording for this 403.
  const payload = {
    errors: [
      {
        message:
          'The from address does not match a verified Sender Identity. Mail cannot be sent until this error is resolved.',
      },
    ],
  };
  const result = await sendHtmlEmail({ ...base, fetchImpl: stubFetch(403, payload) });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  // SendGrid's own words survive.
  assert.match(result.message, /does not match a verified Sender Identity/);
  // Plus the three things it does not say: which setting, which address, what to do.
  assert.match(result.message, /FROM_EMAIL/);
  assert.match(result.message, /bookings@democlub\.teemail\.io/);
  assert.match(result.message, /Single Sender Verification/);
  assert.match(result.message, /authenticate the domain/);
});

test('the hint reaches template sends too, which is how invitations go out', async () => {
  const payload = { errors: [{ message: 'The from address does not match a verified Sender Identity.' }] };
  const result = await sendTemplateEmail({
    apiKey: 'SG.test',
    fromEmail: 'noreply@example.com',
    fromName: 'Club',
    toEmail: 'staff@example.com',
    templateId: 'd-abc',
    data: {},
    fetchImpl: stubFetch(403, payload),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /noreply@example\.com/);
});

test('other failures are reported as they are, with no sender advice bolted on', async () => {
  // A bad template id is a different problem and must not be mislabelled.
  const payload = { errors: [{ message: 'The template_id must be a valid GUID' }] };
  const result = await sendHtmlEmail({ ...base, fetchImpl: stubFetch(400, payload) });

  assert.equal(result.ok, false);
  assert.match(result.message, /template_id must be a valid GUID/);
  assert.doesNotMatch(result.message, /Single Sender Verification/);

  // A 403 that is not about the sender identity is left alone as well.
  const forbidden = await sendHtmlEmail({
    ...base,
    fetchImpl: stubFetch(403, { errors: [{ message: 'access forbidden' }] }),
  });
  assert.doesNotMatch(forbidden.message, /Single Sender Verification/);
});

test('a body that is not JSON still produces a usable message', async () => {
  const result = await sendHtmlEmail({
    ...base,
    fetchImpl: async () => ({
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /SendGrid error 500/);
});
