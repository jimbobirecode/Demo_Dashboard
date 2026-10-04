/**
 * A deliberately small logger.
 *
 * Readable lines by default ("[scope] message"); one JSON object per line
 * when LOG_FORMAT=json, for log drains that parse structure. Errors passed as
 * the last argument are logged with their stack, and — when Sentry is
 * configured — `error()` reports them there too.
 *
 *   const log = logger.child('portal');
 *   log.info('signed in', { operatorId });
 *   log.error('email failed', err);
 */
import util from 'node:util';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let errorHook = null;

/** Called with (err, context) for every logger.error that carries an Error. */
export function setErrorHook(hook) {
  errorHook = hook;
}

function threshold() {
  return LEVELS[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV === 'test' ? LEVELS.warn : LEVELS.info);
}

function serialiseError(err) {
  return { name: err.name, message: err.message, code: err.code, stack: err.stack };
}

function emit(level, scope, args) {
  if (LEVELS[level] < threshold()) return;

  const error = args.find((arg) => arg instanceof Error);
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;

  if (process.env.LOG_FORMAT === 'json') {
    const record = { time: new Date().toISOString(), level, ...(scope ? { scope } : {}) };
    const words = [];
    for (const arg of args) {
      if (arg instanceof Error) record.err = serialiseError(arg);
      else if (arg && typeof arg === 'object' && !Array.isArray(arg)) Object.assign(record, arg);
      else words.push(typeof arg === 'string' ? arg : util.inspect(arg));
    }
    record.msg = words.join(' ');
    stream.write(`${JSON.stringify(record)}\n`);
  } else {
    const prefix = scope ? `[${scope}] ` : '';
    const text = args.map((arg) => (typeof arg === 'string' ? arg : util.inspect(arg, { depth: 4 }))).join(' ');
    stream.write(`${level === 'info' || level === 'debug' ? '' : `${level.toUpperCase()} `}${prefix}${text}\n`);
  }

  if (level === 'error' && error && errorHook) {
    try {
      errorHook(error, { scope });
    } catch {
      // Reporting must never take the request down with it.
    }
  }
}

function make(scope) {
  return {
    debug: (...args) => emit('debug', scope, args),
    info: (...args) => emit('info', scope, args),
    warn: (...args) => emit('warn', scope, args),
    error: (...args) => emit('error', scope, args),
    child: (name) => make(scope ? `${scope}:${name}` : name),
  };
}

export const logger = make(null);
