import test from 'node:test';
import assert from 'node:assert/strict';
import { FILTERED, scrubBreadcrumb, scrubEvent, scrubText } from '../src/lib/sentry-scrub.js';

test('query strings and addresses are scrubbed from text', () => {
  assert.equal(
    scrubText('GET /api/changes/booking?ref=TMG-1&token=abc failed for jane@example.com'),
    `GET /api/changes/booking?${FILTERED} failed for j***@example.com`,
  );
  assert.equal(
    scrubText('https://x.example/manage-booking?ref=A&token=B'),
    `https://x.example/manage-booking?${FILTERED}`,
  );
  assert.equal(scrubText(42), 42);
});

test('an event keeps only method and path of its request, and loses the user', () => {
  const event = scrubEvent({
    request: {
      method: 'GET',
      url: 'https://d.example/api/changes/booking?ref=A&token=secret',
      query_string: 'ref=A&token=secret',
      headers: { cookie: 'teemail_session=jwt' },
      cookies: { teemail_session: 'jwt' },
      data: { password: 'x' },
    },
    user: { ip_address: '1.2.3.4', email: 'a@b.example' },
    exception: { values: [{ type: 'Error', value: 'no booking for guest@example.com' }] },
    breadcrumbs: [{ message: 'fetch https://api.example/x?key=1' }],
    extra: { email: 'guest@example.com' },
    tags: { scope: 'api' },
    transaction: 'GET /api/changes/booking?ref=A',
  });
  assert.deepEqual(event.request, { method: 'GET', url: 'https://d.example/api/changes/booking' });
  assert.equal(event.user, undefined);
  assert.equal(event.exception.values[0].value, 'no booking for g***@example.com');
  assert.equal(event.breadcrumbs[0].message, `fetch https://api.example/x?${FILTERED}`);
  assert.equal(event.extra.email, 'g***@example.com');
  assert.equal(event.transaction, 'GET /api/changes/booking');
});

test('breadcrumb URLs lose their query and fragment data', () => {
  const crumb = scrubBreadcrumb({
    category: 'http',
    data: { url: 'https://api.stripe.com/v1/x?email=a@b.example', 'http.query': 'email=a@b.example', method: 'GET' },
  });
  assert.deepEqual(crumb.data, { url: 'https://api.stripe.com/v1/x', method: 'GET' });
});
