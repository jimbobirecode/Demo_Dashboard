import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from './db.js';
import { getUserColumns } from './lib/schema.js';
import {
  allowedDuringPasswordChange,
  evaluateSession,
  isBcryptHash,
  sessionClaims,
} from './lib/session-domain.js';

// Renaming this signs everybody out once: a browser holding the old cookie is
// simply not sent the new one, and the next request reads as unauthenticated.
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'teemail_session';
const TOKEN_TTL = '12h';

// A generated secret keeps dev working, but every instance would then sign with
// a different key — so a multi-instance deploy must supply its own.
export const JWT_SECRET =
  process.env.JWT_SECRET ?? crypto.randomBytes(32).toString('hex');

if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set — using an ephemeral secret; sessions drop on restart.');
}

export function issueSession(res, user) {
  const token = jwt.sign(sessionClaims(user), JWT_SECRET, { expiresIn: TOKEN_TTL });

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE_NAME);
}

/** The claims in the request's session cookie, verified, or null. */
export function readSessionClaims(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    return claims.kind === 'operator' ? null : claims;
  } catch {
    return null;
  }
}

/**
 * The account behind a session, briefly cached.
 *
 * A database round trip on every request is affordable but pointless when a
 * page fires six at once, so a row is kept for SESSION_CACHE_MS. Anything
 * that changes what a session may do (see bumpSessionVersion) drops the entry
 * on this instance immediately; another instance would notice within the TTL.
 */
const SESSION_CACHE_MS = 20_000;
const sessionCache = new Map();

export function forgetSessionUser(userId) {
  sessionCache.delete(Number(userId));
}

async function loadSessionUser(userId) {
  const id = Number(userId);
  const hit = sessionCache.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const columns = await getUserColumns();
  const { rows } = await query(
    `SELECT ${columns.selectList} FROM public.dashboard_users WHERE id = $1`,
    [id],
  );
  const value = { row: rows[0] ?? null, hasVersion: columns.has('session_version') };
  sessionCache.set(id, { value, expiresAt: Date.now() + SESSION_CACHE_MS });

  // Expired entries go when they are next looked at; this keeps an idle
  // account from sitting in memory for the life of the process.
  if (sessionCache.size > 500) {
    for (const [key, entry] of sessionCache) if (entry.expiresAt <= Date.now()) sessionCache.delete(key);
  }
  return value;
}

/**
 * End every session an account holds, everywhere.
 *
 * An install without the session_version column cannot do this — its tokens
 * carry no version to compare — so it only drops the cache, and requireAuth
 * still catches deactivation and deletion from the row itself.
 */
export async function bumpSessionVersion(userId) {
  const columns = await getUserColumns();
  if (columns.has('session_version')) {
    await query(
      'UPDATE public.dashboard_users SET session_version = session_version + 1 WHERE id = $1',
      [Number(userId)],
    );
  }
  forgetSessionUser(userId);
}

export async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  let claims;
  try {
    claims = jwt.verify(token, JWT_SECRET);
    // A tour operator portal session is signed with the same key but is never
    // a staff session, whatever cookie it arrives in.
    if (claims.kind === 'operator' || !claims.customerId || !claims.sub) throw new Error('not a staff session');
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }

  try {
    const { row, hasVersion } = await loadSessionUser(claims.sub);
    const verdict = evaluateSession(claims, row, { hasVersion });
    if (!verdict.ok) {
      clearSession(res);
      return res.status(401).json({ error: 'Session expired' });
    }

    req.user = verdict.user;
    if (req.user.mustChangePassword && !allowedDuringPasswordChange(req.baseUrl + req.path)) {
      return res.status(403).json({
        error: 'Set a permanent password before continuing',
        mustChangePassword: true,
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Account administration only. Sits after requireAuth, never instead of it.
 *
 * The 403 deliberately does not say whether the thing being asked for exists:
 * a staff account probing for user ids should learn nothing from the answer.
 */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access is required' });
  }
  next();
}

/**
 * Sign in by email address.
 *
 * The username is still accepted as a fallback, deliberately. Accounts created
 * before this dashboard had an `email` column have nothing else to sign in
 * with, and an install that switched to addresses cleanly would lock those
 * people out of the system that was meant to serve them. Both are matched
 * case-insensitively, because nobody types their own address the same way
 * twice.
 *
 * A first-time account from the Streamlit era may carry a temporary password
 * and must_change_password; it signs in with that and is then held on the
 * change-password screen (requireAuth refuses everything else) until it sets
 * a permanent one.
 */
export async function authenticateUser(identifier, password) {
  const columns = await getUserColumns();
  const byEmail = columns.has('email') ? ' OR LOWER(email) = LOWER($1)' : '';

  const { rows } = await query(
    `SELECT ${columns.selectList} FROM public.dashboard_users
      WHERE LOWER(username) = LOWER($1)${byEmail}
      ORDER BY (LOWER(username) = LOWER($1)) DESC, id
      LIMIT 1`,
    [String(identifier ?? '').trim()],
  );

  const user = rows[0];
  if (!user) return null;
  // An install without an is_active column treats every account as active.
  if (columns.has('is_active') && !user.is_active) return null;

  if (user.must_change_password && user.temp_password) {
    if (await matchesTempPassword(user, password)) {
      return { user, mustChangePassword: true };
    }
  }

  if (user.password_hash && (await bcrypt.compare(String(password), user.password_hash))) {
    return { user, mustChangePassword: false };
  }

  return null;
}

/**
 * Temporary passwords are stored as bcrypt hashes. Rows written before that
 * hold plaintext; those still match (in constant time) and are hashed on the
 * spot, and hashLegacyTempPasswords() converts the rest at startup.
 */
async function matchesTempPassword(user, password) {
  if (isBcryptHash(user.temp_password)) {
    return bcrypt.compare(String(password), user.temp_password);
  }
  if (!timingSafeEqual(password, user.temp_password)) return false;

  await query(
    'UPDATE public.dashboard_users SET temp_password = $1 WHERE id = $2',
    [await bcrypt.hash(String(password), 12), user.id],
  ).catch((err) => console.warn('[auth] could not hash a legacy temp password:', err.message));
  return true;
}

/**
 * Hash any temporary password still stored in plaintext. Run once at boot;
 * a database without the column, or without any such rows, costs one query.
 */
export async function hashLegacyTempPasswords() {
  const columns = await getUserColumns();
  if (!columns.has('temp_password')) return 0;

  const { rows } = await query(
    'SELECT id, temp_password FROM public.dashboard_users WHERE temp_password IS NOT NULL',
  );
  let hashed = 0;
  for (const row of rows) {
    if (isBcryptHash(row.temp_password)) continue;
    // Guarded on the old value, so a password changed meanwhile is not undone.
    const { rowCount } = await query(
      'UPDATE public.dashboard_users SET temp_password = $1 WHERE id = $2 AND temp_password = $3',
      [await bcrypt.hash(row.temp_password, 12), row.id, row.temp_password],
    );
    hashed += rowCount;
  }
  return hashed;
}

/** Whether `password` is this account's current one (permanent or temporary). */
export async function verifyCurrentPassword(userId, password) {
  if (typeof password !== 'string' || !password) return false;
  const columns = await getUserColumns();
  const { rows } = await query(
    `SELECT ${columns.selectList} FROM public.dashboard_users WHERE id = $1`,
    [Number(userId)],
  );
  const user = rows[0];
  if (!user) return false;
  if (user.password_hash && (await bcrypt.compare(password, user.password_hash))) return true;
  if (user.must_change_password && user.temp_password) return matchesTempPassword(user, password);
  return false;
}

/**
 * Set a permanent password, and end every session the account had: whoever
 * else was signed in as this person — the reason it is being changed, often —
 * is signed out. The caller re-issues a session if the person changing it
 * should stay in.
 */
export async function setPermanentPassword(userId, newPassword) {
  const columns = await getUserColumns();
  const hash = await bcrypt.hash(newPassword, 12);

  const sets = ['password_hash = $1'];
  if (columns.has('temp_password')) sets.push('temp_password = NULL');
  if (columns.has('must_change_password')) sets.push('must_change_password = FALSE');
  if (columns.has('last_login')) sets.push('last_login = NOW()');
  if (columns.has('session_version')) sets.push('session_version = session_version + 1');

  const { rows } = await query(
    `UPDATE public.dashboard_users SET ${sets.join(', ')} WHERE id = $2
     RETURNING ${columns.selectList}`,
    [hash, userId],
  );
  forgetSessionUser(userId);
  return rows[0] ?? null;
}

export async function updateLastLogin(userId) {
  const columns = await getUserColumns();
  // Older installs have no last_login column; recording it is optional.
  if (!columns.has('last_login')) return;
  await query('UPDATE public.dashboard_users SET last_login = NOW() WHERE id = $1', [userId]);
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
