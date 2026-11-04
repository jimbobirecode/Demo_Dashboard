/**
 * The audit trail: what is written, and what is never written.
 *
 * The redaction tests are the ones that matter most. A trail that records a
 * password, a Stripe key or a session token has turned the club's own
 * accountability record into the most valuable file in the building.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RETENTION_DAYS, auditEntry, describeAction, outcomeFor, redact } from '../src/lib/audit.js';

test('no secret reaches the table, at any depth or spelling', () => {
  const body = {
    email: 'alice@club.test',
    password: 'hunter2',
    newPassword: 'hunter3',
    password_confirmation: 'hunter3',
    token: 'abc',
    apiKey: 'sk_live_51H',
    api_key: 'sk_live_51H',
    Authorization: 'Bearer x',
    signature: 'whsec',
    nested: { deeper: { secret: 'x', fine: 'kept' } },
    list: [{ token: 'x' }, 'plain'],
  };
  const clean = redact(body);

  const asText = JSON.stringify(clean);
  for (const leak of ['hunter2', 'hunter3', 'sk_live_51H', 'Bearer x', 'whsec', 'abc']) {
    assert.ok(!asText.includes(leak), `${leak} must never be stored`);
  }
  // Replaced, not dropped: that a password WAS sent is itself audit-worthy.
  assert.equal(clean.password, '[redacted]');
  assert.equal(clean.nested.deeper.secret, '[redacted]');
  assert.equal(clean.list[0].token, '[redacted]');
  // Everything else survives, which is the point of keeping the body at all.
  assert.equal(clean.email, 'alice@club.test');
  assert.equal(clean.nested.deeper.fine, 'kept');
  assert.equal(clean.list[1], 'plain');
});

test('a long free-text field is kept readable, not copied whole', () => {
  const clean = redact({ body: 'x'.repeat(2000) });
  assert.equal(clean.body.length, 501, 'trimmed, with an ellipsis');
  assert.ok(clean.body.endsWith('…'));
  // The trail records that an email was sent, not a second copy of it.
});

test('an action is named from its path, and the record it acted on is kept apart', () => {
  const cases = [
    ['PATCH', '/api/bookings/BOOK-20260910-973406B3/payment', 'booking.payment.update', 'BOOK-20260910-973406B3'],
    ['PATCH', '/api/bookings/BOOK-1/status', 'booking.status.change', 'BOOK-1'],
    ['POST', '/api/payments/bookings/BOOK-1/link', 'payment.link.send', 'BOOK-1'],
    ['POST', '/api/changes/12/approve', 'change_request.approve', '12'],
    ['DELETE', '/api/operators/14', 'operator.delete', '14'],
    ['POST', '/api/operators', 'operator.create', null],
    ['POST', '/api/auth/login', 'auth.login', null],
    ['PATCH', '/api/membership/applications/7/status', 'membership.application.decide', '7'],
  ];
  for (const [method, path, action, entityId] of cases) {
    const described = describeAction(method, path);
    assert.equal(described.action, action, path);
    assert.equal(described.entityId, entityId, `${path} id`);
  }

  // Ids are dropped from the name, so every edit of every booking groups
  // under one action on the screen rather than making 1,867 of them.
  assert.equal(
    describeAction('PATCH', '/api/bookings/BOOK-20260910-973406B3/note').action,
    describeAction('PATCH', '/api/bookings/CLG-20270101-AB12/note').action,
  );

  // The rule is "a segment with a digit in it", which every id in this API
  // has (a dated booking reference, a serial, a batch id) and no route word
  // does. An id of letters alone would be read as a route word and name its
  // own action - worth knowing if one is ever introduced.
  assert.equal(describeAction('PATCH', '/api/bookings/alpha/note').entityId, null);

  // A route nobody has written yet still gets a name rather than being lost.
  assert.equal(describeAction('POST', '/api/newthing/42/frobnicate').action, 'newthing.frobnicate.create');
});

test('the outcome says whether the change actually happened', () => {
  assert.equal(outcomeFor(200), 'applied');
  assert.equal(outcomeFor(204), 'applied');
  assert.equal(outcomeFor(400), 'refused');
  assert.equal(outcomeFor(403), 'refused', 'a refused attempt is worth keeping');
  assert.equal(outcomeFor(409), 'refused');
  assert.equal(outcomeFor(500), 'failed');
});

test('a whole entry carries who, what and from where', () => {
  const req = {
    method: 'PATCH',
    originalUrl: '/api/bookings/BOOK-1/payment?x=1',
    body: { amountPaid: 390, paymentStatus: 'Deposit paid' },
    get: () => 'Mozilla/5.0',
  };
  const entry = auditEntry({
    req,
    status: 200,
    club: 'baltray',
    actor: 'alice@club.test',
    actorRole: 'admin',
    ip: '203.0.113.9',
  });

  assert.equal(entry.club, 'baltray');
  assert.equal(entry.actor, 'alice@club.test');
  assert.equal(entry.actor_role, 'admin');
  assert.equal(entry.action, 'booking.payment.update');
  assert.equal(entry.entity_type, 'booking');
  assert.equal(entry.entity_id, 'BOOK-1');
  assert.equal(entry.outcome, 'applied');
  assert.equal(entry.path, '/api/bookings/BOOK-1/payment', 'the query string is not kept');
  assert.deepEqual(entry.details, { amountPaid: 390, paymentStatus: 'Deposit paid' });
  assert.equal(entry.ip, '203.0.113.9');

  // A preview writes nothing and an upload is megabytes: neither is stored.
  const preview = auditEntry({
    req: { ...req, originalUrl: '/api/inbox/preview', body: { body: 'draft' } },
    status: 200,
    club: 'baltray',
    actor: 'alice@club.test',
  });
  assert.deepEqual(preview.details, { skipped: true });
});

test('the retention period is a year, and is what the page and the purge both use', () => {
  assert.equal(RETENTION_DAYS, 365);
});
