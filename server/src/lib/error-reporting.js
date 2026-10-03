/**
 * Optional error reporting to Sentry.
 *
 * Off unless SENTRY_DSN is set. When on, every logger.error that carries an
 * Error is reported, as are unhandled rejections and uncaught exceptions.
 * sendDefaultPii is off: no cookies, headers, IPs or request bodies leave the
 * server, because bookings carry guests' names, addresses and phone numbers.
 */
import { logger, setErrorHook } from './logger.js';

const log = logger.child('sentry');

export async function initErrorReporting() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

  const Sentry = await import('@sentry/node');
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.RENDER_GIT_COMMIT ?? undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });

  setErrorHook((err, { scope } = {}) => {
    Sentry.captureException(err, scope ? { tags: { scope } } : undefined);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', reason instanceof Error ? reason : new Error(String(reason)));
  });

  log.info('error reporting enabled');
  return true;
}
