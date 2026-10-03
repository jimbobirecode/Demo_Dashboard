/**
 * The tour operator portal API (/api/portal).
 *
 *   POST /login              email a one-time sign-in link (same reply either way)
 *   POST /session            redeem the link for a portal session
 *   POST /logout
 *   GET  /me                 the operator, their terms and account summary
 *   GET  /bookings           every booking on their account, with what it owes
 *   GET  /statement.csv      the same, for their accounts team
 *   POST /bookings/:id/request   ask for a change or cancellation (staff approve)
 *   POST /bookings/:id/pay       a Stripe payment link for what is owed
 *   POST /enquiries          ask for new tee times (lands in the club's Inbox)
 *
 * Portal sessions are a different cookie with kind 'operator', and staff
 * routes refuse them (auth.js requireAuth), so a portal user never reaches the
 * staff dashboard and sees only their own operator's bookings.
 */
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { JWT_SECRET } from '../auth.js';
import { BRAND, appBaseUrl } from '../lib/brand.js';
import { sendHtmlEmail } from '../lib/sendgrid.js';
import { logEmail } from '../lib/email-log.js';
import { buildAuditSet } from '../lib/schema.js';
import { todayInClubZone } from '../lib/email-domain.js';
import { createThrottle, hashToken, mintToken } from '../lib/password-reset-domain.js';
import {
  attachOperators,
  buildOperatorIndex,
  describeTerms,
  paymentState,
  summarise,
} from '../lib/operators-domain.js';
import {
  buildChangeEmail,
  describeOptions,
  readChangePolicy,
  serialiseChangeRequest,
  validateChangeRequest,
} from '../lib/change-request-domain.js';
import { PENDING_PAYMENT_STATUS, readPaymentLinkConfig } from '../lib/payment-link-domain.js';
import { createPaymentLink, deactivatePaymentLink, prefilledLinkUrl } from '../lib/stripe.js';
import {
  PORTAL_LINK_TTL_MINUTES,
  PORTAL_NEUTRAL_REPLY,
  PORTAL_SESSION_HOURS,
  buildEnquiry,
  buildPortalSignInEmail,
  isCurrent,
  operatorForEmail,
  portalBooking,
  portalSignInLink,
  statementCsv,
} from '../lib/portal-domain.js';
import { loadBookings, loadOperators } from './operators.js';
import { clientIp, maskForLog } from '../lib/request-guard.js';
import { logger } from '../lib/logger.js';

const log = logger.child('portal');

const router = Router();

const COOKIE = 'teemail_operator';
// Per address asked for and per client, independently, so varying either one
// alone buys no fresh budget.
const loginThrottle = createThrottle({ limit: 5, windowMs: 15 * 60_000 });
const loginIpThrottle = createThrottle({ limit: 20, windowMs: 15 * 60_000 });
const redeemThrottle = createThrottle({ limit: 20, windowMs: 15 * 60_000 });

function mailConfig() {
  return {
    apiKey: process.env.SENDGRID_API_KEY ?? null,
    fromEmail: process.env.FROM_EMAIL ?? null,
    fromName: process.env.FROM_NAME ?? BRAND.fromName,
    replyTo: process.env.REPLY_TO_EMAIL ?? process.env.FROM_EMAIL ?? null,
  };
}

async function sendMail(toEmail, email) {
  const config = mailConfig();
  if (!config.apiKey || !config.fromEmail) return false;
  const outcome = await sendHtmlEmail({ ...config, toEmail, subject: email.subject, text: email.text, html: email.html });
  if (!outcome.ok) log.error('email failed:', outcome.message);
  return outcome.ok;
}

/* ---------- the one-time links ---------- */

// operator_portal_links is created by db/migrations/0003_baseline_operator_portal.sql.

/** Every club's operators, for matching a sign-in address. */
async function allActiveOperators() {
  const { rows } = await query(
    `SELECT id, club, name, contact_email, email_domains, active FROM public.tour_operators
      WHERE active IS NOT FALSE`,
  );
  return rows.map((row) => ({
    id: row.id,
    club: row.club,
    name: row.name,
    contactEmail: row.contact_email,
    emailDomains: row.email_domains ?? [],
    active: row.active !== false,
  }));
}

router.post('/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  if (!email) return res.status(400).json({ error: 'Enter your work email address' });

  // The answer never says whether the address belongs to anyone.
  res.json({ ok: true, message: PORTAL_NEUTRAL_REPLY });

  try {
    const ipAllowed = loginIpThrottle.check(clientIp(req));
    if (!loginThrottle.check(email.toLowerCase()) || !ipAllowed) return;
    const operator = operatorForEmail(email, await allActiveOperators());
    if (!operator) {
      log.warn('sign-in asked for an address on no operator account:', maskForLog(email));
      return;
    }
    const { token, tokenHash, expiresAt } = mintToken({ ttlMinutes: PORTAL_LINK_TTL_MINUTES });
    await query(
      `INSERT INTO public.operator_portal_links (club, operator_id, email, token_hash, expires_at, requested_ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [operator.club, operator.id, email.toLowerCase(), tokenHash, expiresAt, clientIp(req)],
    );
    const sent = await sendMail(
      email,
      buildPortalSignInEmail({ operatorName: operator.name, link: portalSignInLink(appBaseUrl(), token) }),
    );
    if (!sent) log.warn('sign-in link not emailed (SendGrid not configured or failed)');
  } catch (err) {
    log.error('sign-in failed:', err.message);
  }
});

router.post('/session', async (req, res, next) => {
  try {
    if (!redeemThrottle.check(clientIp(req))) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    const refused = { error: 'That sign-in link has expired or has already been used. Ask for a new one.' };
    const token = String(req.body?.token ?? '');
    if (!token) return res.status(400).json(refused);

    // Used once: the row is claimed in the same statement that checks it.
    const { rows } = await query(
      `UPDATE public.operator_portal_links SET used_at = NOW()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        RETURNING club, operator_id, email`,
      [hashToken(token)],
    );
    if (!rows[0]) return res.status(400).json(refused);
    const { rows: ops } = await query(
      'SELECT id, name, active FROM public.tour_operators WHERE id = $1 AND club = $2',
      [rows[0].operator_id, rows[0].club],
    );
    if (!ops[0] || ops[0].active === false) return res.status(400).json(refused);

    const session = jwt.sign(
      { kind: 'operator', operatorId: ops[0].id, club: rows[0].club, email: rows[0].email },
      JWT_SECRET,
      { expiresIn: `${PORTAL_SESSION_HOURS}h` },
    );
    res.cookie(COOKIE, session, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: PORTAL_SESSION_HOURS * 60 * 60 * 1000,
    });
    res.json({ ok: true, operatorName: ops[0].name });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

/* ---------- signed in ---------- */

/**
 * A portal session is only as good as the account behind it. Each request
 * re-reads the operator, so retiring the account — or taking the signed-in
 * address off it (a domain removed, a contact changed) — ends the session at
 * once rather than when the cookie expires.
 */
async function requireOperator(req, res, next) {
  const ended = () => {
    res.clearCookie(COOKIE);
    res.status(401).json({ error: 'Your session has ended. Sign in again.' });
  };
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in' });

  let claims;
  try {
    claims = jwt.verify(token, JWT_SECRET);
    if (claims.kind !== 'operator' || !claims.operatorId || !claims.club) throw new Error('not a portal session');
  } catch {
    return ended();
  }

  try {
    const { rows } = await query(
      `SELECT id, club, name, contact_email, email_domains, active FROM public.tour_operators
        WHERE id = $1 AND club = $2`,
      [claims.operatorId, claims.club],
    );
    const operator = rows[0] && {
      id: rows[0].id,
      club: rows[0].club,
      contactEmail: rows[0].contact_email,
      emailDomains: rows[0].email_domains ?? [],
      active: rows[0].active !== false,
    };
    if (!operator || operatorForEmail(claims.email, [operator])?.id !== operator.id) return ended();
    req.portal = claims;
    next();
  } catch (err) {
    next(err);
  }
}

/** The signed-in operator and exactly their bookings, with what each owes. */
async function loadAccount(req) {
  const { operatorId, club } = req.portal;
  const operators = await loadOperators(club);
  const operator = operators.find((o) => o.id === operatorId);
  if (!operator || operator.active === false) return null;

  const today = todayInClubZone();
  const bookings = attachOperators(await loadBookings(club), buildOperatorIndex(operators))
    .filter((booking) => booking.operatorId === operatorId)
    .map((booking) => ({ ...booking, payment: paymentState(booking, operator, { today }) }));

  let pending = new Map();
  if (bookings.length) {
    const { rows } = await query(
      `SELECT * FROM public.booking_change_requests
        WHERE club = $1 AND status = 'Pending' AND booking_id = ANY($2)`,
      [club, bookings.map((b) => b.bookingId)],
    );
    pending = new Map(rows.map((row) => [row.booking_id, serialiseChangeRequest(row)]));
  }
  const payable = readPaymentLinkConfig().configured;
  return { operator, bookings, pending, today, payable };
}

router.use(['/me', '/bookings', '/statement.csv', '/enquiries'], requireOperator);

router.get('/me', async (req, res, next) => {
  try {
    const account = await loadAccount(req);
    if (!account) return res.status(401).json({ error: 'This account is no longer active. Please contact the club.' });
    const { operator, bookings, today } = account;
    res.json({
      email: req.portal.email,
      club: { name: BRAND.fullName, currency: BRAND.currency },
      operator: {
        name: operator.name,
        accountCode: operator.accountCode,
        terms: describeTerms(operator),
        creditLimit: operator.creditLimit,
        onHold: operator.onHold,
      },
      account: summarise(operator, bookings, { today }),
      canPayOnline: account.payable,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/bookings', async (req, res, next) => {
  try {
    const account = await loadAccount(req);
    if (!account) return res.status(401).json({ error: 'This account is no longer active.' });
    const { bookings, pending, today, payable } = account;
    const list = bookings
      .map((b) => portalBooking(b, { pendingRequest: pending.get(b.bookingId), payable }))
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
    res.json({ today, bookings: list, current: list.filter((b) => isCurrent(b, today)).length });
  } catch (err) {
    next(err);
  }
});

router.get('/statement.csv', async (req, res, next) => {
  try {
    const account = await loadAccount(req);
    if (!account) return res.status(401).json({ error: 'This account is no longer active.' });
    const list = account.bookings
      .map((b) => portalBooking(b))
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
    const name = account.operator.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-statement-${account.today}.csv"`);
    res.send(`﻿${statementCsv(list)}`);
  } catch (err) {
    next(err);
  }
});

/** One of the operator's own bookings, or a 404 - never another account's. */
function ownBooking(account, bookingId) {
  return account.bookings.find((b) => b.bookingId === String(bookingId)) ?? null;
}

router.post('/bookings/:bookingId/request', async (req, res, next) => {
  try {
    const account = await loadAccount(req);
    if (!account) return res.status(401).json({ error: 'This account is no longer active.' });
    const booking = ownBooking(account, req.params.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (account.pending.has(booking.bookingId)) {
      return res.status(409).json({ error: 'There is already a request with the club for this booking.' });
    }

    const options = describeOptions(booking, readChangePolicy(), account.today);
    const check = validateChangeRequest(req.body, options);
    if (!check.ok) return res.status(400).json({ error: check.errors.join('. ') });

    // A request only: nothing about the booking changes until staff approve.
    await query(
      `INSERT INTO public.booking_change_requests
         (booking_id, club, kind, message, requested_date, requested_time, requested_players,
          status, auto_applied, days_before_play, guest_email, requested_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Pending',FALSE,$8,$9,$10)`,
      [
        booking.bookingId, booking.club, check.value.kind,
        `[${account.operator.name}, via the portal] ${check.value.message ?? ''}`.trim(),
        check.value.requestedDate, check.value.requestedTime, check.value.requestedPlayers,
        options.daysUntilPlay, req.portal.email, clientIp(req),
      ],
    );
    // Addressed to the operator, not the booking's lead guest.
    const email = buildChangeEmail({ outcome: 'received', booking: { ...booking, guestName: '' }, request: { kind: check.value.kind } });
    const emailed = await sendMail(req.portal.email, email).catch(() => false);
    if (emailed) {
      await logEmail({
        club: booking.club, direction: 'outbound', booking_id: booking.bookingId,
        from_email: process.env.FROM_EMAIL, to_email: req.portal.email, subject: email.subject,
        body_text: email.text, sent_by: 'bot', kind: 'change_acknowledgement',
      });
    }
    res.status(201).json({
      ok: true,
      message:
        check.value.kind === 'cancel'
          ? `Cancellation request sent for ${booking.bookingId}. The booking stays in place until the club confirms it.`
          : `Change request sent for ${booking.bookingId}. The club will confirm what is possible.`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/bookings/:bookingId/pay', async (req, res, next) => {
  try {
    const config = readPaymentLinkConfig();
    if (!config.configured) return res.status(409).json({ error: 'Online payment is not available. Please contact the club.' });
    const account = await loadAccount(req);
    if (!account) return res.status(401).json({ error: 'This account is no longer active.' });
    const booking = ownBooking(account, req.params.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const view = portalBooking(booking, { payable: true });
    if (!view.canPay) return res.status(400).json({ error: 'Nothing is owed on this booking.' });

    // Always the balance as the club's books have it, never an amount the
    // browser sent.
    const amount = Math.round(view.outstanding * 100) / 100;
    const link = await createPaymentLink({
      secretKey: config.secretKey,
      amount,
      currency: config.currency,
      productName: `${BRAND.fullName} – booking ${booking.bookingId}`,
      bookingId: booking.bookingId,
      club: booking.club,
      confirmationMessage: `Thank you — your payment for booking ${booking.bookingId} has been received. ${BRAND.fullName}`,
    });
    const url = prefilledLinkUrl(link.url, { email: req.portal.email, bookingId: booking.bookingId });

    // Recorded on the booking exactly as a staff-sent link is, so the Stripe
    // webhook and sync credit the payment; an older link is switched off.
    if (booking.paymentLinkId && booking.paymentLinkId !== link.id) {
      await deactivatePaymentLink({ secretKey: config.secretKey, linkId: booking.paymentLinkId }).catch(() => {});
    }
    const updates = {
      stripe_payment_link_id: link.id,
      stripe_payment_link_url: url,
      payment_link_amount: amount,
      payment_link_sent_by: `portal:${req.portal.email}`,
      payment_status: PENDING_PAYMENT_STATUS,
    };
    const names = Object.keys(updates);
    const params = names.map((name) => updates[name]);
    const sets = names.map((name, index) => `"${name}" = $${index + 1}`);
    sets.push('payment_link_sent_at = NOW()');
    const audit = buildAuditSet(params.length + 1, `portal:${req.portal.email}`);
    params.push(...audit.values, booking.bookingId, booking.club);
    await query(
      `UPDATE public.bookings SET ${[...sets, ...audit.clauses].join(', ')}
        WHERE booking_id = $${params.length - 1} AND club = $${params.length}`,
      params,
    );
    res.json({ url, amount });
  } catch (err) {
    if (/^Stripe /.test(err.message)) return res.status(502).json({ error: 'Stripe could not create the payment. Please try again or contact the club.' });
    next(err);
  }
});

router.post('/enquiries', async (req, res, next) => {
  try {
    const account = await loadAccount(req);
    if (!account) return res.status(401).json({ error: 'This account is no longer active.' });
    const enquiry = buildEnquiry(req.body, account.operator, req.portal.email);
    if (enquiry.error) return res.status(400).json({ error: enquiry.error });

    // Into the club's Inbox, as an operator request for a person to answer.
    await query(
      `INSERT INTO public.email_messages
         (club, direction, from_email, to_email, subject, body_text, intent, summary,
          routed_to, review_status, review_reason)
       VALUES ($1, 'inbound', $2, $3, $4, $5, 'operator_request', $6, 'inbox', 'open', $7)`,
      [
        req.portal.club, req.portal.email, process.env.FROM_EMAIL ?? null, enquiry.subject, enquiry.body,
        enquiry.summary, 'Tee time request from the tour operator portal',
      ],
    );
    res.status(201).json({ ok: true, message: 'Request sent. The club will reply by email with tee times.' });
  } catch (err) {
    next(err);
  }
});

export default router;
