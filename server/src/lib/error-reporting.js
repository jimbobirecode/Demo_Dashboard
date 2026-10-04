/**
 * Optional error reporting to Sentry.
 *
 * Off unless SENTRY_DSN is set. When on, every logger.error that carries an
 * Error is reported, as are unhandled rejections and uncaught exceptions.
 * sendDefaultPii is off, and every event and breadcrumb passes through
 * lib/sentry-scrub.js: no cookies, headers, IPs, request bodies or query
 * strings (link tokens) leave the server, and email addresses are masked,
 * because bookings carry guests' names, addresses and phone numbers.
 */
import { logger, setErrorHook } from './logger.js';
import { scrubBreadcrumb, scrubEvent } from './sentry-scrub.js';

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
    includeLocalVariables: false,
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
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
