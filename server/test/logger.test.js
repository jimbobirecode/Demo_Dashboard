import test from 'node:test';
import assert from 'node:assert/strict';
import { logger, setErrorHook } from '../src/lib/logger.js';

function capture(fn) {
  const lines = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (chunk) => lines.push(['out', String(chunk)]) && true;
  process.stderr.write = (chunk) => lines.push(['err', String(chunk)]) && true;
  try {
    fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return lines;
}

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('readable by default, with the scope as a prefix', () => {
  const lines = withEnv({ LOG_FORMAT: 'text', LOG_LEVEL: 'info' }, () =>
    capture(() => logger.child('portal').info('signed in')),
  );
  assert.deepEqual(lines, [['out', '[portal] signed in\n']]);
});

test('LOG_FORMAT=json writes one parseable object per line, errors to stderr', () => {
  const lines = withEnv({ LOG_FORMAT: 'json', LOG_LEVEL: 'info' }, () =>
    capture(() => logger.child('api').error('failed', new Error('boom'), { status: 500 })),
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], 'err');
  const record = JSON.parse(lines[0][1]);
  assert.equal(record.level, 'error');
  assert.equal(record.scope, 'api');
  assert.equal(record.msg, 'failed');
  assert.equal(record.status, 500);
  assert.equal(record.err.message, 'boom');
});

test('LOG_LEVEL filters, and the error hook sees only errors that carry an Error', () => {
  const seen = [];
  setErrorHook((err, ctx) => seen.push([err.message, ctx.scope]));
  try {
    const lines = withEnv({ LOG_FORMAT: 'text', LOG_LEVEL: 'warn' }, () =>
      capture(() => {
        const log = logger.child('x');
        log.info('hidden');
        log.error('no error object');
        log.error('with one', new Error('kaboom'));
      }),
    );
    assert.equal(lines.length, 2);
    assert.deepEqual(seen, [['kaboom', 'x']]);
  } finally {
    setErrorHook(null);
  }
});
