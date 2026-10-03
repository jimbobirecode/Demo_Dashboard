/**
 * Reading a club's own tee sheet.
 *
 * Every club exports a different spreadsheet. The headers are whatever their
 * booking system calls things, the dates are in whatever format the person who
 * saved the file had set, and there is usually a blank row or a totals line at
 * the bottom. So this module is deliberately forgiving about *shape* and
 * completely unforgiving about *content*: it will find "Tee Date", "date" or
 * "Playing Date" for you, and it will refuse a row whose date it cannot read
 * rather than guess one.
 *
 * Everything here is pure — text in, rows and complaints out — so the parsing
 * can be tested against real-world nonsense without a database or a file.
 */
import { ALLOWED_STATUSES, normaliseStatus } from './bookings-domain.js';

/**
 * What each field can be called. Matched case-insensitively and ignoring
 * anything that is not a letter or a digit, so "Tee Date", "tee_date" and
 * "TEE DATE " are all the same header.
 */
export const COLUMN_ALIASES = {
  bookingId: ['bookingid', 'booking', 'bookingref', 'reference', 'ref', 'confirmationnumber', 'conf'],
  guestName: ['guestname', 'leadguest', 'name', 'customer', 'customername', 'player', 'lead', 'contactname'],
  guestEmail: ['guestemail', 'email', 'emailaddress', 'customeremail', 'contactemail'],
  contactPhone: ['phone', 'contactphone', 'telephone', 'tel', 'mobile', 'phonenumber'],
  date: ['teedate', 'date', 'playdate', 'playingdate', 'bookingdate', 'roundate', 'rounddate'],
  teeTime: ['teetime', 'time', 'starttime', 'tee'],
  players: ['players', 'playercount', 'golfers', 'pax', 'numberofplayers', 'partysize', 'qty', 'quantity'],
  total: ['total', 'totalgbp', 'amount', 'value', 'price', 'greenfee', 'greenfees', 'revenue', 'gross'],
  status: ['status', 'bookingstatus', 'state'],
  golfCourses: ['course', 'golfcourse', 'golfcourses', 'courses', 'coursename'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks', 'specialrequests'],
};

/** The two a row is useless without. */
export const REQUIRED_FIELDS = ['date'];

const normaliseHeader = (header) => String(header ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Work out which spreadsheet column holds which field.
 *
 * Returns the mapping *and* the headers it could not place, because a club
 * looking at "we ignored 3 of your columns" can tell at a glance whether that
 * was fine or whether their price column just went missing.
 */
export function mapColumns(headers) {
  const mapping = {};
  const used = new Set();

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = headers.findIndex(
      (header, position) => !used.has(position) && aliases.includes(normaliseHeader(header)),
    );
    if (index !== -1) {
      mapping[field] = index;
      used.add(index);
    }
  }

  return {
    mapping,
    unmapped: headers
      .map((header, position) => ({ header: String(header ?? '').trim(), position }))
      .filter((column) => !used.has(column.position) && column.header)
      .map((column) => column.header),
    missingRequired: REQUIRED_FIELDS.filter((field) => mapping[field] === undefined),
  };
}

/**
 * A date in whatever the club's spreadsheet felt like.
 *
 * `dayFirst` decides 03/04 — the UK reads it as 3 April, the US as 4 March, and
 * nothing in the file itself says which. It defaults to day-first because
 * these are UK golf clubs, and the importer reports the reading it used so a
 * club can see it got that wrong before committing anything.
 */
export function parseDate(value, { dayFirst = true } = {}) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toIso(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  const text = String(value ?? '').trim();
  if (!text) return null;

  // Already ISO.
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // 03/04/2026, 3-4-26, 03.04.2026
  const parts = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (parts) {
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    const year = fullYear(Number(parts[3]));
    // A value over 12 can only be the day, whatever the convention says.
    const [day, month] = a > 12 ? [a, b] : b > 12 ? [b, a] : dayFirst ? [a, b] : [b, a];
    return toIso(year, month, day);
  }

  // 3 April 2026 / April 3 2026 / 3 Apr 26
  const named = text.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{2,4})$/)
    ?? text.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (named) {
    const monthName = /^\d/.test(named[1]) ? named[2] : named[1];
    const day = Number(/^\d/.test(named[1]) ? named[1] : named[2]);
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) + 1;
    if (month) return toIso(fullYear(Number(named[3])), month, day);
  }

  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function fullYear(year) {
  if (year >= 1000) return year;
  // A two-digit year on a tee sheet is this century; a club is not uploading 1926.
  return 2000 + year;
}

function toIso(year, month, day) {
  if (!year || !month || !day || month > 12 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31 February rather than rolling it into March.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** '9:35', '0935', '9.35am', a spreadsheet's fractional day — all become '09:35 AM'. */
export function parseTeeTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return format12(value.getUTCHours(), value.getUTCMinutes());
  }

  // Excel stores a bare time as a fraction of a day.
  if (typeof value === 'number' && value > 0 && value < 1) {
    const minutes = Math.round(value * 24 * 60);
    return format12(Math.floor(minutes / 60), minutes % 60);
  }

  const text = String(value ?? '').trim();
  if (!text) return null;

  // The meridiem is optional: a UK tee sheet is usually 24-hour, and requiring
  // it silently dropped every "09:35" in the file.
  const match = text.match(/^(\d{1,2})[:.]?(\d{2})\s*(?:([ap])\.?m?\.?)?$/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minutes = Number(match[2]);
  if (hour > 23 || minutes > 59) return null;

  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'p' && hour < 12) hour += 12;
  if (meridiem === 'a' && hour === 12) hour = 0;

  return format12(hour, minutes);
}

function format12(hour, minutes) {
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(display).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

/** '£1,440.00', '1 440', '(120)' — a spreadsheet's idea of a number. */
export function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  const text = String(value ?? '').trim();
  if (!text) return null;

  const negative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[()]/g, '').replace(/[^0-9.,-]/g, '');
  if (!cleaned) return null;

  // 1.440,00 is European; 1,440.00 is not.
  const european = /,\d{2}$/.test(cleaned) && /\./.test(cleaned);
  const normalised = european
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(/,/g, '');

  const parsed = Number(normalised);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

/**
 * Turn the sheet into bookings, and say what was wrong with the rest.
 *
 * Nothing is written here. The caller shows this to somebody first, because an
 * import that silently drops a third of the file is worse than one that
 * refuses — and because a mis-read date column is invisible until you look at
 * the dates it produced.
 */
export function parseTeeSheet(rows, { dayFirst = true, defaultStatus = 'Booked' } = {}) {
  if (!rows.length) return empty('The file has no rows');

  const headers = rows[0].map((cell) => String(cell ?? '').trim());
  const { mapping, unmapped, missingRequired } = mapColumns(headers);

  if (missingRequired.length) {
    return empty(
      `Could not find a ${missingRequired.join(' or ')} column. Headers read: ${headers.filter(Boolean).join(', ') || '(none)'}`,
      { headers, unmapped },
    );
  }

  const value = (row, field) => (mapping[field] === undefined ? null : row[mapping[field]]);
  const bookings = [];
  const rejected = [];

  rows.slice(1).forEach((row, index) => {
    const line = index + 2; // what the spreadsheet calls this row
    if (!row.some((cell) => String(cell ?? '').trim())) return; // a blank spacer row

    const date = parseDate(value(row, 'date'), { dayFirst });
    if (!date) {
      rejected.push({ line, reason: `Could not read the date "${String(value(row, 'date') ?? '').trim()}"` });
      return;
    }

    const players = Math.trunc(Number(parseMoney(value(row, 'players')) ?? 0));
    const status = normaliseStatus(String(value(row, 'status') ?? '').trim() || defaultStatus);

    bookings.push({
      bookingId: String(value(row, 'bookingId') ?? '').trim() || null,
      guestName: String(value(row, 'guestName') ?? '').trim(),
      guestEmail: String(value(row, 'guestEmail') ?? '').trim().toLowerCase(),
      contactPhone: String(value(row, 'contactPhone') ?? '').trim(),
      date,
      teeTime: parseTeeTime(value(row, 'teeTime')),
      players: players > 0 ? players : 1,
      total: parseMoney(value(row, 'total')) ?? 0,
      status: ALLOWED_STATUSES.includes(status) ? status : defaultStatus,
      golfCourses: String(value(row, 'golfCourses') ?? '').trim(),
      notes: String(value(row, 'notes') ?? '').trim(),
      line,
    });
  });

  return {
    ok: true,
    error: null,
    headers,
    mapped: Object.keys(mapping),
    unmapped,
    bookings,
    rejected,
    dayFirst,
    // Shown before anything is written: if the club reads 3 April where the
    // sheet meant 4 March, this is where they see it.
    sample: bookings.slice(0, 5),
  };
}

/** Rows already in the database, so an upload can be run twice safely. */
export function markDuplicates(parsed, existing) {
  const byReference = new Set(existing.map((booking) => booking.bookingId).filter(Boolean));
  const bySlot = new Set(existing.map(slotKey));

  const fresh = [];
  const duplicates = [];

  for (const booking of parsed) {
    const seen =
      (booking.bookingId && byReference.has(booking.bookingId)) || bySlot.has(slotKey(booking));
    if (seen) duplicates.push(booking);
    else {
      fresh.push(booking);
      // A file that repeats a row inside itself is just as duplicated.
      if (booking.bookingId) byReference.add(booking.bookingId);
      bySlot.add(slotKey(booking));
    }
  }

  return { fresh, duplicates };
}

/** The same party, on the same day, at the same time is the same booking. */
function slotKey(booking) {
  return [
    String(booking.guestEmail ?? '').trim().toLowerCase(),
    booking.date ?? '',
    String(booking.teeTime ?? '').trim().toUpperCase(),
  ].join('|');
}

/** `IMP-20260923-8F2A` — one per upload, so a batch can be found again. */
export function mintBatchId(now = new Date(), random = Math.random) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Math.floor(random() * 0xffff).toString(16).toUpperCase().padStart(4, '0');
  return `IMP-${stamp}-${suffix}`;
}

/** A booking reference for a row whose sheet had none. */
export function mintImportedBookingId(batchId, line) {
  return `${batchId}-${String(line).padStart(4, '0')}`;
}

function empty(error, extra = {}) {
  return {
    ok: false, error, headers: [], mapped: [], unmapped: [],
    bookings: [], rejected: [], sample: [], dayFirst: true, ...extra,
  };
}
