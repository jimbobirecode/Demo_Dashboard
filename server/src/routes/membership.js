/**
 * Membership: the club's side of enquiry → reply → application → review →
 * welcome.
 *
 * The core API answers enquiry emails and hosts the application and waitlist
 * forms (see the membership contract in docs/ARCHITECTURE.md); this router is
 * where the club switches the service on and off, maintains its categories
 * and copy, and moves applications through review, emailing the applicant at
 * each decision.
 *
 *   GET  /settings                       service switch + copy (everyone)
 *   PUT  /settings                       change them (admin)
 *   GET  /categories                     categories, with how many applications use each
 *   POST /categories, PUT|DELETE /categories/:id   (admin; delete is soft when referenced)
 *   GET  /summary                        the KPI row
 *   GET  /applications?status=&q=        list + counts per status
 *   GET  /applications.csv               export
 *   GET  /applications/:id               detail, timeline, the enquiry email
 *   PATCH /applications/:id/status       a review decision {status, note}
 *   POST /applications/:id/notes         a staff note
 *   POST /applications/:id/invite        waitlisted → invited (service on only)
 *   POST /applications/invite-waitlist   invite everybody waiting (admin)
 *
 * Every query is scoped to req.user.customerId: an id from another club is a
 * 404, never somebody else's applicant.
 */
import { Router } from 'express';
import { pool, query } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { BRAND } from '../lib/brand.js';
import { csvLine } from '../lib/csv.js';
import { sendHtmlEmail } from '../lib/sendgrid.js';
import { logEmail } from '../lib/email-log.js';
import { serialiseMessage } from '../lib/inbox-domain.js';
import { logger } from '../lib/logger.js';
import {
  CSV_COLUMNS,
  DECISION_EMAIL_KINDS,
  MEMBERSHIP_STATUSES,
  STATUS_LABELS,
  TRANSITIONS,
  buildMembershipEmail,
  isMembershipStatus,
  membershipFormBaseUrl,
  membershipSecret,
  membershipUrlFor,
  serialiseApplication,
  serialiseCategory,
  serialiseEvent,
  transitionPlan,
  validateCategory,
  validateMembershipSettings,
} from '../lib/membership-domain.js';

const log = logger.child('membership');

const router = Router();
router.use(requireAuth);

const APPLICATION_SELECT = `a.*, c.name AS category_name`;
const APPLICATION_FROM = `public.membership_applications a
  LEFT JOIN public.membership_categories c ON c.id = a.category_id AND c.club = a.club`;

/* ---------- settings ---------- */

async function loadSettings(club) {
  const { rows } = await query(
    `SELECT membership_enabled, membership_settings, updated_at, updated_by
       FROM public.club_settings WHERE club = $1`,
    [club],
  );
  const row = rows[0];
  return {
    // No row means the club has never switched it on.
    enabled: Boolean(row?.membership_enabled),
    settings: row?.membership_settings ?? {},
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row?.updated_by ?? null,
  };
}

function linksConfigured() {
  return Boolean(membershipSecret() && membershipFormBaseUrl());
}

function emailConfigured() {
  return Boolean(process.env.SENDGRID_API_KEY && process.env.FROM_EMAIL);
}

router.get('/settings', async (req, res, next) => {
  try {
    const settings = await loadSettings(req.user.customerId);
    res.json({
      ...settings,
      canEdit: req.user.role === 'admin',
      linksConfigured: linksConfigured(),
      emailConfigured: emailConfigured(),
      statuses: MEMBERSHIP_STATUSES.map((id) => ({ id, label: STATUS_LABELS[id], next: TRANSITIONS[id] })),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/settings', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    let enabled = null;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
      enabled = body.enabled;
    }
    let copy = null;
    if (body.settings !== undefined) {
      const check = validateMembershipSettings(body.settings);
      if (!check.ok) return res.status(400).json({ error: check.errors.join('. ') });
      copy = check.value;
    }
    if (enabled === null && copy === null) return res.status(400).json({ error: 'Nothing to change' });

    const club = req.user.customerId;
    const before = await loadSettings(club);
    await query(
      `INSERT INTO public.club_settings (club, membership_enabled, membership_settings, updated_at, updated_by)
       VALUES ($1, COALESCE($2::boolean, FALSE), COALESCE($3::jsonb, '{}'::jsonb), NOW(), $4)
       ON CONFLICT (club) DO UPDATE SET
         membership_enabled  = COALESCE($2::boolean, public.club_settings.membership_enabled),
         membership_settings = COALESCE($3::jsonb, public.club_settings.membership_settings),
         updated_at = NOW(),
         updated_by = $4`,
      [club, enabled, copy === null ? null : JSON.stringify(copy), req.user.username],
    );

    if (enabled !== null && enabled !== before.enabled) {
      log.info(`membership applications ${enabled ? 'opened' : 'closed'} for ${club} by ${req.user.username}`);
    }
    if (copy !== null) log.info(`membership copy for ${club} updated by ${req.user.username}`);

    const after = await loadSettings(club);
    res.json({ ...after, canEdit: true, linksConfigured: linksConfigured(), emailConfigured: emailConfigured() });
  } catch (err) {
    next(err);
  }
});

/* ---------- categories ---------- */

async function loadCategories(club) {
  const { rows } = await query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM public.membership_applications a
              WHERE a.club = c.club AND a.category_id = c.id) AS applications
       FROM public.membership_categories c
      WHERE c.club = $1
      ORDER BY c.active DESC, c.sort_order, c.name`,
    [club],
  );
  return rows.map(serialiseCategory);
}

function categoryId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 && id < 2 ** 31 ? id : null;
}

router.get('/categories', async (req, res, next) => {
  try {
    res.json({ categories: await loadCategories(req.user.customerId) });
  } catch (err) {
    next(err);
  }
});

router.post('/categories', requireAdmin, async (req, res, next) => {
  try {
    const check = validateCategory(req.body);
    if (!check.ok) return res.status(400).json({ error: check.errors.join('. ') });
    const v = check.value;
    const { rows } = await query(
      `INSERT INTO public.membership_categories
         (club, name, description, eligibility, joining_fee, annual_fee, min_age, max_age, sort_order, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        req.user.customerId,
        v.name,
        v.description,
        v.eligibility,
        v.joining_fee,
        v.annual_fee,
        v.min_age,
        v.max_age,
        v.sort_order,
        v.active,
      ],
    );
    res.status(201).json({ category: serialiseCategory(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A category with that name already exists' });
    next(err);
  }
});

router.put('/categories/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = categoryId(req.params.id);
    if (!id) return res.status(404).json({ error: 'No such category' });
    const check = validateCategory(req.body);
    if (!check.ok) return res.status(400).json({ error: check.errors.join('. ') });
    const v = check.value;
    const { rows } = await query(
      `UPDATE public.membership_categories
          SET name = $3, description = $4, eligibility = $5, joining_fee = $6, annual_fee = $7,
              min_age = $8, max_age = $9, sort_order = $10, active = $11, updated_at = NOW()
        WHERE id = $1 AND club = $2
        RETURNING *`,
      [
        id,
        req.user.customerId,
        v.name,
        v.description,
        v.eligibility,
        v.joining_fee,
        v.annual_fee,
        v.min_age,
        v.max_age,
        v.sort_order,
        v.active,
      ],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such category' });
    res.json({ category: serialiseCategory(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A category with that name already exists' });
    next(err);
  }
});

/**
 * A category an application points at is retired (active = false), not
 * deleted: the application must still say what the applicant applied for.
 */
router.delete('/categories/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = categoryId(req.params.id);
    if (!id) return res.status(404).json({ error: 'No such category' });
    const club = req.user.customerId;
    const { rows } = await query(
      `SELECT c.id,
              EXISTS (SELECT 1 FROM public.membership_applications a
                       WHERE a.club = c.club AND (a.category_id = c.id OR c.id = ANY(a.recommended_category_ids))) AS used
         FROM public.membership_categories c WHERE c.id = $1 AND c.club = $2`,
      [id, club],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such category' });

    if (rows[0].used) {
      await query(
        'UPDATE public.membership_categories SET active = FALSE, updated_at = NOW() WHERE id = $1 AND club = $2',
        [id, club],
      );
      return res.json({ ok: true, retired: true });
    }
    await query('DELETE FROM public.membership_categories WHERE id = $1 AND club = $2', [id, club]);
    res.json({ ok: true, deleted: true });
  } catch (err) {
    next(err);
  }
});

/* ---------- summary ---------- */

router.get('/summary', async (req, res, next) => {
  try {
    const club = req.user.customerId;
    const [{ rows }, settings] = await Promise.all([
      query(
        `SELECT COUNT(*) FILTER (WHERE status = 'submitted')::int    AS submitted,
                COUNT(*) FILTER (WHERE status = 'under_review')::int AS under_review,
                COUNT(*) FILTER (WHERE status = 'approved')::int     AS approved,
                COUNT(*) FILTER (WHERE status = 'waitlisted')::int   AS waitlisted,
                COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()))::int AS enquiries_this_month,
                COUNT(*) FILTER (WHERE status = 'welcomed' AND welcomed_at >= date_trunc('year', NOW()))::int AS welcomed_this_year
           FROM public.membership_applications WHERE club = $1`,
        [club],
      ),
      loadSettings(club),
    ]);
    const r = rows[0];
    res.json({
      enabled: settings.enabled,
      newSubmissions: r.submitted,
      underReview: r.under_review,
      awaitingWelcome: r.approved,
      waitlist: r.waitlisted,
      enquiriesThisMonth: r.enquiries_this_month,
      welcomedThisYear: r.welcomed_this_year,
    });
  } catch (err) {
    next(err);
  }
});

/* ---------- applications ---------- */

function listFilter(req) {
  const values = [req.user.customerId];
  const where = ['a.club = $1'];
  const status = String(req.query.status ?? '').trim();
  if (status && status !== 'all') {
    const statuses = status.split(',').filter(isMembershipStatus);
    if (!statuses.length) return { error: 'Unknown status' };
    values.push(statuses);
    where.push(`a.status = ANY($${values.length}::text[])`);
  }
  const q = String(req.query.q ?? '')
    .trim()
    .slice(0, 100);
  if (q) {
    values.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const p = `$${values.length}`;
    where.push(
      `(a.reference ILIKE ${p} OR a.email ILIKE ${p} OR COALESCE(a.first_name, '') || ' ' || COALESCE(a.last_name, '') ILIKE ${p})`,
    );
  }
  return { where: where.join(' AND '), values };
}

router.get('/applications', async (req, res, next) => {
  try {
    const filter = listFilter(req);
    if (filter.error) return res.status(400).json({ error: filter.error });
    const [list, counts] = await Promise.all([
      query(
        `SELECT ${APPLICATION_SELECT} FROM ${APPLICATION_FROM}
          WHERE ${filter.where}
          ORDER BY COALESCE(a.submitted_at, a.created_at) DESC, a.id DESC
          LIMIT 500`,
        filter.values,
      ),
      query(
        `SELECT status, COUNT(*)::int AS count FROM public.membership_applications
          WHERE club = $1 GROUP BY status`,
        [req.user.customerId],
      ),
    ]);
    const byStatus = Object.fromEntries(MEMBERSHIP_STATUSES.map((s) => [s, 0]));
    for (const row of counts.rows) byStatus[row.status] = row.count;
    res.json({ applications: list.rows.map(serialiseApplication), counts: byStatus });
  } catch (err) {
    next(err);
  }
});

router.get('/applications.csv', async (req, res, next) => {
  try {
    const filter = listFilter(req);
    if (filter.error) return res.status(400).json({ error: filter.error });
    const { rows } = await query(
      `SELECT ${APPLICATION_SELECT} FROM ${APPLICATION_FROM}
        WHERE ${filter.where}
        ORDER BY a.created_at DESC, a.id DESC`,
      filter.values,
    );
    const applications = rows.map(serialiseApplication);
    const csv = [
      csvLine(CSV_COLUMNS.map(([label]) => label)),
      ...applications.map((a) => csvLine(CSV_COLUMNS.map(([, pick]) => pick(a)))),
    ].join('\n');
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="membership_${stamp}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

async function findApplication(rawId, club, db = { query }) {
  const id = categoryId(rawId);
  if (!id) return null;
  const { rows } = await db.query(
    `SELECT ${APPLICATION_SELECT} FROM ${APPLICATION_FROM} WHERE a.id = $1 AND a.club = $2`,
    [id, club],
  );
  return rows[0] ?? null;
}

async function loadCategory(id, club) {
  if (!id) return null;
  const { rows } = await query('SELECT * FROM public.membership_categories WHERE id = $1 AND club = $2', [id, club]);
  return rows[0] ? serialiseCategory(rows[0]) : null;
}

async function addEvent(db, applicationId, club, event, actor, note = null) {
  await db.query(
    `INSERT INTO public.membership_events (application_id, club, event, actor, note) VALUES ($1, $2, $3, $4, $5)`,
    [applicationId, club, event, actor, note || null],
  );
}

router.get('/applications/:id', async (req, res, next) => {
  try {
    const club = req.user.customerId;
    const row = await findApplication(req.params.id, club);
    if (!row) return res.status(404).json({ error: 'No such application' });
    const application = serialiseApplication(row);

    const [events, recommended, source, category] = await Promise.all([
      query(`SELECT * FROM public.membership_events WHERE application_id = $1 AND club = $2 ORDER BY created_at, id`, [
        application.id,
        club,
      ]),
      application.recommendedCategoryIds.length
        ? query(
            `SELECT * FROM public.membership_categories WHERE club = $1 AND id = ANY($2::int[]) ORDER BY sort_order, name`,
            [club, application.recommendedCategoryIds],
          )
        : { rows: [] },
      application.sourceMessageId
        ? query('SELECT * FROM public.email_messages WHERE id = $1 AND club = $2', [application.sourceMessageId, club])
        : { rows: [] },
      loadCategory(application.categoryId, club),
    ]);

    res.json({
      application,
      category,
      recommendedCategories: recommended.rows.map(serialiseCategory),
      events: events.rows.map(serialiseEvent),
      sourceEmail: source.rows[0] ? serialiseMessage(source.rows[0]) : null,
      emailConfigured: emailConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Email the applicant and file it: email_messages (the shared conversation
 * log, under the contract's kind) and the application's timeline. Resolves
 * { sent, reason } — a decision stands whether or not the email went, and the
 * page says which.
 */
async function emailApplicant(
  req,
  application,
  decision,
  { category = null, settings = {}, link = null, note = '' } = {},
) {
  const emailKind = DECISION_EMAIL_KINDS[decision];
  if (!emailKind) return { sent: false, reason: 'No email for this step' };
  if (!emailConfigured()) {
    return { sent: false, reason: 'Email sending is not set up (SENDGRID_API_KEY, FROM_EMAIL)' };
  }

  const club = req.user.customerId;
  const fromEmail = process.env.FROM_EMAIL;
  const email = buildMembershipEmail({ kind: decision, application, category, settings, link, note });
  const outcome = await sendHtmlEmail({
    apiKey: process.env.SENDGRID_API_KEY,
    fromEmail,
    fromName: process.env.FROM_NAME ?? BRAND.fromName,
    replyTo: settings.contact_email || process.env.REPLY_TO_EMAIL || fromEmail,
    toEmail: application.email,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
  if (!outcome.ok) {
    log.error(`membership email ${emailKind} to application ${application.id} failed: ${outcome.message}`);
    return { sent: false, reason: `The email was not sent: ${outcome.message}` };
  }
  await logEmail({
    club,
    direction: 'outbound',
    from_email: fromEmail,
    to_email: application.email,
    subject: email.subject,
    body_text: email.text,
    sent_by: req.user.username,
    kind: emailKind,
  });
  await addEvent({ query }, application.id, club, `email:${emailKind}`, req.user.username).catch((err) =>
    log.warn('could not record the email on the timeline:', err.message),
  );
  return { sent: true, kind: emailKind };
}

router.patch('/applications/:id/status', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const club = req.user.customerId;
    const to = String(req.body?.status ?? '');
    const note = String(req.body?.note ?? '').trim();
    if (!isMembershipStatus(to)) return res.status(400).json({ error: 'Unknown status' });
    if (note.length > 2000) return res.status(400).json({ error: 'The note must be 2000 characters or fewer' });
    if (to === 'invited') {
      return res.status(400).json({ error: 'Use “Invite to apply” — an invitation sends the applicant a signed link' });
    }

    const row = await findApplication(req.params.id, club);
    if (!row) return res.status(404).json({ error: 'No such application' });

    const plan = transitionPlan(row.status, to, { actor: req.user.username, note });
    if (!plan.ok) return res.status(409).json({ error: plan.error });

    const values = [row.id, club, row.status, to];
    const sets = ['status = $4', 'updated_at = NOW()'];
    if (plan.sets.decided_by) {
      values.push(plan.sets.decided_by);
      sets.push(`decided_by = $${values.length}`, 'decided_at = NOW()');
    }
    if (plan.sets.decision_note) {
      values.push(plan.sets.decision_note);
      sets.push(`decision_note = $${values.length}`);
    }
    if (plan.sets.welcomed_at) sets.push('welcomed_at = NOW()');

    await client.query('BEGIN');
    // status = the one it was read with: two people deciding at once cannot
    // both win, and the second is told rather than silently overwritten.
    const updated = await client.query(
      `UPDATE public.membership_applications SET ${sets.join(', ')}
        WHERE id = $1 AND club = $2 AND status = $3 RETURNING id`,
      values,
    );
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Somebody else changed this application just now — reload it' });
    }
    await addEvent(client, row.id, club, plan.event, req.user.username, note);
    await client.query('COMMIT');

    const fresh = serialiseApplication(await findApplication(row.id, club));
    const [category, { settings }] = await Promise.all([loadCategory(fresh.categoryId, club), loadSettings(club)]);
    const email = plan.emailKind
      ? await emailApplicant(req, fresh, to, { category, settings, note })
      : { sent: false, reason: 'No email for this step' };

    res.json({ application: fresh, emailed: email.sent, emailKind: plan.emailKind, emailNotice: email.reason ?? null });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/applications/:id/notes', async (req, res, next) => {
  try {
    const club = req.user.customerId;
    const note = String(req.body?.note ?? '').trim();
    if (!note) return res.status(400).json({ error: 'Write a note first' });
    if (note.length > 2000) return res.status(400).json({ error: 'The note must be 2000 characters or fewer' });
    const row = await findApplication(req.params.id, club);
    if (!row) return res.status(404).json({ error: 'No such application' });

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    await query(
      `UPDATE public.membership_applications
          SET staff_notes = CONCAT_WS(E'\\n', NULLIF(staff_notes, ''), $3::text), updated_at = NOW()
        WHERE id = $1 AND club = $2`,
      [row.id, club, `[${stamp} ${req.user.username}] ${note}`],
    );
    await addEvent({ query }, row.id, club, 'note', req.user.username, note);
    res.status(201).json({ application: serialiseApplication(await findApplication(row.id, club)) });
  } catch (err) {
    next(err);
  }
});

/**
 * waitlisted → invited, with an email carrying a signed link to the full
 * application. Only while the club is accepting applications: inviting
 * somebody to a form that would turn them back to the waitlist helps nobody.
 */
async function inviteOne(req, row, settings) {
  const club = req.user.customerId;
  const application = serialiseApplication(row);
  const link = membershipUrlFor({ reference: application.reference, club }, 'apply');
  const updated = await query(
    `UPDATE public.membership_applications SET status = 'invited', updated_at = NOW()
      WHERE id = $1 AND club = $2 AND status = 'waitlisted' RETURNING id`,
    [row.id, club],
  );
  if (!updated.rowCount) return { ok: false };
  await addEvent({ query }, row.id, club, 'invited', req.user.username);
  const fresh = serialiseApplication(await findApplication(row.id, club));
  const category = await loadCategory(fresh.categoryId, club);
  const email = await emailApplicant(req, fresh, 'invited', { category, settings: settings.settings, link });
  return { ok: true, application: fresh, emailed: email.sent, emailNotice: email.reason ?? null };
}

async function inviteGuard(req, res) {
  const settings = await loadSettings(req.user.customerId);
  if (!settings.enabled) {
    res.status(409).json({ error: 'Membership applications are closed — switch them on before inviting the waitlist' });
    return null;
  }
  if (!linksConfigured()) {
    res.status(409).json({
      error: 'Application links cannot be made: set BOOKING_LINK_SECRET and MEMBERSHIP_FORM_BASE_URL on the server',
    });
    return null;
  }
  return settings;
}

// Declared before /applications/:id/... so "invite-waitlist" is never read as an id.
router.post('/applications/invite-waitlist', requireAdmin, async (req, res, next) => {
  try {
    const settings = await inviteGuard(req, res);
    if (!settings) return;
    const { rows } = await query(
      `SELECT ${APPLICATION_SELECT} FROM ${APPLICATION_FROM}
        WHERE a.club = $1 AND a.status = 'waitlisted' ORDER BY a.created_at`,
      [req.user.customerId],
    );
    let invited = 0;
    let emailed = 0;
    for (const row of rows) {
      const result = await inviteOne(req, row, settings);
      if (result.ok) invited += 1;
      if (result.emailed) emailed += 1;
    }
    log.info(`${req.user.username} invited ${invited} waitlisted applicant(s) for ${req.user.customerId}`);
    res.json({ invited, emailed, emailConfigured: emailConfigured() });
  } catch (err) {
    next(err);
  }
});

router.post('/applications/:id/invite', async (req, res, next) => {
  try {
    const row = await findApplication(req.params.id, req.user.customerId);
    if (!row) return res.status(404).json({ error: 'No such application' });
    if (row.status !== 'waitlisted') {
      return res.status(409).json({ error: 'Only somebody on the waitlist can be invited to apply' });
    }
    const settings = await inviteGuard(req, res);
    if (!settings) return;
    const result = await inviteOne(req, row, settings);
    if (!result.ok)
      return res.status(409).json({ error: 'Somebody else changed this application just now — reload it' });
    res.json({ application: result.application, emailed: result.emailed, emailNotice: result.emailNotice });
  } catch (err) {
    next(err);
  }
});

export default router;
