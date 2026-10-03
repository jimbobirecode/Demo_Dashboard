/**
 * The waitlist: who is waiting for a tee time, and what became of them.
 *
 * Pure functions over serialised rows, so the conversion arithmetic — the
 * number this exists to produce — is unit-tested without a database.
 *
 * One idea runs through it. A waitlist entry is demand the club could not
 * satisfy at the moment it arrived, so every entry has exactly one honest
 * ending: it became a booking, it went away, or it is still open. Conversion
 * is measured against the entries that have *finished*, because an entry still
 * waiting has not failed to convert — it simply has not answered yet, and
 * counting it as a failure makes a healthy list look like a broken one.
 */
import { COMMITTED_STATUSES } from './operators-domain.js';
import { TERMINAL_STATUSES } from './bookings-domain.js';

/** The states the Streamlit waitlist used, kept so old rows still read. */
export const WAITLIST_STATUSES = ['Waiting', 'Notified', 'Converted', 'Cancelled'];

/** Still in play: the club may yet find these people a time. */
export const OPEN_STATUSES = ['Waiting', 'Notified'];

const COMMITTED = new Set(COMMITTED_STATUSES);
const TERMINAL = new Set(TERMINAL_STATUSES);

export function normaliseWaitlistStatus(status) {
  const text = String(status ?? '').trim();
  return WAITLIST_STATUSES.find((known) => known.toLowerCase() === text.toLowerCase()) ?? 'Waiting';
}

/** A `waitlist` row as the SPA wants it. */
export function serialiseWaitlistEntry(row) {
  const status = normaliseWaitlistStatus(row.status);
  return {
    id: row.id ?? null,
    waitlistId: row.waitlist_id,
    club: row.club ?? null,

    guestEmail: text(row.guest_email),
    guestName: text(row.guest_name),

    requestedDate: dateOnly(row.requested_date),
    preferredTime: text(row.preferred_time),
    timeFlexibility: text(row.time_flexibility),
    players: number(row.players),
    golfCourse: text(row.golf_course),

    status,
    priority: number(row.priority),
    notes: text(row.notes),

    notificationSent: Boolean(row.notification_sent),
    notificationSentAt: timestamp(row.notification_sent_at),

    // The link this whole report rests on.
    convertedBookingId: row.converted_booking_id ?? null,
    convertedAt: timestamp(row.converted_at),

    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),

    open: OPEN_STATUSES.includes(status),
  };
}

/**
 * Whole days from joining the list to converting. Null where either end is
 * missing — including the rows the old note-parsing backfill recovered, whose
 * conversion time is the booking's timestamp rather than a recorded event.
 */
export function daysToConvert(entry) {
  const joined = Date.parse(entry.createdAt ?? '');
  const converted = Date.parse(entry.convertedAt ?? '');
  if (Number.isNaN(joined) || Number.isNaN(converted) || converted < joined) return null;
  return Math.round((converted - joined) / 86_400_000);
}

/**
 * Waitlist → booking conversion.
 *
 * `bookings` is used only to value the conversions: an entry knows which
 * booking it became, and the booking knows what it was worth. A conversion
 * whose booking has since been cancelled is still a conversion — the waitlist
 * did its job — but its value is not counted as revenue, which is the same
 * rule the rest of the reports follow.
 */
export function buildWaitlistConversion(entries, bookings = []) {
  const byId = new Map(bookings.map((booking) => [booking.bookingId, booking]));

  const converted = entries.filter((entry) => entry.status === 'Converted');
  const cancelled = entries.filter((entry) => entry.status === 'Cancelled');
  const open = entries.filter((entry) => entry.open);

  // Settled = everything that has reached an ending. Open entries are excluded
  // from the rate rather than counted against it.
  const settled = converted.length + cancelled.length;

  const withBooking = converted
    .map((entry) => ({ entry, booking: byId.get(entry.convertedBookingId) }))
    .filter((pair) => pair.booking);

  const revenue = withBooking
    .filter((pair) => COMMITTED.has(pair.booking.status))
    .reduce((total, pair) => total + num(pair.booking.total), 0);

  const days = converted.map(daysToConvert).filter((value) => value !== null);

  // How well a notification actually works: of the entries the club told about
  // an opening, how many took it. The number that says whether chasing the
  // list is worth the staff time.
  const everNotified = entries.filter(
    (entry) => entry.notificationSent || entry.status === 'Notified' || entry.status === 'Converted',
  );
  const notifiedAndConverted = everNotified.filter((entry) => entry.status === 'Converted');

  return {
    entries: entries.length,
    open: open.length,
    converted: converted.length,
    cancelled: cancelled.length,
    settled,

    /** Of the entries that reached an ending, how many became a booking. */
    conversionRate: round1(settled ? (converted.length / settled) * 100 : 0),
    /** The same against every entry, which a part-worked list flatters. */
    conversionRateOfAll: round1(entries.length ? (converted.length / entries.length) * 100 : 0),
    notified: everNotified.length,
    notifiedConversionRate: round1(everNotified.length ? (notifiedAndConverted.length / everNotified.length) * 100 : 0),

    playersWaiting: sum(open, 'players'),
    playersConverted: sum(converted, 'players'),
    revenue: round2(revenue),

    /** Conversions the backfill could not value, so the revenue is a floor. */
    unlinked: converted.length - withBooking.length,

    medianDaysToConvert: median(days),
    byStatus: WAITLIST_STATUSES.map((status) => ({
      key: status,
      count: entries.filter((entry) => entry.status === status).length,
      players: sum(
        entries.filter((entry) => entry.status === status),
        'players',
      ),
    })),
  };
}

/**
 * The dates people ask for and do not get.
 *
 * A date with a long waitlist and few conversions is either a day worth
 * opening more tee times on, or one the club is losing parties on — which is
 * the same question the booking request report asks, from the other side.
 */
export function buildWaitlistDemand(entries, limit = 8) {
  const byDate = new Map();

  for (const entry of entries) {
    if (!entry.requestedDate) continue;
    const row = byDate.get(entry.requestedDate) ?? {
      key: entry.requestedDate,
      date: entry.requestedDate,
      entries: 0,
      players: 0,
      converted: 0,
      open: 0,
    };
    row.entries += 1;
    row.players += num(entry.players);
    if (entry.status === 'Converted') row.converted += 1;
    if (entry.open) row.open += 1;
    byDate.set(entry.requestedDate, row);
  }

  return [...byDate.values()]
    .map((row) => ({
      ...row,
      conversion: round1(row.entries ? (row.converted / row.entries) * 100 : 0),
      unmet: row.entries - row.converted,
    }))
    .sort((a, b) => b.players - a.players || b.entries - a.entries)
    .slice(0, limit);
}

/**
 * Waitlist entries that look like they already became a booking.
 *
 * Conversions only get a link when staff use the convert action. A time found
 * over the phone, or a party who rang the pro shop themselves, becomes a
 * booking with nothing tying it back — and the conversion rate under-reports
 * by exactly that much. This proposes the links so somebody can confirm them,
 * the same way unrecognised tour operators are proposed rather than assumed.
 *
 * Nothing here writes anything. A suggestion is evidence, not a conclusion:
 * two people can share an inbox, and a guest can be on the list for one date
 * while booking another under their own steam.
 */
export function suggestConversions(entries, bookings, { windowDays = 3 } = {}) {
  const open = entries.filter((entry) => entry.open && entry.guestEmail);
  if (!open.length) return [];

  // A booking already claimed by another entry is not evidence for this one.
  const claimed = new Set(entries.map((entry) => entry.convertedBookingId).filter(Boolean));

  const byEmail = new Map();
  for (const booking of bookings) {
    const email = String(booking.guestEmail ?? '')
      .trim()
      .toLowerCase();
    if (!email || claimed.has(booking.bookingId)) continue;
    if (TERMINAL.has(booking.status)) continue; // a cancelled booking converted nobody
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(booking);
  }

  const suggestions = [];

  for (const entry of open) {
    const candidates = byEmail.get(entry.guestEmail) ?? [];

    for (const booking of candidates) {
      const gap = dayGap(entry.requestedDate, booking.date);
      if (gap === null) continue;

      // Only a booking made *after* the entry joined the list can be the thing
      // that entry turned into; an earlier one is a different trip.
      if (bookedBefore(entry, booking)) continue;

      const confidence = gap === 0 ? 'exact' : Math.abs(gap) <= windowDays ? 'likely' : null;
      if (!confidence) continue;

      suggestions.push({
        key: `${entry.waitlistId}|${booking.bookingId}`,
        waitlistId: entry.waitlistId,
        bookingId: booking.bookingId,
        guestEmail: entry.guestEmail,
        guestName: entry.guestName || booking.guestName || '',
        confidence,
        // Said in words, because whoever confirms this is deciding whether to
        // believe it and a label alone does not tell them why.
        because:
          gap === 0
            ? `Booked ${booking.date}, the date they asked for`
            : `Booked ${booking.date}, ${Math.abs(gap)} day${Math.abs(gap) === 1 ? '' : 's'} ${gap > 0 ? 'after' : 'before'} the date they asked for`,
        requestedDate: entry.requestedDate,
        bookingDate: booking.date,
        dayGap: gap,
        waitlistPlayers: num(entry.players),
        bookingPlayers: num(booking.players),
        // A different party size is the most common reason a match is wrong.
        playersMatch: num(entry.players) === num(booking.players),
        bookingStatus: booking.status,
        total: round2(num(booking.total)),
      });
    }
  }

  const order = { exact: 0, likely: 1 };
  return suggestions.sort(
    (a, b) =>
      order[a.confidence] - order[b.confidence] ||
      Number(b.playersMatch) - Number(a.playersMatch) ||
      Math.abs(a.dayGap) - Math.abs(b.dayGap),
  );
}

/** Whole days from the requested date to the booked one; null if either is missing. */
function dayGap(requestedDate, bookingDate) {
  const from = Date.parse(`${requestedDate}T00:00:00Z`);
  const to = Date.parse(`${bookingDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/** Whether the booking predates the waitlist entry, so cannot have come from it. */
function bookedBefore(entry, booking) {
  const joined = Date.parse(entry.createdAt ?? '');
  const made = Date.parse(booking.timestamp ?? '');
  if (Number.isNaN(joined) || Number.isNaN(made)) return false;
  // A day's slack: a party can ring the same morning they are added.
  return made < joined - 86_400_000;
}

/** What a new entry has to carry. */
export function validateWaitlistEntry(input) {
  const errors = [];

  const guestEmail = String(input?.guestEmail ?? '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) errors.push('A valid email address is required');

  const requestedDate = String(input?.requestedDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) errors.push('A requested date is required');

  const players = Number(input?.players);
  if (!Number.isInteger(players) || players < 1 || players > 40) {
    errors.push('Players must be a whole number between 1 and 40');
  }

  const priority = Number(input?.priority ?? 5);
  if (!Number.isInteger(priority) || priority < 1 || priority > 10) {
    errors.push('Priority must be a whole number between 1 and 10');
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      guestEmail,
      guestName: String(input?.guestName ?? '').trim(),
      requestedDate,
      preferredTime: String(input?.preferredTime ?? '').trim(),
      timeFlexibility: String(input?.timeFlexibility ?? '').trim(),
      players,
      golfCourse: String(input?.golfCourse ?? '').trim(),
      priority,
      notes: String(input?.notes ?? '').trim(),
    },
  };
}

/** `WL-20260923-4F2A` — sortable by eye, and unique enough for a club. */
export function mintWaitlistId(now = new Date(), random = Math.random) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Math.floor(random() * 0xffff)
    .toString(16)
    .toUpperCase()
    .padStart(4, '0');
  return `WL-${stamp}-${suffix}`;
}

/* ---------- helpers ---------- */

const text = (value) => (value === null || value === undefined ? '' : String(value));
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const number = (value) => num(value);
const sum = (items, key) => items.reduce((total, item) => total + num(item[key]), 0);
const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function timestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
