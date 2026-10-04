/**
 * Membership: from an enquiry to a welcome, as rules rather than queries.
 *
 * The core API answers the enquiry email and hosts the application and
 * waitlist forms; the dashboard reviews what comes in and tells the applicant
 * what was decided. Both sides share the tables in 0008_membership.sql and the
 * reference and link formats below (the membership contract), so a link the
 * dashboard mints opens on the core API's form and the other way round.
 *
 * Everything here is pure, so it is tested without a database or SendGrid.
 */
import crypto from 'node:crypto';
import { BRAND } from './brand.js';
import { brandedEmail, escapeHtml, EMAIL_COLORS } from './email-layout.js';
import { linkSecret } from './change-request-domain.js';

/* ---------------------------------------------------------------------------
 * Statuses
 * ------------------------------------------------------------------------- */

export const MEMBERSHIP_STATUSES = [
  'enquired',
  'submitted',
  'under_review',
  'approved',
  'declined',
  'welcomed',
  'waitlisted',
  'invited',
  'withdrawn',
];

export const STATUS_LABELS = {
  enquired: 'Enquired',
  submitted: 'Submitted',
  under_review: 'Under review',
  approved: 'Approved',
  declined: 'Declined',
  welcomed: 'Welcomed',
  waitlisted: 'Waitlisted',
  invited: 'Invited to apply',
  withdrawn: 'Withdrawn',
};

/**
 * Where an application may go next. Staff move submitted applications through
 * review; the guest's own steps (enquired → submitted, invited → submitted,
 * enquired → waitlisted) happen on the core API's forms and are not listed
 * here. declined, welcomed and withdrawn are the end of the road.
 */
export const TRANSITIONS = {
  enquired: ['withdrawn'],
  submitted: ['under_review'],
  under_review: ['approved', 'declined'],
  approved: ['welcomed'],
  declined: [],
  welcomed: [],
  waitlisted: ['invited', 'withdrawn'],
  invited: ['withdrawn'],
  withdrawn: [],
};

/** Statuses a repeat enquiry reuses rather than starting a new application. */
export const OPEN_STATUSES = ['enquired', 'invited', 'waitlisted'];

export const TERMINAL_STATUSES = MEMBERSHIP_STATUSES.filter((status) => TRANSITIONS[status].length === 0);

export function isMembershipStatus(status) {
  return MEMBERSHIP_STATUSES.includes(status);
}

export function nextStatuses(from) {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(from, to) {
  return nextStatuses(from).includes(to);
}

/**
 * The applicant email each staff decision sends, by the status it moves to.
 * Values are the email_messages.kind the contract fixes.
 */
export const DECISION_EMAIL_KINDS = {
  under_review: 'membership_under_review',
  approved: 'membership_approved',
  declined: 'membership_declined',
  welcomed: 'membership_welcome',
  invited: 'membership_invite',
};

/** Every outbound membership email kind, both services (the Inbox labels them). */
export const MEMBERSHIP_EMAIL_KINDS = [
  'membership_reply',
  'membership_closed',
  'membership_received',
  'membership_waitlisted',
  'membership_under_review',
  'membership_approved',
  'membership_declined',
  'membership_welcome',
  'membership_invite',
];

/**
 * What a move writes besides the status itself: who decided and when on an
 * approval or a decline, the welcome time on a welcome, and the note where
 * one was given on a decision.
 */
export function transitionPlan(from, to, { actor, note = '' } = {}) {
  if (!canTransition(from, to)) {
    const allowed = nextStatuses(from);
    return {
      ok: false,
      error: allowed.length
        ? `An application that is ${STATUS_LABELS[from] ?? from} can only move to ${allowed.map((s) => STATUS_LABELS[s]).join(' or ')}`
        : `An application that is ${STATUS_LABELS[from] ?? from} cannot change any more`,
    };
  }
  const said = String(note ?? '').trim();
  const sets = { status: to };
  if (to === 'approved' || to === 'declined') {
    sets.decided_by = actor;
    sets.decided_at = 'now';
    if (said) sets.decision_note = said;
  }
  if (to === 'welcomed') sets.welcomed_at = 'now';
  return { ok: true, sets, event: `status:${to}`, emailKind: DECISION_EMAIL_KINDS[to] ?? null };
}

/* ---------------------------------------------------------------------------
 * Reference and signed links (shared with the core API — do not change)
 * ------------------------------------------------------------------------- */

const REFERENCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const REFERENCE_PATTERN = /^MEM-\d{8}-[A-Z0-9]{8}$/;

/** MEM-YYYYMMDD-XXXXXXXX: the UTC date, then 8 crypto-random characters from A-Z0-9. */
export function mintMembershipReference(now = new Date(), randomInt = crypto.randomInt) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  let tail = '';
  for (let i = 0; i < 8; i += 1) tail += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return `MEM-${day}-${tail}`;
}

export function isMembershipReference(value) {
  return REFERENCE_PATTERN.test(String(value ?? ''));
}

/**
 * The key membership links are signed with: BOOKING_LINK_SECRET, which the
 * core API holds too. Unlike manage-booking links there is no JWT_SECRET
 * fallback — a link signed with a key the core API does not have would open
 * nothing, so no secret means no link.
 */
export function membershipSecret(env = process.env) {
  return env.BOOKING_LINK_SECRET ? linkSecret(env) : null;
}

/** base64url(HMAC-SHA256(secret, `${club}|membership|${reference}`)), unpadded, first 32 characters. */
export function signMembership(reference, secret, club = '') {
  if (!secret || !reference) return null;
  return crypto
    .createHmac('sha256', String(secret))
    .update(`${club}|membership|${reference}`)
    .digest('base64url')
    .replace(/=+$/, '')
    .slice(0, 32);
}

/** Constant-time check of a membership token. */
export function verifyMembershipToken(reference, token, secret, club = '') {
  const expected = signMembership(reference, secret, club);
  if (!expected || !token) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The core API's public address, where the application and waitlist forms live. */
export function membershipFormBaseUrl(env = process.env) {
  const base = String(env.MEMBERSHIP_FORM_BASE_URL ?? '').trim();
  return base ? base.replace(/\/+$/, '') : null;
}

export function membershipLink(base, form, reference, token) {
  const path = form === 'waitlist' ? 'waitlist' : 'apply';
  return `${String(base).replace(/\/+$/, '')}/membership/${path}?ref=${encodeURIComponent(reference)}&token=${encodeURIComponent(token)}`;
}

/**
 * A signed link to the application (form 'apply') or waitlist form for an
 * application, or null when this install cannot issue one (no secret, or no
 * MEMBERSHIP_FORM_BASE_URL to point it at).
 */
export function membershipUrlFor(application, form = 'apply', env = process.env) {
  const secret = membershipSecret(env);
  const base = membershipFormBaseUrl(env);
  if (!secret || !base || !application?.reference) return null;
  return membershipLink(
    base,
    form,
    application.reference,
    signMembership(application.reference, secret, application.club ?? ''),
  );
}

/* ---------------------------------------------------------------------------
 * Settings and categories
 * ------------------------------------------------------------------------- */

/** The copy the replies use, and how long each may be. */
export const SETTINGS_LIMITS = {
  intro: 2000,
  next_steps: 2000,
  closed_message: 2000,
  contact_email: 254,
  committee_name: 120,
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate membership_settings. Unknown keys are dropped, every value is
 * trimmed text, and an empty value is simply left out (the emails then use
 * their own wording).
 */
export function validateMembershipSettings(input) {
  const errors = [];
  const value = {};
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    return { ok: false, errors: ['Settings must be an object'], value };
  }
  for (const [key, limit] of Object.entries(SETTINGS_LIMITS)) {
    const raw = input?.[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      errors.push(`${labelFor(key)} must be text`);
      continue;
    }
    const text = raw.trim();
    if (!text) continue;
    if (text.length > limit) {
      errors.push(`${labelFor(key)} must be ${limit} characters or fewer`);
      continue;
    }
    if (key === 'contact_email' && !EMAIL_PATTERN.test(text)) {
      errors.push('Contact email must be an email address');
      continue;
    }
    value[key] = text;
  }
  return { ok: errors.length === 0, errors, value };
}

function labelFor(key) {
  return (
    {
      intro: 'Introduction',
      next_steps: 'Next steps',
      closed_message: 'Closed message',
      contact_email: 'Contact email',
      committee_name: 'Committee name',
    }[key] ?? key
  );
}

export const MAX_FEE = 100000;

function readFee(raw, label, errors) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const fee = Number(raw);
  if (!Number.isFinite(fee) || fee < 0 || fee > MAX_FEE) {
    errors.push(`${label} must be between 0 and ${MAX_FEE.toLocaleString('en-GB')}`);
    return null;
  }
  return Math.round(fee * 100) / 100;
}

function readAge(raw, label, errors) {
  if (raw === undefined || raw === null || raw === '') return null;
  const age = Number(raw);
  if (!Number.isInteger(age) || age < 0 || age > 120) {
    errors.push(`${label} must be a whole number from 0 to 120`);
    return null;
  }
  return age;
}

function readText(raw, label, limit, errors) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    errors.push(`${label} must be text`);
    return '';
  }
  const text = raw.trim();
  if (text.length > limit) errors.push(`${label} must be ${limit} characters or fewer`);
  return text;
}

/** Validate a membership category from the form. */
export function validateCategory(input) {
  const errors = [];
  const body = input && typeof input === 'object' ? input : {};
  const name = readText(body.name, 'Name', 80, errors);
  if (!name) errors.push('A name is required');
  const value = {
    name,
    description: readText(body.description, 'Description', 1000, errors),
    eligibility: readText(body.eligibility, 'Eligibility', 500, errors),
    joining_fee: readFee(body.joiningFee ?? body.joining_fee, 'Joining fee', errors),
    annual_fee: readFee(body.annualFee ?? body.annual_fee, 'Annual subscription', errors),
    min_age: readAge(body.minAge ?? body.min_age, 'Minimum age', errors),
    max_age: readAge(body.maxAge ?? body.max_age, 'Maximum age', errors),
    sort_order: 0,
    active: body.active === undefined ? true : Boolean(body.active),
  };
  if (value.min_age !== null && value.max_age !== null && value.min_age > value.max_age) {
    errors.push('Minimum age cannot be above the maximum age');
  }
  const sort = body.sortOrder ?? body.sort_order;
  if (sort !== undefined && sort !== null && sort !== '') {
    const order = Number(sort);
    if (!Number.isInteger(order) || Math.abs(order) > 10000) errors.push('Sort order must be a whole number');
    else value.sort_order = order;
  }
  return { ok: errors.length === 0, errors, value };
}

/* ---------------------------------------------------------------------------
 * Serialising rows
 * ------------------------------------------------------------------------- */

const iso = (value) => (value ? new Date(value).toISOString() : null);
const money = (value) => (value === null || value === undefined ? null : Number(value));

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export function serialiseCategory(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    eligibility: row.eligibility ?? '',
    joiningFee: money(row.joining_fee) ?? 0,
    annualFee: money(row.annual_fee) ?? 0,
    minAge: row.min_age ?? null,
    maxAge: row.max_age ?? null,
    sortOrder: row.sort_order ?? 0,
    active: row.active !== false,
    applications: row.applications === undefined ? undefined : Number(row.applications),
  };
}

export function applicantName(row) {
  const first = row.first_name ?? row.firstName ?? '';
  const last = row.last_name ?? row.lastName ?? '';
  return `${first} ${last}`.trim();
}

export function serialiseApplication(row) {
  return {
    id: row.id,
    reference: row.reference,
    kind: row.kind ?? 'application',
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] ?? row.status,
    nextStatuses: nextStatuses(row.status),
    categoryId: row.category_id ?? null,
    categoryName: row.category_name ?? null,
    firstName: row.first_name ?? '',
    lastName: row.last_name ?? '',
    name: applicantName(row),
    email: row.email,
    phone: row.phone ?? '',
    dateOfBirth: dateOnly(row.date_of_birth),
    address: row.address ?? '',
    handicap: row.handicap ?? '',
    homeClub: row.home_club ?? '',
    proposer: row.proposer ?? '',
    seconder: row.seconder ?? '',
    message: row.message ?? '',
    enquirySummary: row.enquiry_summary ?? '',
    recommendedCategoryIds: Array.isArray(row.recommended_category_ids) ? row.recommended_category_ids.map(Number) : [],
    consent: Boolean(row.consent),
    sourceMessageId: row.source_message_id ?? null,
    staffNotes: row.staff_notes ?? '',
    decisionNote: row.decision_note ?? '',
    decidedBy: row.decided_by ?? null,
    decidedAt: iso(row.decided_at),
    submittedAt: iso(row.submitted_at),
    welcomedAt: iso(row.welcomed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function serialiseEvent(row) {
  return {
    id: row.id,
    event: row.event,
    label: describeEvent(row.event),
    actor: row.actor,
    note: row.note ?? '',
    createdAt: iso(row.created_at),
  };
}

const EVENT_LABELS = {
  enquired: 'Enquiry received',
  link_sent: 'Link sent',
  submitted: 'Application submitted',
  waitlisted: 'Joined the waitlist',
  invited: 'Invited to apply',
  note: 'Note',
};

const EMAIL_EVENT_LABELS = {
  membership_reply: 'Membership details sent',
  membership_closed: '“Applications closed” reply sent',
  membership_received: 'Application acknowledged',
  membership_waitlisted: 'Waitlist place confirmed',
  membership_under_review: '“Under review” email sent',
  membership_approved: 'Approval email sent',
  membership_declined: 'Decline email sent',
  membership_welcome: 'Welcome email sent',
  membership_invite: 'Invitation email sent',
};

export function describeEvent(event) {
  const text = String(event ?? '');
  if (EVENT_LABELS[text]) return EVENT_LABELS[text];
  if (text.startsWith('status:')) {
    const status = text.slice('status:'.length);
    return `Moved to ${STATUS_LABELS[status] ?? status}`;
  }
  if (text.startsWith('email:')) {
    const kind = text.slice('email:'.length);
    return EMAIL_EVENT_LABELS[kind] ?? `Email sent (${kind})`;
  }
  return text;
}

/* ---------------------------------------------------------------------------
 * Applicant emails
 * ------------------------------------------------------------------------- */

/** An amount in the club's currency: whole amounts without pennies. */
export function formatFee(amount, currency = BRAND.currency, locale = BRAND.locale) {
  const value = Number(amount) || 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** "Full membership: joining fee €2,500, annual subscription €1,850". */
export function describeCategoryFees(category, currency = BRAND.currency) {
  if (!category) return '';
  const joining = Number(category.joiningFee ?? category.joining_fee ?? 0);
  const annual = Number(category.annualFee ?? category.annual_fee ?? 0);
  const parts = [
    joining > 0 ? `joining fee ${formatFee(joining, currency)}` : 'no joining fee',
    `annual subscription ${formatFee(annual, currency)}`,
  ];
  return `${category.name}: ${parts.join(', ')}`;
}

/** What the applicant pays to start: the joining fee plus the first year's subscription. */
export function firstYearTotal(category) {
  if (!category) return 0;
  return (
    Number(category.joiningFee ?? category.joining_fee ?? 0) + Number(category.annualFee ?? category.annual_fee ?? 0)
  );
}

function firstNameOf(application) {
  const first = String(application?.firstName ?? application?.first_name ?? '')
    .trim()
    .split(/\s+/)[0];
  return first || 'there';
}

/**
 * The email an applicant receives when staff move their application on.
 *
 * kind: 'under_review' | 'approved' | 'declined' | 'welcomed' | 'invited'.
 * `settings` is the club's membership_settings; `link` the signed apply link
 * (invitations only); `note` what staff wrote on a decision, if anything.
 * Every value from outside is escaped in the HTML.
 */
export function buildMembershipEmail({
  kind,
  application,
  category = null,
  settings = {},
  link = null,
  note = '',
  currency = BRAND.currency,
  clubName = BRAND.fullName,
  env = process.env,
}) {
  const ref = application.reference;
  const first = firstNameOf(application);
  const committee = settings.committee_name || 'the Membership Committee';
  const contact = settings.contact_email || env.REPLY_TO_EMAIL || env.FROM_EMAIL || '';
  const said = String(note ?? '').trim();
  const fees = category ? describeCategoryFees(category, currency) : '';
  const contactLine = contact
    ? `If you have any questions in the meantime, just reply to this email or write to ${contact}.`
    : 'If you have any questions in the meantime, just reply to this email.';

  const copy = {
    under_review: {
      subject: `Your membership application is with ${committee} – ${clubName}`,
      heading: 'Your application is under review',
      lines: [
        `Thank you for applying to join ${clubName}. Your application (reference ${ref}) is now with ${committee}, who will consider it at their next meeting.`,
        fees ? { fee: 'You applied for' } : '',
        'You do not need to do anything else for now. We will email you as soon as the committee has reached a decision.',
        contactLine,
      ],
    },
    approved: {
      subject: `Your membership application has been approved – ${clubName}`,
      heading: 'Congratulations – your application has been approved',
      lines: [
        `We are delighted to tell you that ${committee} has approved your application to join ${clubName} (reference ${ref}).`,
        fees ? { fee: 'Your membership category is' } : '',
        said,
        category && firstYearTotal(category) > 0
          ? `To take up your membership, the amount due is ${formatFee(firstYearTotal(category), currency)} (joining fee and first annual subscription). We will send you payment details and your welcome pack shortly.`
          : 'We will be in touch shortly with your welcome pack and everything you need to get started.',
        settings.next_steps || '',
        contactLine,
      ],
    },
    declined: {
      subject: `About your membership application – ${clubName}`,
      heading: 'About your membership application',
      lines: [
        `Thank you for your interest in joining ${clubName} and for the time you took over your application (reference ${ref}).`,
        `After careful consideration, ${committee} is not able to offer you membership at this time.`,
        said,
        'We would be very happy to welcome you as a visitor in the meantime, and you are welcome to apply again in future.',
        contactLine,
      ],
    },
    welcomed: {
      subject: `Welcome to ${clubName}`,
      heading: `Welcome to ${clubName}!`,
      lines: [
        `It is a great pleasure to welcome you as a member of ${clubName}.`,
        fees ? { fee: 'Your membership is' } : '',
        category && firstYearTotal(category) > 0
          ? `Fees payable: ${formatFee(firstYearTotal(category), currency)} (joining fee and first annual subscription), if not already settled. Your membership starts as soon as they are received.`
          : 'Your membership starts straight away.',
        settings.next_steps ||
          'Our team will be in touch to arrange your locker, handicap transfer and a tour of the clubhouse.',
        contact
          ? `Questions about your membership? Write to ${contact} - we are always happy to help.`
          : 'Questions about your membership? Just reply to this email - we are always happy to help.',
        'We look forward to seeing you on the course.',
      ],
    },
    invited: {
      subject: `Membership applications are open – ${clubName}`,
      heading: 'You are invited to apply for membership',
      lines: [
        `Thank you for waiting. ${clubName} is now accepting membership applications, and as you are on our waitlist we would like to invite you to apply.`,
        fees ? { fee: 'You told us you were interested in' } : '',
        link
          ? 'Use the button below to complete your application - it only takes a few minutes, and you can choose the membership category that suits you best.'
          : 'Just reply to this email and we will send you an application form.',
        `Your reference is ${ref}.`,
        contactLine,
      ],
      cta: link ? { href: link, label: 'Apply for membership' } : null,
    },
  }[kind];
  if (!copy) throw new Error(`Unknown membership email: ${kind}`);

  const lines = copy.lines.filter(Boolean);
  const asText = (line) => (typeof line === 'string' ? line : `${line.fee} ${fees}.`);
  const text = [
    `Dear ${first},`,
    '',
    ...lines.flatMap((line) => [asText(line), '']),
    ...(copy.cta ? [`${copy.cta.label}: ${copy.cta.href}`, ''] : []),
    'Kind regards,',
    committee === 'the Membership Committee' ? `Membership, ${clubName}` : `${committee}, ${clubName}`,
  ].join('\n');

  const c = EMAIL_COLORS;
  const button = copy.cta
    ? `<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:6px 0 20px;"><tr><td bgcolor="${c.primary}" style="border-radius:6px;"><a href="${escapeHtml(copy.cta.href)}" style="display:inline-block;padding:12px 22px;color:#ffffff;font-weight:700;text-decoration:none;">${escapeHtml(copy.cta.label)}</a></td></tr></table>`
    : '';
  const feeBox = category
    ? `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:0 0 18px;border:1px solid ${c.rule};border-radius:6px;"><tr><td style="padding:14px 16px;">` +
      `<div style="font-weight:700;color:${c.primary};padding-bottom:4px;">${escapeHtml(category.name)}</div>` +
      `<div style="font-size:14px;color:${c.muted};">Joining fee ${escapeHtml(formatFee(category.joiningFee ?? category.joining_fee ?? 0, currency))} · Annual subscription ${escapeHtml(formatFee(category.annualFee ?? category.annual_fee ?? 0, currency))}</div>` +
      `</td></tr></table>`
    : '';
  const signOff =
    committee === 'the Membership Committee'
      ? `Membership<br>${escapeHtml(clubName)}`
      : `${escapeHtml(committee)}<br>${escapeHtml(clubName)}`;

  const html = brandedEmail(
    `<h2 style="margin:0 0 16px;font-size:20px;color:${c.primary};">${escapeHtml(copy.heading)}</h2>` +
      `<p style="margin:0 0 14px;">Dear ${escapeHtml(first)},</p>` +
      lines
        .map((line) =>
          typeof line === 'string'
            ? `<p style="margin:0 0 14px;white-space:pre-line;">${escapeHtml(line)}</p>`
            : `<p style="margin:0 0 8px;">${escapeHtml(line.fee)}:</p>${feeBox}`,
        )
        .join('') +
      button +
      `<p style="margin:0;">Kind regards,<br>${signOff}</p>`,
    { source: env },
  );

  return { subject: copy.subject, text, html };
}

/* ---------------------------------------------------------------------------
 * Export
 * ------------------------------------------------------------------------- */

export const CSV_COLUMNS = [
  ['Reference', (a) => a.reference],
  ['Status', (a) => a.statusLabel],
  ['Kind', (a) => a.kind],
  ['First name', (a) => a.firstName],
  ['Last name', (a) => a.lastName],
  ['Email', (a) => a.email],
  ['Phone', (a) => a.phone],
  ['Category', (a) => a.categoryName ?? ''],
  ['Date of birth', (a) => a.dateOfBirth ?? ''],
  ['Handicap', (a) => a.handicap],
  ['Home club', (a) => a.homeClub],
  ['Proposer', (a) => a.proposer],
  ['Seconder', (a) => a.seconder],
  ['Submitted', (a) => a.submittedAt ?? ''],
  ['Decided by', (a) => a.decidedBy ?? ''],
  ['Decided', (a) => a.decidedAt ?? ''],
  ['Welcomed', (a) => a.welcomedAt ?? ''],
  ['Created', (a) => a.createdAt ?? ''],
];
