/**
 * What may leave the server in a Sentry event.
 *
 * The same rules as the core API's observability.py: a request is reduced to
 * its method and its URL without the query string (a manage-booking link
 * carries its token there); cookies, headers, bodies and the user block are
 * dropped; every message, exception value, breadcrumb, extra and tag has
 * query strings removed from URLs and paths and email addresses masked.
 *
 * Pure functions, unit-tested in server/test/sentry-scrub.test.js.
 */
export const FILTERED = '[Filtered]';

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
// A query string after an absolute URL or a path: /manage-booking?ref=…&token=…
const QUERY = /((?:https?:\/\/[^\s?#"'<>]+)|(?:(?<![\w.])\/[\w\-./]*))\?[^\s#"'<>]+/g;

/** A message as Sentry may see it: query strings dropped, addresses masked. */
export function scrubText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(QUERY, (_, base) => `${base}?${FILTERED}`)
    .replace(EMAIL, (_, head, domain) => `${head}***@${domain}`);
}

export function stripQuery(url) {
  if (typeof url !== 'string') return url;
  return url.split('?')[0].split('#')[0];
}

function scrubValues(value, depth = 0) {
  if (depth > 6) return value;
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => scrubValues(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValues(item, depth + 1)]));
  }
  return value;
}

/** beforeSend / beforeSendTransaction. */
export function scrubEvent(event) {
  if (!event || typeof event !== 'object') return event;
  if (event.request && typeof event.request === 'object') {
    const { method, url } = event.request;
    event.request = {};
    if (method) event.request.method = method;
    if (url) event.request.url = stripQuery(url);
  }
  for (const key of ['message', 'logentry', 'exception', 'breadcrumbs', 'extra', 'tags', 'contexts']) {
    if (key in event) event[key] = scrubValues(event[key]);
  }
  if (typeof event.transaction === 'string') event.transaction = stripQuery(event.transaction);
  delete event.user;
  return event;
}

/** beforeBreadcrumb: no query strings in URLs, no addresses in messages. */
export function scrubBreadcrumb(crumb) {
  if (!crumb || typeof crumb !== 'object') return crumb;
  if (crumb.data && typeof crumb.data === 'object') {
    const data = { ...crumb.data };
    if ('url' in data) data.url = stripQuery(data.url);
    delete data['http.query'];
    delete data['http.fragment'];
    crumb.data = scrubValues(data);
  }
  if ('message' in crumb) crumb.message = scrubText(crumb.message);
  return crumb;
}
