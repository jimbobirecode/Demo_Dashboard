/**
 * What every request is checked for before a route sees it: where it came
 * from, and whether it was sent by this dashboard's own pages.
 *
 * Pure functions plus two thin middlewares, so the rules are unit-tested
 * without starting Express.
 */
import { maskAddress } from './password-reset-domain.js';
import { logger } from './logger.js';

const log = logger.child('api');

/**
 * The address a request came from.
 *
 * Express works this out from X-Forwarded-For using the `trust proxy` setting
 * in index.js (one hop: Render's proxy). Reading the header by hand took its
 * *first* entry, which is whatever the client chose to send — so anybody could
 * give themselves a fresh throttle budget per request by inventing one.
 */
export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * The header the SPA sets on every call that changes something.
 *
 * A browser will not attach a custom header to a cross-site form post, and a
 * cross-site fetch that tries has to pass a CORS preflight this server never
 * grants — so its presence proves the request came from a page on this
 * origin. It complements the SameSite=Lax cookie rather than replacing it.
 */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'teemail';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Server-to-server callers that cannot set our header. They authenticate
 * themselves instead: Stripe signs every webhook body.
 */
export const CSRF_EXEMPT_PATHS = ['/api/stripe/webhook'];

/** The scheme://host[:port] part of a URL, or null. */
export function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a state-changing request may proceed.
 *
 * `allowedOrigins` is this server's own origin plus APP_URL's (and the Vite
 * dev server outside production). An Origin header is optional — not every
 * client sends one on a same-origin request — but when present it must be one
 * of those.
 */
export function checkCsrf({ method, path, headers = {}, allowedOrigins = [] }) {
  if (SAFE_METHODS.has(String(method ?? 'GET').toUpperCase())) return { ok: true };
  if (CSRF_EXEMPT_PATHS.some((prefix) => path === prefix || path?.startsWith(`${prefix}/`))) {
    return { ok: true };
  }

  const marker = String(headers[CSRF_HEADER] ?? '').trim().toLowerCase();
  if (marker !== CSRF_HEADER_VALUE) {
    return { ok: false, reason: 'missing request header' };
  }

  const origin = headers.origin;
  if (origin !== undefined && origin !== '' && !allowedOrigins.includes(origin)) {
    return { ok: false, reason: `origin ${origin} not allowed` };
  }
  return { ok: true };
}

/** The origins a state-changing request may come from, for this request. */
export function allowedOriginsFor(req, env = process.env) {
  const origins = new Set();
  const host = req.get?.('host');
  if (host) origins.add(`${req.protocol}://${host}`);
  const app = originOf(env.APP_URL || env.PUBLIC_URL || '');
  if (app) origins.add(app);
  if (env.NODE_ENV !== 'production') origins.add('http://localhost:5173');
  return [...origins];
}

export function csrfProtection(env = process.env) {
  return (req, res, next) => {
    const verdict = checkCsrf({
      method: req.method,
      path: req.originalUrl.split('?')[0],
      headers: req.headers,
      allowedOrigins: allowedOriginsFor(req, env),
    });
    if (verdict.ok) return next();
    log.warn(`refused ${req.method} ${req.originalUrl.split('?')[0]}: ${verdict.reason}`);
    res.status(403).json({ error: 'This request was refused. Reload the page and try again.' });
  };
}

/**
 * An address as it may appear in a log line: enough to recognise, not enough
 * to harvest. Anything that is not an address is reduced to its length.
 */
export function maskForLog(value) {
  const text = String(value ?? '').trim();
  if (!text) return '(blank)';
  return maskAddress(text) ?? `(${text.length} characters)`;
}

/**
 * The Content-Security-Policy the built SPA runs under.
 *
 *  - scripts only from this origin: Vite emits module scripts, none inline;
 *  - styles from here and Google Fonts, plus 'unsafe-inline' because React
 *    `style` attributes (and every chart Recharts draws) are inline styles;
 *  - images from anywhere over https, and data: URIs — a club's logo may be
 *    hosted elsewhere, and emails previewed in the composer carry their own;
 *  - nobody may frame the dashboard. The email preview is an about:srcdoc
 *    frame, which inherits this policy rather than being fetched, so it needs
 *    no frame-src entry.
 *
 * `upgrade-insecure-requests` is production-only: on http://localhost it
 * would rewrite the page's own assets to an https URL nothing is serving.
 */
export function contentSecurityDirectives(env = process.env) {
  const directives = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
    'img-src': ["'self'", 'data:', 'https:'],
    'connect-src': ["'self'"],
    'frame-src': ["'self'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'object-src': ["'none'"],
  };
  if (env.NODE_ENV === 'production') directives['upgrade-insecure-requests'] = [];
  return directives;
}
