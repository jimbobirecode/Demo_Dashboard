import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBookedCustomerPayload,
  publicBookedWebhookConfig,
  readBookedWebhookConfig,
  shouldSendBooked,
} from '../src/lib/booked-webhook-domain.js';
import { postBookedCustomer } from '../src/lib/booked-webhook.js';

const ENV = {
  BOOKED_WEBHOOK_URL: 'https://crm.example.com/hooks/booked',
  BOOKED_WEBHOOK_KEY: 'whk_live_secret',
};

function booking(overrides = {}) {
  return {
    bookingId: 'RD-1041',
    club: 'royal_dornoch',
    guestEmail: 'ann.mcleod@example.com',
    guestName: 'Ann McLeod',
    contactPhone: '+447700900000',
    date: '2026-03-18',
    teeTime: '08:40',
    players: 4,
    total: 620,
    golfCourses: 'Championship',
    caddieRequirements: '2 caddies',
    status: 'Booked',
    updatedAt: '2026-02-01T09:15:00.000Z',
    bookedWebhookSentAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('the integration is off until both halves are configured', () => {
  assert.equal(readBookedWebhookConfig({}).enabled, false);
  assert.equal(readBookedWebhookConfig({ BOOKED_WEBHOOK_URL: ENV.BOOKED_WEBHOOK_URL }).enabled, false);
  assert.equal(readBookedWebhookConfig({ BOOKED_WEBHOOK_KEY: ENV.BOOKED_WEBHOOK_KEY }).enabled, false);
  assert.equal(readBookedWebhookConfig(ENV).enabled, true);
});

test('a half-configured integration says which half is missing', () => {
  assert.deepEqual(readBookedWebhookConfig({}).missing, ['BOOKED_WEBHOOK_URL', 'BOOKED_WEBHOOK_KEY']);
  assert.deepEqual(readBookedWebhookConfig({ BOOKED_WEBHOOK_URL: ENV.BOOKED_WEBHOOK_URL }).missing, [
    'BOOKED_WEBHOOK_KEY',
  ]);
});

test('a plain http endpoint is refused: the guest details would travel in clear', () => {
  const config = readBookedWebhookConfig({ ...ENV, BOOKED_WEBHOOK_URL: 'http://crm.example.com/hooks/booked' });
  assert.equal(config.insecure, true);
  assert.equal(config.enabled, false);
});

test('http on loopback is allowed, so the integration can be tried locally', () => {
  const config = readBookedWebhookConfig({ ...ENV, BOOKED_WEBHOOK_URL: 'http://localhost:9000/hooks' });
  assert.equal(config.insecure, false);
  assert.equal(config.enabled, true);
});

test('the key travels in x-webhook-key unless the environment names another header', () => {
  assert.equal(readBookedWebhookConfig(ENV).authHeader, 'x-webhook-key');
  assert.equal(
    readBookedWebhookConfig({ ...ENV, BOOKED_WEBHOOK_AUTH_HEADER: 'Authorization' }).authHeader,
    'authorization',
  );
});

test('the config handed to the browser carries no key', () => {
  const published = publicBookedWebhookConfig(readBookedWebhookConfig(ENV));
  assert.equal(published.apiKey, undefined);
  assert.equal(published.hasApiKey, true);
  assert.equal(JSON.stringify(published).includes('whk_live_secret'), false);
});

// ---------------------------------------------------------------------------
// What is sent
// ---------------------------------------------------------------------------

test('the payload carries the customer and their round', () => {
  const payload = buildBookedCustomerPayload(booking(), {
    source: 'dornoch',
    sentAt: new Date('2026-02-01T10:00:00Z'),
  });

  assert.equal(payload.event, 'booking.booked');
  assert.equal(payload.bookingRef, 'RD-1041');
  assert.equal(payload.club, 'royal_dornoch');
  assert.equal(payload.source, 'dornoch');
  assert.equal(payload.sentAt, '2026-02-01T10:00:00.000Z');
  assert.equal(payload.bookedAt, '2026-02-01T09:15:00.000Z');
  assert.deepEqual(payload.customer, {
    name: 'Ann McLeod',
    email: 'ann.mcleod@example.com',
    phone: '+447700900000',
  });
  assert.deepEqual(payload.round, {
    date: '2026-03-18',
    teeTime: '08:40',
    players: 4,
    course: 'Championship',
    caddies: { requirement: '2 caddies', status: 'Requested', estimatedCaddies: 2 },
  });
});

test('the caddie answer is sent as recorded, classified, and counted', () => {
  const caddies = (caddieRequirements, players = 4) =>
    buildBookedCustomerPayload(booking({ caddieRequirements, players }), {}).round.caddies;

  // The fixed answers the enquiry form itself writes.
  assert.deepEqual(caddies('2 caddies'), { requirement: '2 caddies', status: 'Requested', estimatedCaddies: 2 });
  assert.deepEqual(caddies('4 caddies (one per player)'), {
    requirement: '4 caddies (one per player)',
    status: 'Requested',
    estimatedCaddies: 4,
  });
  assert.deepEqual(caddies('Forecaddie'), {
    requirement: 'Forecaddie',
    status: 'Requested',
    estimatedCaddies: 1,
  });
  assert.deepEqual(caddies('No caddies required'), {
    requirement: 'No caddies required',
    status: 'Not required',
    estimatedCaddies: null,
  });
});

test('a caddie estimate is only offered where caddies were asked for', () => {
  // A number beside a refusal would be read as a booking for that many.
  for (const refusal of ['No caddies required', 'not required', 'No caddies']) {
    const { status, estimatedCaddies } = buildBookedCustomerPayload(booking({ caddieRequirements: refusal }), {}).round
      .caddies;
    assert.equal(status, 'Not required', refusal);
    assert.equal(estimatedCaddies, null, refusal);
  }
});

test('an unanswered caddie question is sent as unanswered, not as a refusal', () => {
  for (const blank of ['', null, undefined, 'n/a']) {
    const { requirement, status, estimatedCaddies } = buildBookedCustomerPayload(
      booking({ caddieRequirements: blank }),
      {},
    ).round.caddies;
    assert.equal(requirement, blank || null, `requirement for ${JSON.stringify(blank)}`);
    assert.equal(status, 'Not specified', `status for ${JSON.stringify(blank)}`);
    assert.equal(estimatedCaddies, null, `estimate for ${JSON.stringify(blank)}`);
  }
});

test('"for all players" is estimated at the party size, the answer that carries no number', () => {
  const four = buildBookedCustomerPayload(booking({ caddieRequirements: 'Caddies for all players', players: 4 }), {});
  assert.equal(four.round.caddies.estimatedCaddies, 4);
  const two = buildBookedCustomerPayload(booking({ caddieRequirements: 'Caddies for all players', players: 2 }), {});
  assert.equal(two.round.caddies.estimatedCaddies, 2);
});

test('the handover reads the caddie field exactly as the Analytics page does', async () => {
  // One booking must not be a request on one screen and a refusal on another.
  const { classifyCaddie } = await import('../src/lib/analytics-domain.js');

  for (const text of ['2 caddies', 'Caddies for all players', 'No caddies required', 'No. of caddies: 4', '', 'n/a']) {
    const payload = buildBookedCustomerPayload(booking({ caddieRequirements: text }), {});
    assert.equal(payload.round.caddies.status, classifyCaddie(text), text);
  }
});

test('the payload carries no money, no lodging and no staff or guest free text', () => {
  const payload = buildBookedCustomerPayload(
    booking({
      total: 620,
      amountPaid: 310,
      lodgingCost: 480,
      lodgingPreferences: 'Sea view if possible',
      specialRequests: 'Ann is recovering from surgery',
      note: 'internal: operator disputes the rate',
    }),
    { source: 'dornoch' },
  );

  const json = JSON.stringify(payload);
  // The caddie answer is sent (somebody has to turn up for it); everything
  // else on this list is the club's terms or the guest's own words.
  for (const leak of ['620', '310', '480', 'sea view', 'surgery', 'disputes']) {
    assert.equal(json.toLowerCase().includes(leak.toLowerCase()), false, `payload leaked ${leak}`);
  }
});

test('a missing name or phone is sent as null rather than an empty string', () => {
  const payload = buildBookedCustomerPayload(booking({ guestName: '', contactPhone: '' }), {});
  assert.equal(payload.customer.name, null);
  assert.equal(payload.customer.phone, null);
});

// ---------------------------------------------------------------------------
// Which bookings are sent
// ---------------------------------------------------------------------------

test('only a booking that has reached Booked is handed over', () => {
  assert.equal(shouldSendBooked(booking()), true);
  assert.equal(shouldSendBooked(booking({ status: 'Inquiry' })), false);
  assert.equal(shouldSendBooked(booking({ status: 'Requested' })), false);
  assert.equal(shouldSendBooked(booking({ status: 'Cancelled' })), false);
});

test('a booking already stamped as sent is never sent again', () => {
  assert.equal(shouldSendBooked(booking({ bookedWebhookSentAt: '2026-02-01T09:20:00.000Z' })), false);
});

test('a booking with no way to reach the customer is not sent', () => {
  assert.equal(shouldSendBooked(booking({ guestEmail: '', contactPhone: '' })), false);
  // Either one on its own is enough to be worth sending.
  assert.equal(shouldSendBooked(booking({ guestEmail: '', contactPhone: '+447700900000' })), true);
  assert.equal(shouldSendBooked(booking({ guestEmail: 'ann@example.com', contactPhone: '' })), true);
});

// ---------------------------------------------------------------------------
// The POST
// ---------------------------------------------------------------------------

function stubFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return responder(url, options);
  };
  return { calls, fetchImpl };
}

function response({ ok = true, status = 200, body = '{"received":true}' } = {}) {
  return { ok, status, json: async () => JSON.parse(body), text: async () => body };
}

test('the booking is POSTed as JSON with the key in a header, never in the body', async () => {
  const config = readBookedWebhookConfig(ENV);
  const payload = buildBookedCustomerPayload(booking(), { source: config.source });
  const { calls, fetchImpl } = stubFetch(() => response());

  const outcome = await postBookedCustomer({ config, payload, fetchImpl });

  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://crm.example.com/hooks/booked');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['x-webhook-key'], 'whk_live_secret');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.body.includes('whk_live_secret'), false);
  assert.equal(JSON.parse(calls[0].options.body).bookingRef, 'RD-1041');
});

test('a refusal the receiver will never accept is not worth retrying', async () => {
  const config = readBookedWebhookConfig(ENV);
  const payload = buildBookedCustomerPayload(booking(), {});
  const { fetchImpl } = stubFetch(() => response({ ok: false, status: 400, body: 'date is required' }));

  const outcome = await postBookedCustomer({ config, payload, fetchImpl });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.retryable, false);
  assert.match(outcome.message, /RD-1041 refused \(400\): date is required/);
});

test('a receiver that is down is worth retrying', async () => {
  const config = readBookedWebhookConfig(ENV);
  const payload = buildBookedCustomerPayload(booking(), {});

  for (const status of [429, 500, 502, 503, 504]) {
    const { fetchImpl } = stubFetch(() => response({ ok: false, status, body: '' }));
    const outcome = await postBookedCustomer({ config, payload, fetchImpl });
    assert.equal(outcome.ok, false, `${status} should not be a success`);
    assert.equal(outcome.retryable, true, `${status} should be retryable`);
  }
});

test('a network failure is reported as retryable rather than thrown', async () => {
  const config = readBookedWebhookConfig(ENV);
  const payload = buildBookedCustomerPayload(booking(), {});
  const { fetchImpl } = stubFetch(() => {
    throw new Error('getaddrinfo ENOTFOUND crm.example.com');
  });

  const outcome = await postBookedCustomer({ config, payload, fetchImpl });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.retryable, true);
  assert.match(outcome.message, /ENOTFOUND/);
});

test("a failing endpoint's error page does not end up in the log line", async () => {
  const config = readBookedWebhookConfig(ENV);
  const payload = buildBookedCustomerPayload(booking(), {});
  const { fetchImpl } = stubFetch(() => response({ ok: false, status: 502, body: '<html>'.padEnd(5000, 'x') }));

  const outcome = await postBookedCustomer({ config, payload, fetchImpl });

  assert.ok(outcome.message.length < 300, `message was ${outcome.message.length} characters`);
});

// ---------------------------------------------------------------------------
// The guards in front of the database. Everything below runs without one:
// an unconfigured integration must decide not to send before it reads a row.
// ---------------------------------------------------------------------------

test('nothing is sent, and nothing is read, while the integration is unconfigured', async () => {
  const { handoverBookedCustomer, sweepBookedCustomers } = await import('../src/lib/booked-webhook-outbox.js');

  assert.deepEqual(await handoverBookedCustomer(booking(), { env: {} }), { ok: true, skipped: 'not configured' });
  assert.deepEqual(await sweepBookedCustomers({ env: {} }), { skipped: 'not configured' });
});

test('a booking that is not one to send never reaches the endpoint', async () => {
  const { handoverBookedCustomer } = await import('../src/lib/booked-webhook-outbox.js');
  const { calls, fetchImpl } = stubFetch(() => response());

  const outcome = await handoverBookedCustomer(booking({ status: 'Requested' }), { env: ENV, fetchImpl });

  assert.deepEqual(outcome, { ok: true, skipped: 'nothing to send' });
  assert.equal(calls.length, 0);
});

test('an http endpoint stops the sweep from ever starting', async () => {
  const { startBookedWebhook } = await import('../src/lib/booked-webhook-outbox.js');
  const stop = startBookedWebhook({ env: { ...ENV, BOOKED_WEBHOOK_URL: 'http://crm.example.com/hooks' } });
  assert.equal(typeof stop, 'function');
  stop();
});
