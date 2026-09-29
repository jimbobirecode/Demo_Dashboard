/**
 * Self-service password reset: the rules, none of the plumbing.
 *
 * Pure functions over plain values, so every decision that matters — who a
 * link may be sent to, how long it lives, what counts as a usable password,
 * and what the browser is allowed to be told — is unit-tested without a
 * database or an API key. `routes/auth.js` does the storing and the sending.
 *
 * Two rules run through all of it:
 *
 *  1. The response to "I forgot my password" never reveals whether the account
 *     exists. Anyone can hit that endpoint, and a distinguishable answer turns
 *     it into a list of every valid username.
 *  2. The token is a secret the database never holds. Only its SHA-256 is
 *     stored, so a leaked table cannot be replayed into an account takeover.
 */
import crypto from 'node:crypto';
import { brandTemplateData } from './email-layout.js';
import { BRAND, appBaseUrl } from './brand.js';

/** How long an emailed link stays usable, unless the environment says otherwise. */
export const DEFAULT_TTL_MINUTES = 60;

/**
 * The two reasons this dashboard emails somebody a one-time link.
 *
 * They are the same object — a hashed token with an expiry — so they share one
 * table and one redemption path. What differs is who was expecting the email
 * and therefore how long the link may live: a reset was asked for seconds ago,
 * an invitation lands on somebody who did not know it was coming and may be
 * away for a few days.
 */
export const TOKEN_PURPOSES = {
  reset: {
    id: 'reset',
    defaultTtlMinutes: 60,
    ttlEnv: 'PASSWORD_RESET_TTL_MINUTES',
    templateEnv: 'SENDGRID_TEMPLATE_PASSWORD_RESET',
  },
  invite: {
    id: 'invite',
    defaultTtlMinutes: 7 * 24 * 60,
    ttlEnv: 'USER_INVITE_TTL_MINUTES',
    templateEnv: 'SENDGRID_TEMPLATE_USER_INVITE',
  },
};

export const PURPOSES = Object.keys(TOKEN_PURPOSES);

/** The shortest password the dashboard accepts, matching the change-password screen. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * What a reset request is told, whatever actually happened. The wording is
 * deliberately the same for an unknown username, a known one with no address
 * on file and a link that really went out.
 */
export const NEUTRAL_REPLY =
  'If that account exists and has an email address on file, a reset link is on its way.';

/** Reset email settings, with the SendGrid key reduced to a yes/no. */
export function readResetConfig(env = process.env) {
  const missing = [];
  if (!env.SENDGRID_API_KEY) missing.push('SENDGRID_API_KEY');
  if (!env.FROM_EMAIL) missing.push('FROM_EMAIL');
  if (!env.SENDGRID_TEMPLATE_PASSWORD_RESET) missing.push('SENDGRID_TEMPLATE_PASSWORD_RESET');
  // Links are built on appBaseUrl(): APP_URL, or the TeeMail dashboard.
  const complete = missing;

  // Each purpose has its own template and its own life. The invitation
  // template is optional: an install that never creates accounts by email does
  // not need one, and the Users page says so rather than failing to send.
  const purposes = {};
  for (const purpose of Object.values(TOKEN_PURPOSES)) {
    purposes[purpose.id] = {
      id: purpose.id,
      templateId: env[purpose.templateEnv] ?? null,
      templateEnv: purpose.templateEnv,
      configured: Boolean(env[purpose.templateEnv]),
      ttlMinutes: positiveInt(env[purpose.ttlEnv], purpose.defaultTtlMinutes),
    };
  }

  return {
    hasApiKey: Boolean(env.SENDGRID_API_KEY),
    apiKey: env.SENDGRID_API_KEY ?? null,
    fromEmail: env.FROM_EMAIL ?? null,
    fromName: env.FROM_NAME ?? BRAND.fromName,
    purposes,
    templateId: env.SENDGRID_TEMPLATE_PASSWORD_RESET ?? null,
    // Where the link points: APP_URL, or https://democlub.teemail.io.
    appUrl: appBaseUrl(env),
    ttlMinutes: positiveInt(env.PASSWORD_RESET_TTL_MINUTES, DEFAULT_TTL_MINUTES),
    missing: complete,
    configured: complete.length === 0,
  };
}

/** Strips the API key, for anything that crosses the wire. */
export function publicResetConfig(config, { migrated = true } = {}) {
  const { apiKey, ...rest } = config;
  return {
    ...rest,
    migrated,
    // The login screen only offers the link when a click could actually
    // produce an email; otherwise it says what an administrator has to do.
    available: migrated && config.missing.length === 0,
  };
}

/**
 * A fresh token and the row that will remember it.
 *
 * 32 bytes of CSPRNG is well past guessing range, and base64url survives being
 * pasted out of an email client without escaping.
 */
export function mintToken({ ttlMinutes = DEFAULT_TTL_MINUTES, now = new Date() } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
  };
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** The link the email carries. */
export function resetLink(appUrl, token, purpose = 'reset') {
  // An invitation gets its own path so the address bar agrees with the email
  // that sent it — somebody accepting an invitation has no password to reset.
  // Both paths render the same screen and redeem the same token; the page
  // reads the purpose from the token, not from the URL.
  const path = purpose === 'invite' ? '/accept-invite' : '/reset-password';
  return `${trimSlash(appUrl)}${path}?token=${encodeURIComponent(token)}`;
}

/**
 * Where a reset link for this account should go.
 *
 * The `email` column is the answer where an install has run the migration and
 * filled it in. Failing that, a username that is itself an address is a
 * perfectly good one — that is how most of these accounts are actually named.
 * Anything else has nowhere to send to, which is not an error the requester is
 * told about.
 */
export function resolveResetEmail(user) {
  const stored = cleanAddress(user?.email);
  if (stored) return stored;

  const username = cleanAddress(user?.username);
  return username ?? null;
}

/** A plausible address, lowercased and trimmed, or null. */
export function cleanAddress(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
}

/**
 * `j***@example.com` — enough for the reader to recognise their own address
 * without the page disclosing one they do not already know.
 */
export function maskAddress(address) {
  const clean = cleanAddress(address);
  if (!clean) return null;

  const [local, domain] = clean.split('@');
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/** The dynamic-template data the reset email is rendered from. */
export function buildResetTemplateData({
  user,
  link,
  ttlMinutes,
  clubName,
  fromEmail,
  purpose = 'reset',
  invitedBy = null,
  role = null,
  toEmail = null,
}) {
  const club = clubName ?? BRAND.fullName;
  const inviting = purpose === 'invite';

  return {
    // Logo, colours and contact details, so the SendGrid template can carry
    // the same branding as the emails the dashboard builds itself.
    ...brandTemplateData(),
    purpose,
    subject: inviting
      ? `You have been given access to the ${club} dashboard`
      : `Reset your ${club} dashboard password`,
    // An invitation has to say what the link is for and who sent it; somebody
    // who was not expecting the email has no other way to tell it apart from
    // a phishing attempt.
    headline: inviting ? 'Set your password' : 'Reset your password',
    invited_by: invitedBy,
    // The same value under the name an invitation template naturally reaches
    // for. Templates are written by hand, against whichever spelling reads
    // best; sending both costs nothing and saves a broken email.
    inviter_name: invitedBy,
    first_name: firstName(user),
    full_name: user?.full_name ?? user?.fullName ?? user?.username ?? '',
    username: user?.username ?? '',
    club_name: club,
    reset_url: link,
    // Every spelling a template might use for the one thing that must never be
    // empty. A link is the entire point of these emails: a template reaching
    // for a name nothing supplies renders a button that goes nowhere, and the
    // reader has no way to tell that from a broken account.
    reset_link: link,
    invite_url: link,
    invite_link: link,
    action_url: link,
    url: link,
    // Who the account is for. `email` is where it went, `role` what it grants.
    email: toEmail ?? user?.email ?? null,
    role: role ? ROLE_LABELS[role] ?? role : null,
    expires_in_minutes: ttlMinutes,
    expires_in: describeMinutes(ttlMinutes),
    support_email: fromEmail ?? null,
  };
}

/**
 * Whether a stored reset row may still be redeemed. Kept here so the route
 * cannot accidentally accept a used or expired one by forgetting a clause.
 */
export function resetRowUsable(row, now = new Date()) {
  if (!row) return { ok: false, reason: 'This reset link is not valid. Request a new one.' };
  if (row.used_at) return { ok: false, reason: 'This reset link has already been used. Request a new one.' };
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: 'This reset link has expired. Request a new one.' };
  }
  return { ok: true };
}

/** The same rule the change-password screen enforces, in one place. */
export function validatePassword(password, confirm) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (confirm !== undefined && password !== confirm) {
    return { ok: false, reason: 'Passwords do not match' };
  }
  return { ok: true };
}

/**
 * A crude per-key throttle, in memory.
 *
 * It exists so one script cannot mail a user hundreds of links, not to survive
 * a restart or to coordinate across instances — a real rate limiter belongs in
 * front of the app. Keys are dropped as they expire, so the map does not grow
 * without bound.
 */
export function createThrottle({ limit = 5, windowMs = 15 * 60_000 } = {}) {
  const hits = new Map();

  return {
    /** True when this key may proceed; the call itself counts as an attempt. */
    check(key, now = Date.now()) {
      const recent = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
      recent.push(now);
      hits.set(key, recent);

      for (const [other, times] of hits) {
        if (!times.some((time) => now - time < windowMs)) hits.delete(other);
      }
      return recent.length <= limit;
    },
    reset() {
      hits.clear();
    },
  };
}

/** '45 minutes', '1 hour', '7 days' — an invitation lives too long to read in hours. */
export function describeMinutes(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '0 minutes';
  if (value % 1440 === 0) return plural(value / 1440, 'day');
  if (value % 60 === 0) return plural(value / 60, 'hour');
  return plural(value, 'minute');
}

/** How a role is spelled to somebody who does not work on the dashboard. */
const ROLE_LABELS = { admin: 'Administrator', staff: 'Staff' };

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function firstName(user) {
  const full = String(user?.full_name ?? user?.fullName ?? '').trim();
  if (full) return full.split(/\s+/)[0];
  return String(user?.username ?? '').split('@')[0];
}

function trimSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
