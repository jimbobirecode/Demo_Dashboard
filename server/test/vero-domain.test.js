import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoundPayload,
  publicVeroConfig,
  readVeroConfig,
  surveyTemplateData,
  veroEnabledFor,
} from '../src/lib/vero-domain.js';
import { buildTemplateData } from '../src/lib/email-domain.js';
import { requestSurveyLink } from '../src/lib/vero.js';

const ENV = {
  VERO_BASE_URL: 'https://vero.example.com',
  VERO_PARTNER_KEY: 'sk_live_secret',
};

function booking(overrides = {}) {
  return {
    bookingId: 'RD-1041',
    guestEmail: 'ann.mcleod@example.com',
    guestName: 'Ann McLeod',
    contactPhone: '+447700900000',
    date: '2026-03-18',
    teeTime: '08:40',
    players: 4,
    total: 620,
    golfCourses: 'Championship',
    status: 'Booked',
    ...overrides,
  };
}

test('the integration is off until both halves are configured', () => {
  assert.equal(readVeroConfig({}).enabled, false);
  assert.equal(readVeroConfig({ VERO_BASE_URL: ENV.VERO_BASE_URL }).enabled, false);
  assert.equal(readVeroConfig({ VERO_PARTNER_KEY: ENV.VERO_PARTNER_KEY }).enabled, false);
  assert.equal(readVeroConfig(ENV).enabled, true);
});

test('a half-configured integration says which half is missing', () => {
  assert.deepEqual(readVeroConfig({}).missing, ['VERO_BASE_URL', 'VERO_PARTNER_KEY']);
});

test('a trailing slash on the base URL does not produce a double slash', () => {
  const config = readVeroConfig({ ...ENV, VERO_BASE_URL: 'https://vero.example.com/' });
  assert.equal(config.baseUrl, 'https://vero.example.com');
});

test('the config handed to the browser carries no key', () => {
  const published = publicVeroConfig(readVeroConfig(ENV));
  assert.equal(published.apiKey, undefined);
  assert.equal(published.hasApiKey, true);
  assert.equal(JSON.stringify(published).includes('sk_live_secret'), false);
});

test('post-play carries a survey link and pre-arrival does not', () => {
  const config = readVeroConfig(ENV);
  assert.equal(veroEnabledFor(config, 'post_play'), true);
  // Asking somebody to rate a round they have not played yet.
  assert.equal(veroEnabledFor(config, 'pre_arrival'), false);
});

test('a club can opt a campaign in by name', () => {
  const config = readVeroConfig({ ...ENV, VERO_CAMPAIGNS: 'post_play,pre_arrival' });
  assert.equal(veroEnabledFor(config, 'pre_arrival'), true);
});

test('nothing is handed over while the integration is off, whatever the campaign list says', () => {
  const config = readVeroConfig({ VERO_CAMPAIGNS: 'post_play' });
  assert.equal(veroEnabledFor(config, 'post_play'), false);
});

test('the round Vero is told about is keyed on the booking reference', () => {
  const payload = buildRoundPayload(booking());
  assert.equal(payload.external_ref, 'RD-1041');
  assert.equal(payload.play_date, '2026-03-18');
  assert.equal(payload.guest_email, 'ann.mcleod@example.com');
  assert.equal(payload.course_name, 'Championship');
  assert.equal(payload.tee_time, '08:40');
});

test('the handover carries what Vero needs and nothing else', () => {
  const payload = buildRoundPayload(
    booking({ lodgingCost: 480, specialRequests: 'Buggy for the back nine', hotelRequired: true }),
  );
  // A feedback product has no use for the lodging or the caddie notes, and the
  // smallest payload that works is the one that stays correct when either side
  // changes.
  for (const key of Object.keys(payload)) {
    assert.ok(
      [
        'external_ref',
        'play_date',
        'guest_name',
        'guest_email',
        'guest_phone',
        'course_name',
        'tee_time',
        'players',
        'spend_amount',
        'site',
        'dry_run',
      ].includes(key),
      `unexpected field sent to Club Vero: ${key}`,
    );
  }
});

test('a zero total is left out rather than sent as a spend of nothing', () => {
  const payload = buildRoundPayload(booking({ total: 0, players: 0 }));
  assert.equal('spend_amount' in payload, false);
  assert.equal('players' in payload, false);
});

test('the club slug travels only where one is configured', () => {
  assert.equal('site' in buildRoundPayload(booking()), false);
  assert.equal(buildRoundPayload(booking(), { site: 'royal-dornoch' }).site, 'royal-dornoch');
});

test('a survey link reaches the template under both spellings', () => {
  const data = surveyTemplateData({
    surveyUrl: 'https://vero.example.com/s/abc',
    unsubscribeUrl: 'https://vero.example.com/u/abc',
  });
  assert.equal(data.survey_url, 'https://vero.example.com/s/abc');
  assert.equal(data.feedback_url, 'https://vero.example.com/s/abc');
  assert.equal(data.unsubscribe_url, 'https://vero.example.com/u/abc');
});

test('without the integration the template data is exactly what it always was', () => {
  const before = buildTemplateData(booking(), { fromEmail: 'bookings@royaldornoch.com' });
  assert.equal('survey_url' in before, false);
  assert.equal('unsubscribe_url' in before, false);

  const after = buildTemplateData(booking(), {
    fromEmail: 'bookings@royaldornoch.com',
    survey: { surveyUrl: 'https://vero.example.com/s/abc' },
  });
  assert.equal(after.survey_url, 'https://vero.example.com/s/abc');
  // And every field the existing SendGrid templates render is untouched.
  assert.equal(after.guest_name, before.guest_name);
  assert.equal(after.booking_reference, before.booking_reference);
});

// --- the call itself -------------------------------------------------------

function stubFetch(response) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    };
  };
  impl.calls = calls;
  return impl;
}

const CALL = { baseUrl: ENV.VERO_BASE_URL, apiKey: ENV.VERO_PARTNER_KEY, source: 'dornoch' };

test('the key travels in a header, never in the body', async () => {
  const fetchImpl = stubFetch({ status: 200, body: { created: true, survey_url: 'https://vero.example.com/s/abc' } });
  await requestSurveyLink({ ...CALL, round: buildRoundPayload(booking()), fetchImpl });

  const [call] = fetchImpl.calls;
  assert.equal(call.options.headers['x-partner-key'], 'sk_live_secret');
  assert.equal(call.options.headers['x-partner-source'], 'dornoch');
  assert.equal(call.options.body.includes('sk_live_secret'), false);
  assert.equal(call.url, 'https://vero.example.com/api/partner/golf-round');
});

test('a minted survey comes back as a link', async () => {
  const fetchImpl = stubFetch({
    status: 200,
    body: {
      created: true,
      survey_url: 'https://vero.example.com/s/abc',
      unsubscribe_url: 'https://vero.example.com/u/abc',
      outlet: 'Championship Course',
    },
  });
  const outcome = await requestSurveyLink({ ...CALL, round: buildRoundPayload(booking()), fetchImpl });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.surveyUrl, 'https://vero.example.com/s/abc');
  assert.equal(outcome.unsubscribeUrl, 'https://vero.example.com/u/abc');
  assert.equal(outcome.created, true);
});

test('a repeat of the same booking gets the same link back, not a second survey', async () => {
  const fetchImpl = stubFetch({
    status: 200,
    body: { created: false, answered: true, survey_url: 'https://vero.example.com/s/abc' },
  });
  const outcome = await requestSurveyLink({ ...CALL, round: buildRoundPayload(booking()), fetchImpl });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.created, false);
  assert.equal(outcome.answered, true);
});

test('an unsubscribed guest is a success with no link, not a failure', async () => {
  const fetchImpl = stubFetch({
    status: 200,
    body: { suppressed: true, reason: 'This guest has unsubscribed from feedback requests' },
  });
  const outcome = await requestSurveyLink({ ...CALL, round: buildRoundPayload(booking()), fetchImpl });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.suppressed, true);
  assert.equal(outcome.surveyUrl, undefined);
});

test('a refusal is reported with the reason Vero gave', async () => {
  const fetchImpl = stubFetch({ status: 401, body: { error: 'Unrecognised partner or key' } });
  const outcome = await requestSurveyLink({ ...CALL, round: buildRoundPayload(booking()), fetchImpl });

  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /401/);
  assert.match(outcome.message, /Unrecognised partner or key/);
});

test('a 200 with no link in it is a failure, not an email with an empty button', async () => {
  const fetchImpl = stubFetch({ status: 200, body: { created: true } });
  const outcome = await requestSurveyLink({ ...CALL, round: buildRoundPayload(booking()), fetchImpl });

  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /no survey link/);
});

test('an unreachable Vero is reported, not thrown', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const outcome = await requestSurveyLink({ ...CALL, round: buildRoundPayload(booking()), fetchImpl });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, 'ECONNREFUSED');
});

test('a preview asks Vero what it would do and is told, without a link', async () => {
  const fetchImpl = stubFetch({
    status: 200,
    body: { dry_run: true, would_create: true, outlet: 'Championship Course' },
  });
  const outcome = await requestSurveyLink({
    ...CALL,
    round: buildRoundPayload(booking(), { dryRun: true }),
    fetchImpl,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.dryRun, true);
  assert.equal(outcome.surveyUrl, undefined);
  assert.equal(JSON.parse(fetchImpl.calls[0].options.body).dry_run, true);
});
