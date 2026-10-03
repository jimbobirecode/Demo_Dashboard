/**
 * Dashboard accounts: who exists, what they may do, and what a valid one looks
 * like.
 *
 * Pure functions over plain rows, so every rule that matters — who may manage
 * accounts, what a username has to be, which fields a request is allowed to
 * set, and what the browser is allowed to see — is unit-tested without a
 * database. `routes/users.js` does the storing and the emailing.
 *
 * The account model is deliberately small. Two roles, because the only
 * distinction the club actually makes is "can this person add and remove
 * logins". Anything finer would be a permission system nobody asked for.
 */
import { cleanAddress } from './password-reset-domain.js';

/** 'admin' may manage accounts; 'staff' may do everything else. */
export const ROLES = ['admin', 'staff'];
export const DEFAULT_ROLE = 'staff';

export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 64;

/** An account that has never signed in and has no password of its own. */
export function isPending(user) {
  return !user?.password_hash && !user?.temp_password;
}

export function normaliseRole(role) {
  const text = String(role ?? '')
    .trim()
    .toLowerCase();
  return ROLES.includes(text) ? text : DEFAULT_ROLE;
}

export function isAdmin(user) {
  return normaliseRole(user?.role) === 'admin';
}

/**
 * A `dashboard_users` row as the SPA wants it.
 *
 * Never carries `password_hash` or `temp_password`: this shape crosses the
 * wire, and a hash is still a secret — it is exactly what an offline cracker
 * wants. The states a screen needs are derived here instead.
 */
export function serialiseUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email ?? null,
    fullName: row.full_name ?? '',
    role: normaliseRole(row.role),
    club: row.customer_id ?? null,
    active: row.is_active !== false,
    mustChangePassword: Boolean(row.must_change_password),
    pending: isPending(row),
    invitedAt: iso(row.invited_at),
    lastLogin: iso(row.last_login),
    createdAt: iso(row.created_at),
    createdBy: row.created_by ?? null,
  };
}

/**
 * Check a new account before it reaches the database.
 *
 * Returns `{ ok, value, errors }` rather than throwing, so a form can show
 * every problem at once instead of one per round trip.
 */
export function validateNewUser(input, { requireEmail = true } = {}) {
  const errors = [];

  const supplied = String(input?.email ?? '').trim();
  const address = cleanAddress(supplied);

  // People sign in with their address, so that is the login. A username is
  // only carried separately for installs that already had one, and for the
  // audit columns that record who changed what.
  const typed = String(input?.username ?? '')
    .trim()
    .toLowerCase();
  const username = typed || address || '';

  // A derived username is only ever as good as the address it came from, so a
  // bad address must not also be reported as a bad username — the reader would
  // be left correcting a field the form no longer shows them.
  if (!typed && !address) {
    // The email error below is the whole story.
  } else if (username.length < MIN_USERNAME_LENGTH) {
    errors.push(`Username must be at least ${MIN_USERNAME_LENGTH} characters`);
  } else if (username.length > MAX_USERNAME_LENGTH) {
    errors.push(`Username must be ${MAX_USERNAME_LENGTH} characters or fewer`);
  } else if (!/^[a-z0-9._@+-]+$/.test(username)) {
    errors.push('Username may use letters, numbers and . _ @ + - only');
  }

  // An address is how the invitation reaches them. Without one the account
  // could only ever be given a password by hand, which is the practice this
  // screen exists to replace.
  const email = address ?? (cleanAddress(username) ? username : null);
  if (supplied && !address) {
    // Say what is wrong with what they typed, rather than that something is
    // missing — they can see perfectly well that they filled the field in.
    errors.push('That email address does not look valid');
  } else if (requireEmail && !email) {
    errors.push('A valid email address is required to send the invitation');
  }

  const fullName = String(input?.fullName ?? '').trim();
  if (!fullName) errors.push('Full name is required');

  const role = normaliseRole(input?.role);
  if (input?.role && !ROLES.includes(String(input.role).trim().toLowerCase())) {
    errors.push(`Role must be one of ${ROLES.join(', ')}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    value: { username, email, fullName, role },
  };
}

/** The fields an edit may touch, and what they have to look like. */
export function validateUserPatch(input) {
  const errors = [];
  const patch = {};

  if (input?.fullName !== undefined) {
    const fullName = String(input.fullName).trim();
    if (!fullName) errors.push('Full name cannot be empty');
    else patch.full_name = fullName;
  }

  if (input?.email !== undefined) {
    if (input.email === null || input.email === '') {
      patch.email = null;
    } else {
      const email = cleanAddress(input.email);
      if (!email) errors.push('That email address does not look valid');
      else patch.email = email;
    }
  }

  if (input?.role !== undefined) {
    const role = String(input.role).trim().toLowerCase();
    if (!ROLES.includes(role)) errors.push(`Role must be one of ${ROLES.join(', ')}`);
    else patch.role = role;
  }

  if (input?.active !== undefined) patch.is_active = Boolean(input.active);

  if (!errors.length && !Object.keys(patch).length) errors.push('Nothing to change');

  return { ok: errors.length === 0, errors, patch };
}

/**
 * Whether an administrator may make this change to this account.
 *
 * The rules exist to stop the club locking itself out, which is the only way
 * this screen can do real damage:
 *
 *  - nobody may remove their own admin rights or deactivate themselves, since
 *    the undo for that is a database console;
 *  - the last remaining active admin may not be demoted, deactivated or
 *    deleted by anybody, including a second admin acting at the same time.
 */
export function guardSelfLockout(actor, target, patch, { activeAdmins }) {
  const isSelf = Number(actor?.id) === Number(target?.id);
  const losesAdmin = patch.role !== undefined && patch.role !== 'admin' && isAdmin(target);
  const losesAccess = patch.is_active === false;

  if (isSelf && losesAdmin) {
    return { ok: false, reason: 'You cannot remove your own administrator access' };
  }
  if (isSelf && losesAccess) {
    return { ok: false, reason: 'You cannot deactivate your own account' };
  }
  if ((losesAdmin || losesAccess) && isAdmin(target) && target.is_active !== false && activeAdmins <= 1) {
    return { ok: false, reason: 'This is the last active administrator — promote somebody else first' };
  }
  return { ok: true };
}

/** The same rule for deletion, which is simply the harshest edit. */
export function guardDelete(actor, target, { activeAdmins }) {
  if (Number(actor?.id) === Number(target?.id)) {
    return { ok: false, reason: 'You cannot delete your own account' };
  }
  if (isAdmin(target) && target.is_active !== false && activeAdmins <= 1) {
    return { ok: false, reason: 'This is the last active administrator — promote somebody else first' };
  }
  return { ok: true };
}

/**
 * An UPDATE's SET clause from a validated patch, with the values in the order
 * the placeholders expect. Keeps the route from hand-building SQL per field.
 */
export function buildUserUpdate(patch, startIndex = 1) {
  const clauses = [];
  const values = [];

  for (const [column, value] of Object.entries(patch)) {
    values.push(value);
    clauses.push(`"${column}" = $${startIndex + values.length - 1}`);
  }

  return { clauses, values };
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
