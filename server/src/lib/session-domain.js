/**
 * Staff sessions: what a signed cookie has to agree with in the database
 * before it counts.
 *
 * The cookie is still a signed JWT, but it is no longer trusted on its own.
 * Every request is checked against the account it names (see requireAuth in
 * auth.js), so deactivating somebody, changing their role, resetting their
 * password or signing them out takes effect at once rather than when a
 * 12-hour token happens to expire. The token's `sv` claim is the account's
 * `session_version` when it was issued; bumping the column ends every session
 * issued before.
 *
 * Pure functions, so every rule is unit-tested without a database.
 */

/**
 * Routes a temporary-password session may use. Everything else answers 403
 * until a permanent password is set — a temp password is a way to *choose* a
 * password, not a way into the bookings.
 */
export const PASSWORD_CHANGE_PATHS = ['/api/auth/me', '/api/auth/change-password', '/api/auth/logout'];

export function allowedDuringPasswordChange(path) {
  const clean = String(path ?? '')
    .split('?')[0]
    .replace(/\/+$/, '');
  return PASSWORD_CHANGE_PATHS.includes(clean);
}

/** bcrypt's own format: $2a$, $2b$ or $2y$, a cost, then 53 characters. */
export function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

/** The claims a session token carries. Identity only; authority is re-read. */
export function sessionClaims(user) {
  return {
    sub: String(user.id),
    username: user.username,
    customerId: user.customer_id,
    fullName: user.full_name,
    // role is NOT NULL in the schema; a missing value fails closed.
    role: user.role ?? 'staff',
    sv: Number(user.session_version ?? 0),
  };
}

/**
 * Whether a verified token still names a usable account, and who that account
 * is *now*.
 *
 * `row` is the account as the database holds it (null when it has been
 * deleted). The token's `sv` must match the row's session_version, so bumping
 * the column ends every session issued before.
 *
 * Role and club come from the row, never from the token, so a demoted admin
 * is a member of staff on their very next request.
 */
export function evaluateSession(claims, row) {
  if (!row) return { ok: false, reason: 'account no longer exists' };
  if (row.is_active === false) return { ok: false, reason: 'account deactivated' };
  if (!row.customer_id) return { ok: false, reason: 'account has no club' };
  if (Number(claims?.sv ?? 0) !== Number(row.session_version ?? 0)) {
    return { ok: false, reason: 'session revoked' };
  }

  return {
    ok: true,
    user: {
      sub: String(row.id),
      username: row.username,
      customerId: row.customer_id,
      fullName: row.full_name,
      role: row.role ?? 'staff',
      mustChangePassword: Boolean(row.must_change_password),
    },
  };
}

/**
 * Which account changes end the sessions the account already has.
 *
 * Losing access or a role must take effect immediately; a new name or address
 * changes nothing anybody could abuse, so it does not sign them out.
 */
export function patchRevokesSessions(patch) {
  return patch?.is_active === false || patch?.role !== undefined;
}
