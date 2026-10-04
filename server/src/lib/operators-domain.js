/**
 * Tour operators: who they are, how a booking is recognised as theirs, what
 * credit they trade on, and where the money sits.
 *
 * Everything here is pure — it takes serialised bookings and operator rows and
 * returns plain objects — so the identification rules, the derived due dates
 * and the ageing arithmetic are all testable without a database (`npm test`).
 *
 * Three ideas do the work:
 *
 *   identify()   one booking → the operator it belongs to, and on what evidence
 *   paymentState()  one booking + its operator's terms → what is owed and when
 *   summarise()  an operator + their bookings → exposure, ageing, credit headroom
 */
import { PIPELINE_STAGES, TERMINAL_STATUSES } from './bookings-domain.js';
import { BRAND } from './brand.js';
import { toCurrencyCode } from './currency.js';

/** Revenue and exposure only ever count bookings the club has committed to. */
export const COMMITTED_STATUSES = ['Booked'];

/** Statuses that still owe the operator an answer, so still owe a chase. */
export const UNCOMMITTED_STATUSES = ['Inquiry', 'Requested'];

/**
 * What somebody can set by hand. Whether a payment is *late* is never stored —
 * it is derived from the due date every time it is read, because a stored
 * "Overdue" is wrong the morning after it is written.
 */
/** 'Pending': a Stripe payment link has been emailed and not yet paid. */
export const PAYMENT_STATUSES = ['Unpaid', 'Pending', 'Deposit paid', 'Paid', 'Refunded', 'Written off'];

/** Neither owes money nor counts toward exposure. */
export const CLOSED_PAYMENT_STATUSES = ['Refunded', 'Written off'];

/** Money is only chased once the club has committed to the tee time. */
const CHASEABLE_STATUSES = COMMITTED_STATUSES;

/**
 * Domains that identify a person, not a business. A booking from one of these
 * is a direct guest however many of them there are, so they are never offered
 * as a new operator.
 *
 * This list also guards the tour operator portal. An operator's people may
 * sign in from any address on one of its email domains (a product
 * requirement: operators do not want to register every member of their
 * desk), and only club staff can add a domain to an operator — operators
 * cannot edit their own account. A free-mail domain typed onto an operator by
 * mistake would let anybody with a free address in, so these are refused for
 * domain sign-in however they got there. Err on the side of listing a domain:
 * the cost of a false positive is that one operator signs in with its
 * contact address instead.
 */
export const CONSUMER_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'outlook.co.uk',
  'live.com',
  'live.co.uk',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'btinternet.com',
  'sky.com',
  'virginmedia.com',
  'talktalk.net',
  'protonmail.com',
  'proton.me',
  'gmx.com',
  'gmx.co.uk',
  'mail.com',
  'yandex.com',
  'comcast.net',
  'verizon.net',
  'sbcglobal.net',
  'att.net',
  'cox.net',
  'shaw.ca',
  'rogers.com',
  'bigpond.com',
  'optusnet.com.au',
  'xtra.co.nz',

  // Privacy and paid personal mail.
  'pm.me',
  'protonmail.ch',
  'tutanota.com',
  'tutanota.de',
  'tutamail.com',
  'tuta.io',
  'tuta.com',
  'keemail.me',
  'fastmail.com',
  'fastmail.fm',
  'hey.com',
  'duck.com',
  'mailbox.org',
  'posteo.de',
  'posteo.net',
  'hushmail.com',
  'zoho.com',
  'zohomail.com',
  'zohomail.eu',
  'email.com',
  'usa.com',
  'inbox.com',
  'lycos.com',
  'rocketmail.com',
  'aim.com',
  'msn.co.uk',
  'windowslive.com',
  'passport.com',

  // UK and Ireland.
  'btopenworld.com',
  'ntlworld.com',
  'blueyonder.co.uk',
  'tiscali.co.uk',
  'virgin.net',
  'talk21.com',
  'plus.com',
  'eircom.net',
  'iol.ie',
  'vodafone.ie',

  // Continental Europe.
  'web.de',
  't-online.de',
  'freenet.de',
  'arcor.de',
  'gmx.de',
  'gmx.net',
  'gmx.at',
  'gmx.ch',
  'orange.fr',
  'wanadoo.fr',
  'free.fr',
  'sfr.fr',
  'laposte.net',
  'neuf.fr',
  'bbox.fr',
  'libero.it',
  'virgilio.it',
  'tin.it',
  'alice.it',
  'tiscali.it',
  'telefonica.net',
  'terra.es',
  'bluewin.ch',
  'telenet.be',
  'skynet.be',
  'ziggo.nl',
  'kpnmail.nl',
  'planet.nl',
  'hetnet.nl',
  'home.nl',
  'telia.com',
  'online.no',
  'seznam.cz',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  'onet.pl',
  'mail.ru',
  'inbox.ru',
  'list.ru',
  'bk.ru',
  'rambler.ru',
  'ya.ru',

  // North America and Oceania.
  'earthlink.net',
  'optonline.net',
  'charter.net',
  'frontier.com',
  'juno.com',
  'netzero.net',
  'rr.com',
  'telus.net',
  'sympatico.ca',
  'bell.net',
  'videotron.ca',
  'iinet.net.au',
  'tpg.com.au',
  'westnet.com.au',
  'internode.on.net',
  'telstra.com',
  'spark.co.nz',

  // Asia.
  'qq.com',
  'foxmail.com',
  '163.com',
  '126.com',
  'yeah.net',
  'sina.com',
  'sina.cn',
  'sohu.com',
  'aliyun.com',
  'naver.com',
  'daum.net',
  'hanmail.net',
  'rediffmail.com',
  'yahoo.co.jp',
]);

/**
 * Providers with a domain per country — yahoo.fr, hotmail.it, gmx.de,
 * outlook.com.au — matched by name rather than listed one by one. A domain
 * matches when the provider's name is followed by nothing but a country-style
 * suffix (`.fr`, `.co.uk`, `.com.br`), so `live.golfbreaks.com` is not caught
 * by "live".
 */
export const CONSUMER_DOMAIN_FAMILIES = [
  'gmail',
  'googlemail',
  'yahoo',
  'ymail',
  'hotmail',
  'outlook',
  'live',
  'msn',
  'windowslive',
  'aol',
  'gmx',
  'yandex',
  'fastmail',
  'tutanota',
  'proton',
  'protonmail',
  'icloud',
  'zoho',
  'zohomail',
  'mail',
  'orange',
  'wanadoo',
  'libero',
  'virgilio',
  'web',
  'rediffmail',
  'sina',
];

const COUNTRY_SUFFIX = /^((co|com|net|org|ne|or)\.)?[a-z]{2,3}$/;

export function isConsumerDomain(domain) {
  if (!domain) return false;
  const clean = String(domain).trim().toLowerCase();
  if (CONSUMER_EMAIL_DOMAINS.has(clean)) return true;

  const dot = clean.indexOf('.');
  if (dot === -1) return false;
  return CONSUMER_DOMAIN_FAMILIES.includes(clean.slice(0, dot)) && COUNTRY_SUFFIX.test(clean.slice(dot + 1));
}

/** How many bookings a domain needs before it is worth proposing. */
export const SUGGESTION_THRESHOLD = 2;

/** A `tour_operators` row as the SPA wants it. */
export function serialiseOperator(row) {
  return {
    id: row.id,
    club: row.club ?? null,
    name: text(row.name),
    contactName: text(row.contact_name),
    contactEmail: text(row.contact_email),
    contactPhone: text(row.contact_phone),
    accountCode: text(row.account_code),
    emailDomains: domainList(row.email_domains),

    paymentTermsDays: integer(row.payment_terms_days, 30),
    depositPercent: number(row.deposit_percent, 0),
    depositDueDaysBeforePlay: nullableInteger(row.deposit_due_days_before_play),
    balanceDueDaysBeforePlay: nullableInteger(row.balance_due_days_before_play),
    creditLimit: nullableNumber(row.credit_limit),
    // A row saved with "€" or a mangled symbol still reads as a real code.
    currency: toCurrencyCode(row.currency, BRAND.currency),

    onHold: Boolean(row.on_hold),
    active: row.active === undefined || row.active === null ? true : Boolean(row.active),
    notes: text(row.notes),

    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    updatedBy: text(row.updated_by),
  };
}

/**
 * The domain part of an email address, lowercased. `null` for anything that is
 * not one — enquiry rows carry some strange values.
 */
export function emailDomain(email) {
  if (!email) return null;
  const address = String(email)
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '')
    .replace(/^<|>$/g, '');
  const at = address.lastIndexOf('@');
  if (at === -1) return null;
  const domain = address
    .slice(at + 1)
    .replace(/[^a-z0-9.-]+$/, '')
    .replace(/\.+$/, '');
  return domain.includes('.') ? domain : null;
}

/**
 * A lookup built once per request and reused across every booking — matching
 * each booking against every operator in turn is O(bookings × operators), and
 * a busy season has thousands of the former.
 */
export function buildOperatorIndex(operators) {
  const byId = new Map();
  const byDomain = new Map();
  const byName = [];

  for (const operator of operators) {
    byId.set(operator.id, operator);

    for (const domain of operator.emailDomains) {
      // First registration of a domain wins, so a domain typed onto two
      // operators cannot make identification depend on row order.
      if (!byDomain.has(domain)) byDomain.set(domain, operator);
    }

    const needle = normaliseName(operator.name);
    // Two characters would match half the notes in the database.
    if (needle.length >= 4) byName.push({ needle, operator });
  }

  // Longest name first: "Golfbreaks Ireland" must win over "Golfbreaks".
  byName.sort((a, b) => b.needle.length - a.needle.length);

  return { byId, byDomain, byName, operators };
}

/**
 * Which operator a booking belongs to, and how confident that is.
 *
 * The three sources are deliberately ranked, because they are not equally
 * trustworthy: somebody tagged it, it came from a domain the operator books
 * from, or their name appears in the enquiry text. Only the first two are ever
 * acted on automatically — a name match is offered for confirmation, never
 * applied, because "Links Travel" turns up in plenty of prose that is not a
 * booking from Links Travel.
 */
export function identify(booking, index) {
  if (booking.tourOperatorId != null && index.byId.has(booking.tourOperatorId)) {
    return { operator: index.byId.get(booking.tourOperatorId), source: 'assigned', confidence: 1 };
  }

  const domain = emailDomain(booking.guestEmail);
  if (domain && index.byDomain.has(domain)) {
    return { operator: index.byDomain.get(domain), source: 'domain', confidence: 0.9 };
  }

  const haystack = normaliseName(`${booking.guestName ?? ''} ${booking.note ?? ''}`);
  if (haystack) {
    for (const { needle, operator } of index.byName) {
      if (containsWord(haystack, needle)) {
        return { operator, source: 'name', confidence: 0.5 };
      }
    }
  }

  return { operator: null, source: 'direct', confidence: 0 };
}

/** Every booking with the operator it was identified as belonging to. */
export function attachOperators(bookings, index) {
  return bookings.map((booking) => {
    const match = identify(booking, index);
    return {
      ...booking,
      operatorId: match.operator?.id ?? null,
      operatorName: match.operator?.name ?? null,
      operatorMatch: match.source,
      operatorConfidence: match.confidence,
    };
  });
}

/**
 * Trade domains the club is doing business with but has no account for.
 *
 * This is the "identify tour operators" step done from the data rather than
 * from memory: group the unrecognised bookings by sending domain, drop the
 * consumer mailboxes, and anything left that turns up more than once is a
 * business booking repeatedly — almost always an operator nobody has set up
 * yet. Volume and value come with it, so the biggest account gets opened first.
 */
export function suggestOperators(bookings, index, { threshold = SUGGESTION_THRESHOLD } = {}) {
  const groups = new Map();

  for (const booking of bookings) {
    const match = identify(booking, index);
    // A name match is a *suggestion of an existing* operator, and is offered on
    // the assignment screen instead; here it still counts as unrecognised, so
    // the domain is not quietly dropped from the list.
    if (match.source === 'assigned' || match.source === 'domain') continue;

    const domain = emailDomain(booking.guestEmail);
    if (!domain || isConsumerDomain(domain)) continue;

    if (!groups.has(domain)) {
      groups.set(domain, {
        domain,
        proposedName: nameFromDomain(domain),
        bookings: 0,
        players: 0,
        gross: 0,
        committedGross: 0,
        firstDate: null,
        lastDate: null,
        contacts: new Set(),
        existingOperator: match.operator?.name ?? null,
        bookingIds: [],
      });
    }

    const group = groups.get(domain);
    group.bookings += 1;
    group.players += Number(booking.players) || 0;
    group.gross += Number(booking.total) || 0;
    if (COMMITTED_STATUSES.includes(booking.status)) group.committedGross += Number(booking.total) || 0;
    if (booking.guestEmail) group.contacts.add(booking.guestEmail.trim().toLowerCase());
    if (booking.date) {
      if (!group.firstDate || booking.date < group.firstDate) group.firstDate = booking.date;
      if (!group.lastDate || booking.date > group.lastDate) group.lastDate = booking.date;
    }
    if (group.bookingIds.length < 50) group.bookingIds.push(booking.bookingId);
    if (!group.existingOperator && match.operator) group.existingOperator = match.operator.name;
  }

  return [...groups.values()]
    .filter((group) => group.bookings >= threshold)
    .map((group) => ({ ...group, contacts: [...group.contacts].slice(0, 5) }))
    .sort((a, b) => b.gross - a.gross || b.bookings - a.bookings);
}

/**
 * What a booking owes, and by when, under its operator's credit terms.
 *
 * Three things are derived rather than stored:
 *
 *   - the split between deposit and balance, from `deposit_percent`;
 *   - each due date, from the operator's terms unless the booking overrides it;
 *   - whether it is late, from the due date against today.
 *
 * Due dates come from whichever rule the operator has set. A "days before play"
 * rule wins, because that is what a tour operator contract actually says; with
 * no such rule the invoice terms apply (invoice date + `payment_terms_days`),
 * and with nothing invoiced yet the play date stands in for the invoice date —
 * a club that bills on departure still has a date to chase against.
 *
 * A direct booking with no operator gets the same treatment on `fallbackTerms`,
 * so the payment columns mean something before any operator exists.
 */
export function paymentState(booking, operator, { today, fallbackTerms = DEFAULT_TERMS } = {}) {
  const terms = operator ?? fallbackTerms;
  const gross = Number(booking.total) || 0;
  const paid = Number(booking.amountPaid) || 0;
  const status = normalisePaymentStatus(booking.paymentStatus);
  const closed = CLOSED_PAYMENT_STATUSES.includes(status);

  const depositAmount = round2((gross * clamp(terms.depositPercent ?? 0, 0, 100)) / 100);
  const balanceAmount = round2(gross - depositAmount);
  const outstanding = closed ? 0 : round2(Math.max(gross - paid, 0));

  const invoiceBase = booking.invoicedAt ?? booking.date ?? null;
  const fromInvoice = invoiceBase === null ? null : addDays(invoiceBase, integer(terms.paymentTermsDays, 30));

  const depositDue =
    booking.depositDueDate ??
    (terms.depositDueDaysBeforePlay != null && booking.date
      ? addDays(booking.date, -terms.depositDueDaysBeforePlay)
      : fromInvoice);

  const balanceDue =
    booking.balanceDueDate ??
    (terms.balanceDueDaysBeforePlay != null && booking.date
      ? addDays(booking.date, -terms.balanceDueDaysBeforePlay)
      : fromInvoice);

  // The next milestone that still has money against it. A deposit already
  // covered by what has been paid is behind us, whatever the stored status says.
  const depositSettled = depositAmount === 0 || paid + 0.005 >= depositAmount;
  const stage = closed || outstanding === 0 ? null : depositSettled ? 'balance' : 'deposit';
  const dueDate = stage === 'deposit' ? depositDue : stage === 'balance' ? balanceDue : null;
  const dueAmount =
    stage === 'deposit' ? round2(Math.max(depositAmount - paid, 0)) : stage === 'balance' ? outstanding : 0;

  const daysOverdue = dueDate && today && dueDate < today ? daysBetween(dueDate, today) : 0;
  const daysUntilDue = dueDate && today && dueDate >= today ? daysBetween(today, dueDate) : 0;

  return {
    gross,
    paid: round2(paid),
    outstanding,
    depositAmount,
    balanceAmount,
    depositDueDate: depositDue,
    balanceDueDate: balanceDue,
    /** Which milestone the money is sitting at: 'deposit', 'balance' or null. */
    stage,
    dueDate,
    dueAmount,
    daysOverdue,
    daysUntilDue,
    overdue: daysOverdue > 0,
    status,
    /** What the status *would* be from the money alone, for the "check me" hint. */
    derivedStatus: closed ? status : deriveStatus({ gross, paid, depositAmount }),
    settled: closed || outstanding === 0,
    // A booking nobody has committed to is not chased for money; the enquiry
    // is chased instead, which is the other reminder campaign's job.
    chaseable: CHASEABLE_STATUSES.includes(booking.status) && outstanding > 0,
  };
}

/** The terms a booking with no operator is read under. */
export const DEFAULT_TERMS = {
  paymentTermsDays: 30,
  depositPercent: 0,
  depositDueDaysBeforePlay: null,
  balanceDueDaysBeforePlay: null,
  creditLimit: null,
};

/** The payment status the money implies, ignoring whatever was typed in. */
export function deriveStatus({ gross, paid, depositAmount }) {
  if (gross > 0 && paid + 0.005 >= gross) return 'Paid';
  if (paid > 0.005 && depositAmount > 0 && paid + 0.005 >= depositAmount) return 'Deposit paid';
  if (paid > 0.005) return 'Deposit paid';
  return 'Unpaid';
}

export function normalisePaymentStatus(status) {
  if (!status) return 'Unpaid';
  const text = String(status).trim().toLowerCase();
  return PAYMENT_STATUSES.find((known) => known.toLowerCase() === text) ?? 'Unpaid';
}

/** Debtor-ageing bands, in the order a statement prints them. */
export const AGEING_BANDS = [
  { id: 'current', label: 'Not yet due', min: null, max: 0 },
  { id: 'd1_30', label: '1–30 days', min: 1, max: 30 },
  { id: 'd31_60', label: '31–60 days', min: 31, max: 60 },
  { id: 'd61_90', label: '61–90 days', min: 61, max: 90 },
  { id: 'd90_plus', label: 'Over 90 days', min: 91, max: null },
];

export function ageingBand(daysOverdue) {
  if (!daysOverdue || daysOverdue <= 0) return 'current';
  return AGEING_BANDS.find(
    (band) => band.min !== null && daysOverdue >= band.min && (band.max === null || daysOverdue <= band.max),
  ).id;
}

/**
 * One operator's account: their book, their exposure and how old the debt is.
 *
 * Exposure counts only committed bookings, on the same rule the analytics page
 * uses for revenue — an open enquiry is not money the operator owes, and
 * counting it would put accounts over their credit limit on the strength of
 * business the club has not agreed to.
 */
export function summarise(operator, bookings, { today, includeStatuses = COMMITTED_STATUSES } = {}) {
  const ageing = Object.fromEntries(AGEING_BANDS.map((band) => [band.id, 0]));
  const byStatus = Object.fromEntries([...PIPELINE_STAGES, ...TERMINAL_STATUSES].map((s) => [s, 0]));

  let gross = 0;
  let committedGross = 0;
  let paid = 0;
  let outstanding = 0;
  let overdueAmount = 0;
  let overdueCount = 0;
  let oldestDueDate = null;
  let maxDaysOverdue = 0;
  let players = 0;
  let nextPlayDate = null;
  let unconfirmed = 0;

  for (const booking of bookings) {
    const state = paymentState(booking, operator, { today });
    gross += state.gross;
    players += Number(booking.players) || 0;
    if (byStatus[booking.status] !== undefined) byStatus[booking.status] += 1;
    if (UNCOMMITTED_STATUSES.includes(booking.status)) unconfirmed += 1;
    if (booking.date && booking.date >= today && !TERMINAL_STATUSES.includes(booking.status)) {
      if (!nextPlayDate || booking.date < nextPlayDate) nextPlayDate = booking.date;
    }

    if (!includeStatuses.includes(booking.status)) continue;

    committedGross += state.gross;
    paid += state.paid;
    outstanding += state.outstanding;
    if (state.outstanding > 0) {
      ageing[ageingBand(state.daysOverdue)] += state.outstanding;
      if (state.overdue) {
        overdueAmount += state.outstanding;
        overdueCount += 1;
        maxDaysOverdue = Math.max(maxDaysOverdue, state.daysOverdue);
        if (!oldestDueDate || state.dueDate < oldestDueDate) oldestDueDate = state.dueDate;
      }
    }
  }

  const creditLimit = operator?.creditLimit ?? null;
  const headroom = creditLimit === null ? null : round2(creditLimit - outstanding);

  return {
    operatorId: operator?.id ?? null,
    operatorName: operator?.name ?? 'Direct bookings',
    bookings: bookings.length,
    players,
    byStatus,
    unconfirmed,
    nextPlayDate,
    gross: round2(gross),
    committedGross: round2(committedGross),
    paid: round2(paid),
    outstanding: round2(outstanding),
    overdueAmount: round2(overdueAmount),
    overdueCount,
    oldestDueDate,
    maxDaysOverdue,
    ageing: Object.fromEntries(Object.entries(ageing).map(([key, value]) => [key, round2(value)])),
    creditLimit,
    headroom,
    /** Past the limit, or trading while suspended: both stop new business. */
    overLimit: headroom !== null && headroom < 0,
    onHold: Boolean(operator?.onHold),
    /** How much of the limit is used, as a percentage; null with no limit. */
    creditUsedPercent: creditLimit && creditLimit > 0 ? Math.round((outstanding / creditLimit) * 100) : null,
  };
}

/** Every operator's account, plus the unassigned bookings as one pseudo-account. */
export function summariseAll(operators, bookings, { today } = {}) {
  const index = buildOperatorIndex(operators);
  const groups = new Map(operators.map((operator) => [operator.id, []]));
  const direct = [];

  for (const booking of bookings) {
    const match = identify(booking, index);
    // A name-only match is a guess; it must not silently move money onto an
    // account, so those bookings stay with the direct pile until somebody
    // assigns them.
    if (match.operator && match.source !== 'name') groups.get(match.operator.id).push(booking);
    else direct.push(booking);
  }

  return {
    operators: operators.map((operator) => summarise(operator, groups.get(operator.id), { today })),
    direct: summarise(null, direct, { today }),
    groups,
    index,
  };
}

/** A club-wide roll-up of what the trade owes. */
export function portfolioTotals(summaries) {
  const totals = {
    operators: summaries.length,
    bookings: 0,
    committedGross: 0,
    paid: 0,
    outstanding: 0,
    overdueAmount: 0,
    overdueCount: 0,
    unconfirmed: 0,
    overLimit: 0,
    onHold: 0,
    ageing: Object.fromEntries(AGEING_BANDS.map((band) => [band.id, 0])),
  };

  for (const summary of summaries) {
    totals.bookings += summary.bookings;
    totals.committedGross += summary.committedGross;
    totals.paid += summary.paid;
    totals.outstanding += summary.outstanding;
    totals.overdueAmount += summary.overdueAmount;
    totals.overdueCount += summary.overdueCount;
    totals.unconfirmed += summary.unconfirmed;
    if (summary.overLimit) totals.overLimit += 1;
    if (summary.onHold) totals.onHold += 1;
    for (const band of AGEING_BANDS) totals.ageing[band.id] += summary.ageing[band.id];
  }

  for (const key of ['committedGross', 'paid', 'outstanding', 'overdueAmount']) {
    totals[key] = round2(totals[key]);
  }
  for (const band of AGEING_BANDS) totals.ageing[band.id] = round2(totals.ageing[band.id]);

  return totals;
}

/** Why an operator cannot be saved, or null when it can. */
export function validateOperator(input) {
  if (!input || typeof input !== 'object') return 'No operator supplied';
  if (!text(input.name).trim()) return 'Name is required';
  if (input.contactEmail && !String(input.contactEmail).includes('@')) {
    return 'Contact email is not an address';
  }

  const percent = Number(input.depositPercent ?? 0);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return 'Deposit percent must be between 0 and 100';
  }

  const termsDays = Number(input.paymentTermsDays ?? 30);
  if (!Number.isInteger(termsDays) || termsDays < 0 || termsDays > 365) {
    return 'Payment terms must be a whole number of days between 0 and 365';
  }

  for (const field of ['depositDueDaysBeforePlay', 'balanceDueDaysBeforePlay']) {
    const value = input[field];
    if (value === null || value === undefined || value === '') continue;
    const days = Number(value);
    if (!Number.isInteger(days) || days < 0 || days > 365) {
      return `${field === 'depositDueDaysBeforePlay' ? 'Deposit' : 'Balance'} lead time must be a whole number of days between 0 and 365`;
    }
  }

  if (input.creditLimit !== null && input.creditLimit !== undefined && input.creditLimit !== '') {
    const limit = Number(input.creditLimit);
    if (!Number.isFinite(limit) || limit < 0) return 'Credit limit cannot be negative';
  }

  if (nullableText(input.currency) && !toCurrencyCode(input.currency)) {
    return `"${input.currency}" is not a currency - use a code such as EUR, GBP or USD`;
  }

  for (const domain of domainList(input.emailDomains)) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return `"${domain}" is not a domain name`;
  }

  return null;
}

/** A human sentence for an operator's terms — used on screen and in email. */
export function describeTerms(operator) {
  if (!operator) return 'No account terms';
  const parts = [];

  if (operator.depositPercent > 0) {
    parts.push(
      `${operator.depositPercent}% deposit${
        operator.depositDueDaysBeforePlay != null ? ` due ${operator.depositDueDaysBeforePlay} days before play` : ''
      }`,
    );
  }

  if (operator.balanceDueDaysBeforePlay != null) {
    parts.push(`balance due ${operator.balanceDueDaysBeforePlay} days before play`);
  }

  parts.push(operator.paymentTermsDays === 0 ? 'payable on invoice' : `net ${operator.paymentTermsDays} days`);

  if (operator.creditLimit != null) {
    parts.push(`credit limit ${formatAccountMoney(operator.creditLimit, operator.currency)}`);
  }

  const sentence = parts.join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Normalises whatever the form sent into the column shapes the table wants. */
export function toOperatorColumns(input) {
  return {
    name: text(input.name).trim(),
    contact_name: nullableText(input.contactName),
    contact_email: nullableText(input.contactEmail)?.toLowerCase() ?? null,
    contact_phone: nullableText(input.contactPhone),
    account_code: nullableText(input.accountCode),
    email_domains: domainList(input.emailDomains),
    payment_terms_days: integer(input.paymentTermsDays, 30),
    deposit_percent: clamp(Number(input.depositPercent ?? 0), 0, 100),
    deposit_due_days_before_play: nullableInteger(input.depositDueDaysBeforePlay),
    balance_due_days_before_play: nullableInteger(input.balanceDueDaysBeforePlay),
    credit_limit: nullableNumber(input.creditLimit),
    currency: toCurrencyCode(input.currency, BRAND.currency),
    on_hold: Boolean(input.onHold),
    active: input.active === undefined ? true : Boolean(input.active),
    notes: nullableText(input.notes),
  };
}

/** Money in the account's own currency — an operator may not be billed in GBP. */
export function formatAccountMoney(value, currency = BRAND.currency) {
  const amount = Number(value);
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: toCurrencyCode(currency, BRAND.currency),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number.isFinite(amount) ? amount : 0);
}

// --- small shared helpers ---------------------------------------------------

/**
 * `email_domains` is TEXT[] on a migrated install, but the form sends a comma
 * separated string and older hand-made rows sometimes hold one too.
 */
export function domainList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,;\s]+/);
  const seen = new Set();
  for (const entry of raw) {
    const domain = String(entry ?? '')
      .trim()
      .toLowerCase()
      .replace(/^@/, '')
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (domain) seen.add(domain);
  }
  return [...seen];
}

/** 'Golfbreaks' from 'golfbreaks.com'. A starting point, not a decision. */
export function nameFromDomain(domain) {
  const label = String(domain).split('.')[0].replace(/[-_]+/g, ' ');
  return label
    .split(' ')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Whole days from one ISO date to another; negative if `to` is earlier. */
export function daysBetween(from, to) {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

function normaliseName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Whole-word containment, so "Links" does not match "cufflinks". */
function containsWord(haystack, needle) {
  const index = haystack.indexOf(needle);
  if (index === -1) return false;
  const before = index === 0 ? ' ' : haystack[index - 1];
  const after = haystack[index + needle.length] ?? ' ';
  return before === ' ' && after === ' ';
}

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

function nullableText(value) {
  const out = text(value).trim();
  return out === '' ? null : out;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function nullableInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function timestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);
}

/** Money, kept off binary-fraction drift when many rows are added up. */
function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
