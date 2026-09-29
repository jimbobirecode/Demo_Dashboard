import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TTL_MINUTES,
  buildResetTemplateData,
  cleanAddress,
  createThrottle,
  hashToken,
  maskAddress,
  mintToken,
  publicResetConfig,
  readResetConfig,
  resetLink,
  resetRowUsable,
  resolveResetEmail,
  validatePassword,
} from '../src/lib/password-reset-domain.js';

const ENV = {
  SENDGRID_API_KEY: 'SG.secret',
  FROM_EMAIL: 'bookings@royaldornoch.com',
  SENDGRID_TEMPLATE_PASSWORD_RESET: 'd-reset',
  APP_URL: 'https://dashboard.example.com/',
};

test('configuration names every missing piece', () => {
  assert.deepEqual(readResetConfig({}).missing, [
    'SENDGRID_API_KEY',
    'FROM_EMAIL',
    'SENDGRID_TEMPLATE_PASSWORD_RESET',
  ]);
  assert.equal(readResetConfig({}).configured, false);
  // Links are never relative: without APP_URL they open the TeeMail dashboard.
  assert.equal(readResetConfig({}).appUrl, 'https://democlub.teemail.io');
  assert.equal(readResetConfig({ PUBLIC_URL: 'https://x.example/' }).appUrl, 'https://x.example');

  const config = readResetConfig(ENV);
  assert.equal(config.configured, true);
  assert.equal(config.appUrl, 'https://dashboard.example.com', 'the trailing slash is dropped');
  assert.equal(config.ttlMinutes, DEFAULT_TTL_MINUTES);
  assert.equal(readResetConfig({ ...ENV, PASSWORD_RESET_TTL_MINUTES: '15' }).ttlMinutes, 15);
  assert.equal(
    readResetConfig({ ...ENV, PASSWORD_RESET_TTL_MINUTES: 'soon' }).ttlMinutes,
    DEFAULT_TTL_MINUTES,
    'nonsense falls back rather than producing a link that never expires',
  );
  assert.equal(readResetConfig({ ...ENV, APP_URL: '', PUBLIC_URL: 'https://x.dev' }).configured, true);
});

test('the public shape never carries the API key', () => {
  const published = publicResetConfig(readResetConfig(ENV), { migrated: true });

  assert.equal(published.apiKey, undefined);
  assert.equal(published.hasApiKey, true);
  assert.equal(published.available, true);
  assert.equal(
    publicResetConfig(readResetConfig(ENV), { migrated: false }).available,
    false,
    'an un-migrated install cannot offer reset however well SendGrid is configured',
  );
  assert.equal(publicResetConfig(readResetConfig({}), { migrated: true }).available, false);
});

test('the token is random, hashed, and never stored in the clear', () => {
  const now = new Date('2026-09-16T10:00:00Z');
  const first = mintToken({ ttlMinutes: 30, now });
  const second = mintToken({ ttlMinutes: 30, now });

  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, hashToken(first.token));
  assert.notEqual(first.tokenHash, first.token);
  assert.equal(first.tokenHash.length, 64, 'SHA-256, hex');
  assert.equal(first.expiresAt.toISOString(), '2026-09-16T10:30:00.000Z');
  assert.ok(!/[+/=]/.test(first.token), 'base64url survives an email client');
});

test('the link is absolute, escapes the token, and says what it is for', () => {
  assert.equal(
    resetLink('https://dashboard.example.com/', 'a+b/c='),
    'https://dashboard.example.com/reset-password?token=a%2Bb%2Fc%3D',
  );
  assert.equal(
    resetLink('https://dashboard.example.com', 'tok', 'invite'),
    'https://dashboard.example.com/accept-invite?token=tok',
    'an invitation has no password to reset, and its URL should not claim otherwise',
  );
});

test('an invitation fills every variable a hand-written template reaches for', () => {
  const link = resetLink('https://dashboard.teemail.io', 'tok', 'invite');
  const data = buildResetTemplateData({
    user: { username: 'ann', full_name: 'Ann Bell', email: 'ann@club.com' },
    link,
    ttlMinutes: 10080,
    clubName: 'Royal Dornoch Golf Club',
    fromEmail: 'support@teemail.io',
    purpose: 'invite',
    invitedBy: 'Jamie Kenny',
    role: 'staff',
    toEmail: 'ann@club.com',
  });

  // The link must never be empty under any spelling: a template reaching for a
  // name nothing supplies renders a button that goes nowhere.
  for (const key of ['reset_url', 'reset_link', 'invite_url', 'invite_link', 'action_url', 'url']) {
    assert.equal(data[key], link, `${key} must carry the link`);
  }

  assert.equal(data.inviter_name, 'Jamie Kenny');
  assert.equal(data.invited_by, 'Jamie Kenny', 'both spellings, for whichever the template uses');
  assert.equal(data.email, 'ann@club.com');
  assert.equal(data.role, 'Staff', 'spelled for somebody who does not work on the dashboard');
  assert.equal(data.expires_in, '7 days');
  assert.equal(data.first_name, 'Ann');
  assert.equal(data.club_name, 'Royal Dornoch Golf Club');
  assert.equal(data.support_email, 'support@teemail.io');

  // A reset carries no inviter and no role — the template's {{#if}} branches
  // have to fall through rather than print 'null'.
  const reset = buildResetTemplateData({ user: { username: 'ann' }, link, ttlMinutes: 60 });
  assert.equal(reset.inviter_name, null);
  assert.equal(reset.role, null);
  assert.equal(reset.invite_url, link, 'the link is present whatever the purpose');
});

test('where to send: the column first, an email-shaped username second', () => {
  assert.equal(resolveResetEmail({ email: ' Ops@Club.COM ', username: 'ops' }), 'ops@club.com');
  assert.equal(resolveResetEmail({ email: null, username: 'jamie@club.com' }), 'jamie@club.com');
  assert.equal(resolveResetEmail({ email: 'not an address', username: 'demo' }), null);
  assert.equal(resolveResetEmail({}), null);
});

test('addresses are masked for display', () => {
  assert.equal(maskAddress('jamie.kenny@example.com'), 'j**********@example.com');
  assert.equal(maskAddress('a@b.co'), 'a*@b.co', 'a one-character local part still gets a star');
  assert.equal(maskAddress('nonsense'), null);
  assert.equal(cleanAddress('  UPPER@Case.io '), 'upper@case.io');
});

test('a reset row is usable only while it is fresh and unspent', () => {
  const now = new Date('2026-09-16T10:00:00Z');
  const live = { expires_at: '2026-09-16T10:30:00Z', used_at: null };

  assert.equal(resetRowUsable(live, now).ok, true);
  assert.equal(resetRowUsable(null, now).ok, false, 'an unknown token is not a hint');
  assert.match(resetRowUsable({ ...live, used_at: '2026-09-16T09:00:00Z' }, now).reason, /already been used/);
  assert.match(resetRowUsable({ ...live, expires_at: '2026-09-16T09:59:59Z' }, now).reason, /expired/);
  assert.equal(
    resetRowUsable({ ...live, expires_at: '2026-09-16T10:00:00Z' }, now).ok,
    false,
    'expiry is exclusive — the instant it expires, it is gone',
  );
});

test('password rules match the change-password screen', () => {
  assert.equal(validatePassword('longenough').ok, true);
  assert.equal(validatePassword('short').ok, false);
  assert.equal(validatePassword(undefined).ok, false);
  assert.equal(validatePassword('longenough', 'longenough').ok, true);
  assert.match(validatePassword('longenough', 'different').reason, /do not match/);
});

test('template data carries the link and a human expiry', () => {
  const data = buildResetTemplateData({
    user: { username: 'jamie', full_name: 'Jamie Kenny', customer_id: 'royal_dornoch' },
    link: 'https://dashboard.example.com/reset-password?token=abc',
    ttlMinutes: 60,
    clubName: 'Royal Dornoch Golf Club',
    fromEmail: 'bookings@royaldornoch.com',
  });

  assert.equal(data.first_name, 'Jamie');
  assert.equal(data.reset_url, data.reset_link, 'both spellings, for whichever the template uses');
  assert.equal(data.expires_in, '1 hour');
  assert.equal(data.club_name, 'Royal Dornoch Golf Club');
  assert.match(data.subject, /Reset your Royal Dornoch/);
  assert.equal(
    buildResetTemplateData({ user: {}, ttlMinutes: 120 }).expires_in,
    '2 hours',
  );
  assert.equal(buildResetTemplateData({ user: {}, ttlMinutes: 45 }).expires_in, '45 minutes');
});

test('the throttle counts the attempt it is asked about', () => {
  const throttle = createThrottle({ limit: 2, windowMs: 1000 });
  const now = 1_000_000;

  assert.equal(throttle.check('ops', now), true);
  assert.equal(throttle.check('ops', now), true);
  assert.equal(throttle.check('ops', now), false, 'the third in the window is refused');
  assert.equal(throttle.check('someone-else', now), true, 'keys are independent');
  assert.equal(throttle.check('ops', now + 1001), true, 'the window rolls');
});
