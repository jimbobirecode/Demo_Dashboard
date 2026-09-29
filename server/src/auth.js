import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from './db.js';
import { getUserColumns } from './lib/schema.js';

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
  const token = jwt.sign(
    {
      sub: String(user.id),
      username: user.username,
      customerId: user.customer_id,
      fullName: user.full_name,
      // An install that has not run migration_add_user_management.sql has no
      // roles, and every account there can already do everything — so the
      // absent column reads as 'admin' rather than locking the page away.
      role: user.role ?? 'admin',
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL },
  );

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

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // A tour operator portal session is signed with the same key but is never
    // a staff session, whatever cookie it arrives in.
    if (req.user.kind === 'operator' || !req.user.customerId) throw new Error('not a staff session');
    next();
  } catch {
    res.status(401).json({ error: 'Session expired' });
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
 * Mirrors the Streamlit login: a first-time user signs in with the plaintext
 * temp password and is then forced to set a permanent bcrypt-hashed one.
 */
/**
 * Sign in by email address.
 *
 * The username is still accepted as a fallback, deliberately. Accounts created
 * before this dashboard had an `email` column have nothing else to sign in
 * with, and an install that switched to addresses cleanly would lock those
 * people out of the system that was meant to serve them. Both are matched
 * case-insensitively, because nobody types their own address the same way
 * twice.
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
    if (timingSafeEqual(password, user.temp_password)) {
      return { user, mustChangePassword: true };
    }
  }

  if (user.password_hash && (await bcrypt.compare(password, user.password_hash))) {
    return { user, mustChangePassword: false };
  }

  return null;
}

export async function setPermanentPassword(userId, newPassword) {
  const columns = await getUserColumns();
  const hash = await bcrypt.hash(newPassword, 12);

  const sets = ['password_hash = $1'];
  if (columns.has('temp_password')) sets.push('temp_password = NULL');
  if (columns.has('must_change_password')) sets.push('must_change_password = FALSE');
  if (columns.has('last_login')) sets.push('last_login = NOW()');

  await query(
    `UPDATE public.dashboard_users SET ${sets.join(', ')} WHERE id = $2`,
    [hash, userId],
  );
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
