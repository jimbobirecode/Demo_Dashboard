/**
 * What every request is checked for before a route sees it: where it came
 * from, and how it may be written to the log.
 *
 * Pure functions, so the rules are unit-tested without starting Express.
 */
import { maskAddress } from './password-reset-domain.js';

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
 * An address as it may appear in a log line: enough to recognise, not enough
 * to harvest. Anything that is not an address is reduced to its length.
 */
export function maskForLog(value) {
  const text = String(value ?? '').trim();
  if (!text) return '(blank)';
  return maskAddress(text) ?? `(${text.length} characters)`;
}
