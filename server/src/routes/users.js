/**
 * Account administration: who can sign in to this club's dashboard.
 *
 * Every route here is admin-only and scoped to the signed-in user's club, so
 * an administrator at one club can neither see nor touch another's logins.
 *
 * A new account is created with **no password at all**. It is emailed a
 * one-time link instead, and the password is set by the person who will use
 * it — so a working credential never travels through an inbox, and an
 * administrator never knows a colleague's password. That link is the same
 * object as a password reset (see lib/password-reset-domain.js), stored in the
 * same table with `purpose = 'invite'` and a longer life.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { bumpSessionVersion, forgetSessionUser, requireAdmin, requireAuth } from '../auth.js';
import { patchRevokesSessions } from '../lib/session-domain.js';
import { clubDisplayName } from '../lib/bookings-domain.js';
import { USER_SELECT } from '../lib/schema.js';
import {
  buildUserUpdate,
  guardDelete,
  guardSelfLockout,
  serialiseUser,
  validateNewUser,
  validateUserPatch,
} from '../lib/users-domain.js';
import { buildResetTemplateData, mintToken, readResetConfig, resetLink } from '../lib/password-reset-domain.js';
import { sendTemplateEmail } from '../lib/sendgrid.js';
import { logger } from '../lib/logger.js';

const log = logger.child('users');

const router = Router();
router.use(requireAuth, requireAdmin);

/**
 * What the Users page needs before it draws anything: whether an invitation
 * could actually be sent.
 */
router.get('/config', async (req, res, next) => {
  try {
    const config = readResetConfig();
    const invite = config.purposes.invite;

    res.json({
      canInvite: config.hasApiKey && Boolean(config.fromEmail) && invite.configured && Boolean(config.appUrl),
      inviteTtlMinutes: invite.ttlMinutes,
      // Shown on the page, so a wrong address is obvious before anyone is invited.
      linkBase: config.appUrl,
      missing: [
        ...(config.hasApiKey ? [] : ['SENDGRID_API_KEY']),
        ...(config.fromEmail ? [] : ['FROM_EMAIL']),
        ...(invite.configured ? [] : [invite.templateEnv]),
        ...(config.appUrl ? [] : ['APP_URL']),
      ],
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await loadClubUsers(req.user.customerId);
    res.json({ users: rows.map(serialiseUser), club: clubDisplayName(req.user.customerId) });
  } catch (err) {
    next(err);
  }
});

/** Create an account and email its invitation. */
router.post('/', async (req, res, next) => {
  try {
    const check = validateNewUser(req.body);
    if (!check.ok) return res.status(400).json({ error: check.errors.join('. ') });

    const { username, email, fullName, role } = check.value;
    const clash = await findClash(username, email);
    if (clash) return res.status(409).json({ error: clash });

    // No password and no temp password: the invitation link is the only way
    // in, and it can only be used once.
    const { rows } = await query(
      `INSERT INTO public.dashboard_users
         (username, email, full_name, customer_id, role, is_active,
          must_change_password, created_by)
       VALUES ($1, $2, $3, $4, $5, TRUE, FALSE, $6)
       RETURNING *`,
      [username, email, fullName, req.user.customerId, role, req.user.username],
    );

    const user = rows[0];
    const invite = await sendInvite(user, req.user);

    res.status(201).json({ user: serialiseUser(user), invite });
  } catch (err) {
    next(err);
  }
});

/** Send the invitation again — a link expired, or the first one never arrived. */
router.post('/:id/invite', async (req, res, next) => {
  try {
    const user = await findClubUser(req.params.id, req.user.customerId);
    if (!user) return res.status(404).json({ error: 'No such account' });

    // A link for a deactivated account is refused at redemption anyway, so
    // sending one only invites somebody to follow a link that will reject
    // them.
    if (user.is_active === false) {
      return res.status(409).json({ error: 'Reactivate this account before inviting again' });
    }

    const invite = await sendInvite(user, req.user);
    if (!invite.sent) return res.status(400).json({ error: invite.message, invite });

    const { rows } = await query('SELECT * FROM public.dashboard_users WHERE id = $1', [user.id]);
    res.json({ user: serialiseUser(rows[0]), invite });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const target = await findClubUser(req.params.id, req.user.customerId);
    if (!target) return res.status(404).json({ error: 'No such account' });

    const check = validateUserPatch(req.body);
    if (!check.ok) return res.status(400).json({ error: check.errors.join('. ') });

    const guard = guardSelfLockout({ id: Number(req.user.sub) }, target, check.patch, {
      activeAdmins: await countActiveAdmins(req.user.customerId),
    });
    if (!guard.ok) return res.status(409).json({ error: guard.reason });

    if (check.patch.email) {
      const clash = await findClash(null, check.patch.email, target.id);
      if (clash) return res.status(409).json({ error: clash });
    }

    const { clauses, values } = buildUserUpdate(check.patch, 1);
    const { rows } = await query(
      `UPDATE public.dashboard_users SET ${clauses.join(', ')}
        WHERE id = $${values.length + 1} AND customer_id = $${values.length + 2}
        RETURNING *`,
      [...values, target.id, req.user.customerId],
    );

    // Losing access or a role ends the sessions the account already has,
    // rather than leaving them to run out their 12 hours.
    if (patchRevokesSessions(check.patch)) await bumpSessionVersion(target.id);

    res.json({ user: serialiseUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const target = await findClubUser(req.params.id, req.user.customerId);
    if (!target) return res.status(404).json({ error: 'No such account' });

    const guard = guardDelete({ id: Number(req.user.sub) }, target, {
      activeAdmins: await countActiveAdmins(req.user.customerId),
    });
    if (!guard.ok) return res.status(409).json({ error: guard.reason });

    // Outstanding links die with the account (ON DELETE CASCADE), so a
    // deleted colleague's invitation cannot be redeemed afterwards.
    await query('DELETE FROM public.dashboard_users WHERE id = $1 AND customer_id = $2', [
      target.id,
      req.user.customerId,
    ]);
    // A session naming a deleted account fails its next check anyway; this
    // makes that immediate rather than when the cached row expires.
    forgetSessionUser(target.id);
    res.json({ ok: true, deleted: serialiseUser(target) });
  } catch (err) {
    next(err);
  }
});

/* ---------- helpers ---------- */

async function loadClubUsers(club) {
  return query(
    `SELECT ${USER_SELECT} FROM public.dashboard_users
      WHERE customer_id = $1 ORDER BY LOWER(username)`,
    [club],
  );
}

async function findClubUser(id, club) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric)) return null;

  const { rows } = await query('SELECT * FROM public.dashboard_users WHERE id = $1 AND customer_id = $2', [
    numeric,
    club,
  ]);
  return rows[0] ?? null;
}

async function countActiveAdmins(club) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM public.dashboard_users
      WHERE customer_id = $1 AND role = 'admin' AND is_active IS NOT FALSE`,
    [club],
  );
  return rows[0]?.count ?? 0;
}

/**
 * A username or address already in use, spelled as a sentence.
 *
 * Checked across every club rather than within one: `username` is unique for
 * the whole table, so a clash with another club's login would otherwise fail
 * as an unhandled constraint violation and a 500.
 */
async function findClash(username, email, excludeId = null) {
  if (username) {
    const { rows } = await query('SELECT id FROM public.dashboard_users WHERE LOWER(username) = LOWER($1)', [username]);
    if (rows.some((row) => row.id !== excludeId)) return 'That username is already taken';
  }

  if (email) {
    const { rows } = await query('SELECT id FROM public.dashboard_users WHERE LOWER(email) = LOWER($1)', [email]);
    if (rows.some((row) => row.id !== excludeId)) {
      return 'An account already uses that email address';
    }
  }
  return null;
}

/**
 * Mint an invitation and email it.
 *
 * Never throws: an account that was created successfully but could not be
 * emailed is a real state the page has to show, not an error that hides the
 * fact the account now exists. The reply says what happened either way.
 */
async function sendInvite(user, actor) {
  const config = readResetConfig();
  const invite = config.purposes.invite;

  if (!config.hasApiKey || !config.fromEmail || !invite.configured || !config.appUrl) {
    const missing = [
      ...(config.hasApiKey ? [] : ['SENDGRID_API_KEY']),
      ...(config.fromEmail ? [] : ['FROM_EMAIL']),
      ...(invite.configured ? [] : [invite.templateEnv]),
      ...(config.appUrl ? [] : ['APP_URL']),
    ];
    return { sent: false, message: `Invitation email is not configured: set ${missing.join(', ')}` };
  }

  const address = user.email ?? null;
  if (!address) {
    return { sent: false, message: 'That account has no email address to send to' };
  }

  try {
    const { token, tokenHash, expiresAt } = mintToken({ ttlMinutes: invite.ttlMinutes });
    // A fresh invitation supersedes any outstanding one, so a forwarded older
    // email stops working the moment a new link is sent.
    await query('UPDATE public.password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
    await query(
      `INSERT INTO public.password_resets (user_id, token_hash, email, expires_at, purpose)
       VALUES ($1, $2, $3, $4, 'invite')`,
      [user.id, tokenHash, address, expiresAt],
    );

    const result = await sendTemplateEmail({
      apiKey: config.apiKey,
      fromEmail: config.fromEmail,
      fromName: config.fromName,
      toEmail: address,
      templateId: invite.templateId,
      data: buildResetTemplateData({
        user,
        link: resetLink(config.appUrl, token, 'invite'),
        ttlMinutes: invite.ttlMinutes,
        clubName: clubDisplayName(user.customer_id),
        fromEmail: config.fromEmail,
        purpose: 'invite',
        invitedBy: actor?.fullName || actor?.username || null,
        role: user.role ?? null,
        toEmail: address,
      }),
    });

    if (result.ok) {
      await query('UPDATE public.dashboard_users SET invited_at = NOW() WHERE id = $1', [user.id]);
      return { sent: true, message: `Invitation sent to ${address}`, email: address };
    }
    return { sent: false, message: result.message };
  } catch (err) {
    log.error('invitation failed:', err.message);
    return { sent: false, message: 'The account was created but the invitation could not be sent' };
  }
}

export default router;
