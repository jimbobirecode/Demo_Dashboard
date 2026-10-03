import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, maskForLog } from '../src/lib/request-guard.js';

test('clientIp is what Express derived, never the raw X-Forwarded-For', () => {
  const req = { ip: '203.0.113.9', headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' } };
  assert.equal(clientIp(req), '203.0.113.9', 'a client-written first entry is ignored');
  assert.equal(clientIp({ socket: { remoteAddress: '10.0.0.1' }, headers: {} }), '10.0.0.1');
  assert.equal(clientIp({ headers: {} }), 'unknown');
});

test('log masking keeps an address recognisable but not harvestable', () => {
  assert.equal(maskForLog('jamie@example.com'), 'j****@example.com');
  assert.equal(maskForLog('dornoch_demo'), '(12 characters)');
  assert.equal(maskForLog(''), '(blank)');
});
