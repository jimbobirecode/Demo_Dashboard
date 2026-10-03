import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CSRF_EXEMPT_PATHS,
  allowedOriginsFor,
  checkCsrf,
  clientIp,
  contentSecurityDirectives,
  maskForLog,
  originOf,
} from '../src/lib/request-guard.js';

const OWN = 'https://democlub.teemail.io';
const ok = { 'x-requested-with': 'teemail' };

test('clientIp is what Express derived, never the raw X-Forwarded-For', () => {
  const req = { ip: '203.0.113.9', headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' } };
  assert.equal(clientIp(req), '203.0.113.9', 'a client-written first entry is ignored');
  assert.equal(clientIp({ socket: { remoteAddress: '10.0.0.1' }, headers: {} }), '10.0.0.1');
  assert.equal(clientIp({ headers: {} }), 'unknown');
});

test('reads are never refused', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(checkCsrf({ method, path: '/api/bookings', headers: {} }).ok, true);
  }
});

test('a state-changing call without the header is refused', () => {
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const verdict = checkCsrf({ method, path: '/api/bookings/X', headers: {}, allowedOrigins: [OWN] });
    assert.equal(verdict.ok, false, method);
  }
  assert.equal(
    checkCsrf({ method: 'POST', path: '/api/auth/login', headers: { 'x-requested-with': 'XMLHttpRequest' } }).ok,
    false,
    'the value has to be ours, not any value',
  );
});

test('the header passes, case-insensitively, with or without an Origin', () => {
  assert.equal(checkCsrf({ method: 'POST', path: '/api/auth/login', headers: ok, allowedOrigins: [OWN] }).ok, true);
  assert.equal(checkCsrf({ method: 'POST', path: '/x', headers: { 'x-requested-with': 'TeeMail' } }).ok, true);
  assert.equal(
    checkCsrf({ method: 'POST', path: '/x', headers: { ...ok, origin: OWN }, allowedOrigins: [OWN] }).ok,
    true,
  );
});

test('a foreign Origin is refused even with the header', () => {
  const verdict = checkCsrf({
    method: 'POST',
    path: '/api/users',
    headers: { ...ok, origin: 'https://evil.example' },
    allowedOrigins: [OWN],
  });
  assert.equal(verdict.ok, false);
  assert.equal(
    checkCsrf({ method: 'POST', path: '/x', headers: { ...ok, origin: 'null' }, allowedOrigins: [OWN] }).ok,
    false,
    'a sandboxed frame sends Origin: null',
  );
});

test('the Stripe webhook is exempt — it is signed instead', () => {
  assert.deepEqual(CSRF_EXEMPT_PATHS, ['/api/stripe/webhook']);
  assert.equal(checkCsrf({ method: 'POST', path: '/api/stripe/webhook', headers: {} }).ok, true);
  assert.equal(
    checkCsrf({ method: 'POST', path: '/api/stripe/webhookish', headers: {} }).ok,
    false,
    'a prefix is a path segment, not a string prefix',
  );
});

test('allowed origins: this host, APP_URL, and the Vite dev server outside production', () => {
  const req = { protocol: 'https', get: (name) => (name === 'host' ? 'dash.example.com' : undefined) };
  assert.deepEqual(allowedOriginsFor(req, { NODE_ENV: 'production', APP_URL: 'https://democlub.teemail.io/' }).sort(), [
    'https://dash.example.com',
    'https://democlub.teemail.io',
  ]);
  assert.ok(allowedOriginsFor(req, {}).includes('http://localhost:5173'));
  assert.equal(originOf('not a url'), null);
});

test('log masking keeps an address recognisable but not harvestable', () => {
  assert.equal(maskForLog('jamie@example.com'), 'j****@example.com');
  assert.equal(maskForLog('dornoch_demo'), '(12 characters)');
  assert.equal(maskForLog(''), '(blank)');
});

test('the CSP forbids framing and inline script, and only upgrades requests in production', () => {
  const dev = contentSecurityDirectives({});
  assert.deepEqual(dev['frame-ancestors'], ["'none'"]);
  assert.deepEqual(dev['script-src'], ["'self'"]);
  assert.ok(dev['img-src'].includes('data:') && dev['img-src'].includes('https:'));
  assert.ok(dev['style-src'].includes("'unsafe-inline'"), 'React style attributes are inline styles');
  assert.equal('upgrade-insecure-requests' in dev, false);
  assert.ok('upgrade-insecure-requests' in contentSecurityDirectives({ NODE_ENV: 'production' }));
});
