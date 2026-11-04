/**
 * The audit trail: who changed what, when, and from where.
 *
 * Every state-changing request writes one row. Not a list of calls somebody
 * remembered to instrument — a middleware over the whole API, so a route
 * added next year is covered the day it is written. The alternative, a
 * `recordAudit()` call per handler, is the kind of thing that is complete on
 * the day it ships and has three holes in it a year later, and the holes are
 * never in the routes anybody thought about.
 *
 * Everything here but `recordAudit` is pure, so what gets written — and more
 * importantly what gets redacted — is tested without a database.
 */
import { query } from '../db.js';
import { clientIp } from './request-guard.js';
import { logger } from './logger.js';

const log = logger.child('audit');

/** How long a row is kept. Beyond this it is personal data with no purpose. */
export const RETENTION_DAYS = 365;

/**
 * Keys whose values never reach the table, at any depth.
 *
 * Matched on the lowercased key containing one of these, so `password`,
 * `newPassword`, `password_confirmation` and `apiKey` are all caught without
 * a list of every spelling. A redacted value is replaced rather than dropped,
 * so the log still shows that a password WAS sent — which is the audit-worthy
 * fact — without storing it.
 */
export const REDACTED = ['password', 'token', 'secret', 'apikey', 'api_key', 'authorization', 'cookie', 'signature'];

/** Request bodies that are not worth keeping: big, or not a change at all. */
const SKIPPED_PATHS = [
  // Renders what an email would look like; writes nothing.
  '/api/inbox/preview',
  // A tee-sheet upload arrives base64-encoded and is megabytes long. The
  // import itself is still logged — just not the spreadsheet inside it.
  '/api/imports/preview',
];

export const SKIPPED = SKIPPED_PATHS;

/** Deep-copy a request body with every secret replaced. */
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redact(entry, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = REDACTED.some((needle) => key.toLowerCase().includes(needle))
        ? '[redacted]'
        : redact(inner, depth + 1);
    }
    return out;
  }
  // A long free-text field (an email body, a note) is kept to a readable
  // length: the audit trail records that it was sent, not a second copy of it.
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

/**
 * The dotted action name for a request, from its path.
 *
 * `/api/bookings/BOOK-1/payment` + PATCH -> `booking.payment.update`. Ids are
 * dropped from the name and kept in `entity_id`, so every edit of every
 * booking groups under one action on the screen.
 */
export function describeAction(method, path) {
  const parts = String(path ?? '')
    .split('?')[0]
    .split('/')
    .filter(Boolean)
    .filter((part) => part !== 'api');
  if (!parts.length) return { action: 'unknown', entityType: null, entityId: null };

  const [head, ...rest] = parts;
  const entityType = SINGULAR[head] ?? head;
  // The first segment that looks like an id rather than a name.
  const entityId = rest.find((part) => IS_ID(part)) ?? null;
  const words = rest.filter((part) => !IS_ID(part));
  const verb = VERBS[method] ?? method.toLowerCase();
  const derived = [entityType, ...words, verb].join('.');
  return { action: ALIASES[derived] ?? derived, entityType, entityId };
}

/**
 * Names the path does not produce well on its own.
 *
 * Deriving from the URL covers every route for free, including ones not
 * written yet; these are the dozen where the derived name is clumsy enough
 * to be worth saying properly, because they are the ones an auditor reads
 * first. Anything missing here still gets logged, just under its derived
 * name — never dropped.
 */
const ALIASES = {
  'auth.login.create': 'auth.login',
  'auth.logout.create': 'auth.logout',
  'auth.change-password.create': 'auth.password.change',
  'auth.forgot-password.create': 'auth.password.forgot',
  'auth.reset-password.create': 'auth.password.reset',
  'auth.reset-password.check.create': 'auth.password.reset.check',
  'payment.bookings.link.create': 'payment.link.send',
  'payment.bookings.receipt.create': 'payment.receipt.send',
  'payment.bookings.check.create': 'payment.check',
  'payment.sync.create': 'payment.sync',
  'inbox.reply.create': 'inbox.reply',
  'inbox.restore.create': 'inbox.restore',
  'inbox.notes.create': 'inbox.note.add',
  'inbox.booking.send.create': 'inbox.email.send',
  'operator.assign.create': 'operator.bookings.assign',
  'reminder.send.create': 'reminder.send',
  'import.commit.create': 'import.commit',
  'change_request.request.create': 'change_request.raise',
  'change_request.approve.create': 'change_request.approve',
  'change_request.decline.create': 'change_request.decline',
  'membership.applications.status.update': 'membership.application.decide',
  'membership.applications.notes.create': 'membership.application.note.add',
  'booking.status.update': 'booking.status.change',
};

const SINGULAR = {
  bookings: 'booking',
  operators: 'operator',
  users: 'user',
  payments: 'payment',
  changes: 'change_request',
  imports: 'import',
  membership: 'membership',
  waitlist: 'waitlist',
  emails: 'email',
};

const VERBS = { POST: 'create', PATCH: 'update', PUT: 'update', DELETE: 'delete' };

/**
 * Whether a path segment names one record rather than a kind of action.
 *
 * Anything with a digit in it: a number, a booking reference
 * (BOOK-20260910-973406B3), a uuid, a batch id. No route word in this API
 * carries a digit — they are words like `status`, `applications`,
 * `reset-password` — so this needs no list to keep up to date. An email
 * address is an id too; the portal and the users routes take them.
 */
const IS_ID = (part) => /\d/.test(part) || /^[^@\s]+@[^@\s]+$/.test(part);

/** Which of 'applied', 'refused' or 'failed' an HTTP status means. */
export function outcomeFor(status) {
  if (status >= 200 && status < 400) return 'applied';
  if (status >= 500) return 'failed';
  return 'refused';
}

/**
 * One row, built from a finished request. Pure: the middleware hands it the
 * pieces and this decides what is worth keeping.
 */
export function auditEntry({ req, status, club, actor, actorKind = 'staff', actorRole = null, ip = null }) {
  const { action, entityType, entityId } = describeAction(req.method, req.originalUrl ?? req.url ?? '');
  const body = SKIPPED.some((skip) => (req.originalUrl ?? '').startsWith(skip)) ? { skipped: true } : redact(req.body);
  return {
    club,
    actor: actor ?? null,
    actor_kind: actorKind,
    actor_role: actorRole,
    action,
    entity_type: entityType,
    entity_id: entityId ?? null,
    outcome: outcomeFor(status),
    status,
    method: req.method,
    path: String(req.originalUrl ?? req.url ?? '').split('?')[0],
    details: body && Object.keys(body).length ? body : null,
    ip,
    user_agent: String(req.get?.('user-agent') ?? '').slice(0, 300) || null,
  };
}

/**
 * The middleware. One row per finished state-changing request.
 *
 * It records on `finish`, so the status is known and nothing is written for
 * a request that never reached a handler. Reads are not logged: this is a
 * record of changes, and logging every GET would bury them.
 *
 * Mounted BEFORE the routers, so the listener is attached whatever the route
 * does — but the actor is read inside the listener, which runs after the
 * response, by which time the route's own guard has filled in `req.user` (or
 * `req.portal`). Reading it at mount time would record every change as
 * nobody.
 */
export function auditWrites({ clubOf = (req) => req.user?.customerId ?? req.portal?.club ?? null } = {}) {
  return (req, res, next) => {
    if (!WRITE_METHODS.has(req.method)) return next();
    res.on('finish', () => {
      // A route that knows better says so on `req.audit`. Sign-in is the
      // case that needs it: the session is issued in the response, so at
      // this point there is no `req.user` to read, and a sign-in is the
      // first thing an auditor looks for.
      const club = req.audit?.club ?? clubOf(req);
      // No club means nobody signed in and nothing was changed — a probe at
      // a closed door, already covered by the throttle's own logging.
      if (!club) return;
      const actor = req.audit?.actor ?? req.user?.username ?? req.portal?.email ?? null;
      const actorKind = req.audit?.actorKind ?? (req.user ? 'staff' : req.portal ? 'operator' : 'system');
      recordAudit(
        auditEntry({
          req,
          status: res.statusCode,
          club,
          actor,
          actorKind,
          actorRole: req.audit?.actorRole ?? req.user?.role ?? null,
          ip: clientIp(req),
        }),
      );
    });
    next();
  };
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Write one row.
 *
 * Never throws and never fails the request that caused it. A club whose
 * booking edit was refused because the audit table was unreachable would be a
 * worse outcome than a gap in the trail — but the gap is shouted about in the
 * log rather than passed over in silence.
 */
export async function recordAudit(entry) {
  try {
    const columns = Object.keys(entry);
    const values = columns.map((name) => entry[name]);
    await query(
      `INSERT INTO public.audit_log (${columns.join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      values,
    );
  } catch (err) {
    log.error(`could not write the audit trail for ${entry.action}: ${err.message}`);
  }
}

/** Delete what is past the retention period. Returns how many went. */
export async function purgeAudit({ days = RETENTION_DAYS } = {}) {
  const { rowCount } = await query(`DELETE FROM public.audit_log WHERE at < NOW() - ($1 || ' days')::interval`, [days]);
  return rowCount;
}

/**
 * Run the purge daily. Started at boot beside the other sweeps; the first run
 * is a minute in, so a restart loop cannot turn it into a hot loop.
 */
export function startAuditPurge({ days = RETENTION_DAYS } = {}) {
  const run = () =>
    purgeAudit({ days })
      .then((gone) => gone && log.info(`purged ${gone} audit row(s) older than ${days} days`))
      .catch((err) => log.warn(`audit purge failed: ${err.message}`));
  const first = setTimeout(run, 60_000);
  const every = setInterval(run, 24 * 60 * 60_000);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
