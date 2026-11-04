/**
 * Changing a booking by hand, and taking one by hand.
 *
 * Two things the desk does every day that the dashboard could not: move a
 * party to another date, or from eight to twelve, without editing the row in
 * the database; and enter a booking that came in over the phone or at the
 * counter, so it can be paid for and climb the same ladder of emails as one
 * the email bot took.
 *
 * Both are validated here, apart from the routes, so the rules can be tested
 * without a database and read in one place.
 */
import crypto from 'node:crypto';
import { BRAND } from './brand.js';
import { BOOKING_REF_PATTERN, datePart } from './booking-ref.js';

/** Statuses a booking may be taken at. Rejected and Cancelled are not new bookings. */
export const NEW_BOOKING_STATUSES = ['Booked', 'Requested', 'Inquiry'];

/** Where a booking taken by hand came from: the `source` column, as the desk names it. */
export const NEW_BOOKING_SOURCES = { phone: 'Phone', walk_in: 'In person', email: 'Email to the office' };

const EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PLAYERS = 200;
const MAX_TOTAL = 1_000_000;

const round2 = (value) => Math.round(value * 100) / 100;

/** A real calendar date in YYYY-MM-DD, or null. 2027-02-30 is not one. */
function calendarDate(value) {
  const text = String(value ?? '').trim();
  if (!ISO_DATE.test(text)) return null;
  const parsed = new Date(`${text}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
}

/**
 * The fields the desk may change, each with the column it lives in and how a
 * value from the form is read. A parser returns `{ value }` or `{ error }`.
 */
const FIELDS = {
  date: {
    column: 'date',
    label: 'Date',
    parse(raw) {
      const date = calendarDate(raw);
      return date ? { value: date } : { error: 'Date must be a real date, as YYYY-MM-DD' };
    },
  },
  teeTime: {
    column: 'tee_time',
    label: 'Tee time',
    parse(raw) {
      const text = String(raw ?? '').trim();
      if (text.length > 40) return { error: 'Tee time is too long' };
      // An empty tee time is a booking whose time is still to be fixed,
      // which the rest of the app already reads as "Not Specified".
      return { value: text || 'Not Specified' };
    },
  },
  players: {
    column: 'players',
    label: 'Players',
    parse(raw) {
      const players = Number(raw);
      return Number.isInteger(players) && players >= 1 && players <= MAX_PLAYERS
        ? { value: players }
        : { error: `Players must be a whole number from 1 to ${MAX_PLAYERS}` };
    },
  },
  total: {
    column: 'total',
    label: 'Total',
    parse(raw) {
      const total = Number(raw);
      return Number.isFinite(total) && total >= 0 && total <= MAX_TOTAL
        ? { value: round2(total) }
        : { error: 'Total must be an amount of money, 0 or more' };
    },
  },
  guestName: {
    column: 'guest_name',
    label: 'Lead guest',
    parse(raw) {
      const text = String(raw ?? '').trim();
      return text.length > 200 ? { error: 'Lead guest name is too long' } : { value: text };
    },
  },
  guestEmail: {
    column: 'guest_email',
    label: 'Email',
    parse(raw) {
      const text = String(raw ?? '')
        .trim()
        .toLowerCase();
      if (!text) return { value: '' };
      return EMAIL.test(text) ? { value: text } : { error: 'That email address does not look right' };
    },
  },
  contactPhone: {
    column: 'contact_phone',
    label: 'Phone',
    parse(raw) {
      const text = String(raw ?? '').trim();
      return text.length > 40 ? { error: 'Phone number is too long' } : { value: text };
    },
  },
  specialRequests: {
    column: 'special_requests',
    label: 'Special requests',
    parse(raw) {
      const text = String(raw ?? '').trim();
      return text.length > 2000 ? { error: 'Special requests are too long' } : { value: text };
    },
  },
};

export const EDITABLE_FIELDS = Object.keys(FIELDS);

/** The column each editable field is stored in, for the route's UPDATE. */
export const columnFor = (field) => FIELDS[field]?.column;

/** The per-player price a booking was taken at, or null where it cannot be told. */
export function pricePerPlayer(booking) {
  const players = Number(booking?.players);
  const total = Number(booking?.total);
  return players > 0 && Number.isFinite(total) ? round2(total / players) : null;
}

/**
 * What an edit changes, checked against the booking as it stands.
 *
 * Only fields that differ from the current value are returned, so a form that
 * sends everything back does not stamp an edit on fields nobody touched.
 *
 * A change of party size reprices the booking at the price per player it was
 * taken at — eight at EUR 325 who become twelve are twelve at EUR 325 — unless
 * the form also sends a total, which then stands as typed. The response says
 * which happened, so nobody is surprised by the new figure.
 *
 * `warnings` are not refusals. They are the consequences somebody should see
 * before the guest does: a payment link already sent for the old amount, or a
 * new total below what has already been paid.
 */
export function validateBookingEdit(body, current) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!input) return { ok: false, changes: {}, errors: ['Nothing to change'], warnings: [] };

  const errors = [];
  const changes = {};
  for (const [field, raw] of Object.entries(input)) {
    if (!(field in FIELDS)) {
      errors.push(`${field} cannot be changed here`);
      continue;
    }
    const parsed = FIELDS[field].parse(raw);
    if (parsed.error) {
      errors.push(parsed.error);
      continue;
    }
    if (!sameValue(parsed.value, current?.[field])) changes[field] = parsed.value;
  }

  // Repricing: a new party size with no total of its own.
  let repriced = null;
  if ('players' in changes && !('total' in input)) {
    const each = pricePerPlayer(current);
    if (each !== null) {
      const total = round2(each * changes.players);
      if (!sameValue(total, current?.total)) changes.total = total;
      repriced = { pricePerPlayer: each, from: Number(current?.total) || 0, to: total };
    }
  }

  // A booking somebody can reach is the point of entering it at all.
  const email = 'guestEmail' in changes ? changes.guestEmail : current?.guestEmail;
  const phone = 'contactPhone' in changes ? changes.contactPhone : current?.contactPhone;
  if (!email && !phone) errors.push('A booking needs an email address or a phone number');

  if (errors.length) return { ok: false, changes: {}, errors, warnings: [], repriced: null };
  if (!Object.keys(changes).length) return { ok: false, changes: {}, errors: ['Nothing has changed'], warnings: [] };

  return { ok: true, changes, errors: [], warnings: editWarnings(changes, current), repriced };
}

/** The consequences of an edit somebody should see before the guest does. */
export function editWarnings(changes, current) {
  const warnings = [];
  const total = 'total' in changes ? changes.total : Number(current?.total) || 0;
  const paid = Number(current?.amountPaid) || 0;
  const linkAmount = current?.paymentLinkAmount == null ? null : Number(current.paymentLinkAmount);

  if ('total' in changes && current?.paymentLinkUrl && linkAmount !== null && paid < 0.005) {
    warnings.push(
      `The payment link already sent asks for ${money(linkAmount)}. ` +
        'It still works, so send a new one from Payment if that figure is no longer right.',
    );
  }
  if ('total' in changes && paid > total + 0.005) {
    warnings.push(`${money(paid)} has already been paid, which is more than the new total of ${money(total)}.`);
  }
  if ('date' in changes && current?.date && changes.date !== current.date) {
    warnings.push(
      'The reminder and arrival emails follow the new date. Any that have already gone are not sent again.',
    );
  }
  if ('guestEmail' in changes && !changes.guestEmail) {
    warnings.push('With no email address, nothing on the booking ladder can reach this booking.');
  }
  return warnings;
}

/**
 * A booking taken by hand.
 *
 * The desk gives a date, a party, a price and a way to reach them; the rest
 * is optional. The price is given per player — that is how a golf club quotes
 * one — and the total is worked out from it, unless a total is given
 * outright, which then stands.
 *
 * `today` refuses a booking for a day already gone: taking one is a promise of
 * a tee time, and the past has no tee times left. Correcting the date of an
 * old booking is an edit, which is allowed.
 */
export function validateNewBooking(body, { today, operators = [] } = {}) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = [];
  const value = {};

  for (const field of ['date', 'teeTime', 'players', 'guestName', 'guestEmail', 'contactPhone', 'specialRequests']) {
    if (input[field] === undefined) continue;
    const parsed = FIELDS[field].parse(input[field]);
    if (parsed.error) errors.push(parsed.error);
    else value[field] = parsed.value;
  }

  if (!value.date && !errors.some((error) => error.startsWith('Date'))) errors.push('A date is required');
  if (value.date && today && value.date < today) errors.push('That date has already passed');
  if (value.players === undefined && !errors.some((error) => error.startsWith('Players'))) {
    errors.push('The number of players is required');
  }
  if (!value.guestEmail && !value.contactPhone) errors.push('An email address or a phone number is required');
  if (!value.guestName && !value.guestEmail) errors.push('A name or an email address is required');

  // The price: a total outright, or a price per player to work it out from.
  const each = input.pricePerPlayer === undefined || input.pricePerPlayer === '' ? null : Number(input.pricePerPlayer);
  const outright = input.total === undefined || input.total === '' ? null : Number(input.total);
  if (outright !== null) {
    const parsed = FIELDS.total.parse(outright);
    if (parsed.error) errors.push(parsed.error);
    else value.total = parsed.value;
  } else if (each !== null) {
    if (!Number.isFinite(each) || each < 0 || each > MAX_TOTAL) errors.push('Price per player must be an amount');
    else if (value.players) value.total = round2(each * value.players);
  } else {
    errors.push('A price per player, or a total, is required');
  }

  const status = input.status === undefined ? 'Booked' : String(input.status);
  if (!NEW_BOOKING_STATUSES.includes(status)) errors.push(`A booking cannot be taken as ${status}`);
  value.status = status;

  const source = input.source === undefined ? 'phone' : String(input.source);
  if (!(source in NEW_BOOKING_SOURCES)) errors.push('Say whether this came by phone, in person or by email');
  value.source = source;

  if (input.operatorId !== undefined && input.operatorId !== null && input.operatorId !== '') {
    const id = Number(input.operatorId);
    const operator = operators.find((entry) => entry.id === id);
    if (!operator) errors.push('That tour operator is not one of this club’s accounts');
    else value.operatorId = id;
  }

  const note = String(input.note ?? '').trim();
  if (note.length > 5000) errors.push('The note is too long');
  value.note = note;

  return errors.length ? { ok: false, value: {}, errors } : { ok: true, value, errors: [] };
}

/**
 * A reference for a booking the desk takes, in the email bot's own format:
 * BOOK-YYYYMMDD-XXXXXXXX, eight hex characters.
 *
 * Not the dashboard's other format (`mintBookingReference`). The bot links a
 * guest's reply to its booking by finding `BOOK-\d{8}-[A-F0-9]{8}` in the
 * email, so a booking taken by phone under any other shape would lose every
 * reply the guest sends about it.
 */
export function mintDeskReference({
  now = new Date(),
  timeZone = BRAND.timeZone,
  randomBytes = crypto.randomBytes,
} = {}) {
  const reference = `BOOK-${datePart(now, timeZone)}-${randomBytes(4).toString('hex').toUpperCase()}`;
  if (!BOOKING_REF_PATTERN.test(reference)) throw new Error(`Minted a reference in the wrong shape: ${reference}`);
  return reference;
}

function sameValue(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return Math.abs(Number(a) - Number(b)) < 0.005;
  return String(a ?? '') === String(b ?? '');
}

function money(amount) {
  return new Intl.NumberFormat(BRAND.locale, { style: 'currency', currency: BRAND.currency }).format(amount);
}
