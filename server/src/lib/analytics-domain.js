/**
 * Every aggregation the Reports & Analytics page reads.
 *
 * Pure functions over already-serialised bookings, so the route stays thin and
 * the arithmetic is testable without a database. Each exported builder answers
 * one question the golf office actually asks; `buildAnalytics` composes them.
 */
import { PIPELINE_STAGES, TERMINAL_STATUSES, normaliseStatus } from './bookings-domain.js';
import { BRAND } from './brand.js';
import {
  AGEING_BANDS,
  CLOSED_PAYMENT_STATUSES,
  PAYMENT_STATUSES,
  ageingBand,
  emailDomain,
  isConsumerDomain,
  normalisePaymentStatus,
} from './operators-domain.js';

/** Revenue is only counted once a booking is actually committed. */
const COMMITTED = new Set(['Booked']);

/**
 * A booking that came through the enquiry pipeline.
 *
 * A tee sheet uploaded from the club's own system is real play and belongs in
 * every report about what happens on the course — but it was never an enquiry,
 * so counting it in the funnel, the conversion rate, the request grid or the
 * response times would credit TeeMail with work it did not do. Those four ask
 * this first; everything else counts every booking.
 */
export function isEnquiry(booking) {
  return (booking.source ?? 'teemail') !== 'imported';
}

const enquiriesOnly = (bookings) => bookings.filter(isEnquiry);

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Monday-first, the way a tee sheet is read. */
export const WEEK_ORDER = [...DAY_NAMES.slice(1), DAY_NAMES[0]];

export const GRANULARITIES = ['day', 'week', 'month'];

/** Ordered buckets, so the axis reads low to high rather than by frequency. */
export const LEAD_TIME_BUCKETS = [
  { key: '0–7 days', max: 7 },
  { key: '8–14 days', max: 14 },
  { key: '15–30 days', max: 30 },
  { key: '31–60 days', max: 60 },
  { key: '61–90 days', max: 90 },
  { key: '91–180 days', max: 180 },
  { key: '180+ days', max: Infinity },
];

export const PARTY_SIZE_BUCKETS = [
  { key: 'Single', min: 1, max: 1 },
  { key: 'Pair', min: 2, max: 2 },
  { key: '3-ball', min: 3, max: 3 },
  { key: '4-ball', min: 4, max: 4 },
  { key: '5–8', min: 5, max: 8 },
  { key: '9+', min: 9, max: Infinity },
];

/** Tee sheet bands, cut for a links course: an early first tee, light running late. */
export const TIME_BANDS = [
  { key: 'Before 09:00', min: 0, max: 8.9999 },
  { key: '09:00–11:59', min: 9, max: 11.9999 },
  { key: '12:00–13:59', min: 12, max: 13.9999 },
  { key: '14:00–16:59', min: 14, max: 16.9999 },
  { key: '17:00+', min: 17, max: 24 },
];

/**
 * '10:04 AM' / '09:20' / '7:30pm' -> hour as a float. Null when the row has no
 * usable time, which keeps "not specified" out of the request grid rather than
 * piling it onto midnight.
 */
export function parseTeeHour(teeTime) {
  if (!teeTime) return null;
  const match = String(teeTime).trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)?/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();

  if (hour > 23 || minutes > 59) return null;
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;

  return hour + minutes / 60;
}

/** Whole days between the enquiry landing and the round being played. */
export function leadTimeDays(booking) {
  if (!booking.date || !booking.timestamp) return null;
  const teeDate = Date.parse(`${booking.date}T00:00:00Z`);
  const enquiry = Date.parse(booking.timestamp);
  if (Number.isNaN(teeDate) || Number.isNaN(enquiry)) return null;

  const days = Math.floor((teeDate - startOfUtcDay(enquiry)) / 86_400_000);
  // Rows backfilled after the round was played would otherwise read as negative.
  return days < 0 ? null : days;
}

/** The label a booking's tee date falls under at this granularity. */
export function bucketDate(date, granularity) {
  if (granularity === 'month') return `${date.slice(0, 7)}-01`;
  if (granularity === 'week') {
    const time = Date.parse(`${date}T00:00:00Z`);
    const weekday = (new Date(time).getUTCDay() + 6) % 7; // Monday = 0
    return new Date(time - weekday * 86_400_000).toISOString().slice(0, 10);
  }
  return date;
}

/**
 * Bookings and revenue over time, zero-filled across the whole span so a quiet
 * week reads as a trough rather than vanishing into a straight line.
 */
export function buildSeries(bookings, granularity = 'day') {
  const step = GRANULARITIES.includes(granularity) ? granularity : 'day';
  const dated = bookings.filter((booking) => booking.date);
  if (!dated.length) return [];

  const buckets = new Map();
  for (const booking of dated) {
    const key = bucketDate(booking.date, step);
    const entry = buckets.get(key) ?? { count: 0, revenue: 0, players: 0 };
    entry.count += 1;
    entry.players += num(booking.players);
    if (COMMITTED.has(booking.status)) entry.revenue += num(booking.total);
    buckets.set(key, entry);
  }

  const keys = [...buckets.keys()].sort();
  const series = [];
  for (const key of spanKeys(keys[0], keys.at(-1), step)) {
    const entry = buckets.get(key) ?? { count: 0, revenue: 0, players: 0 };
    series.push({
      date: key,
      count: entry.count,
      players: entry.players,
      revenue: round2(entry.revenue),
    });
  }
  return series;
}

/** Headline numbers, plus the same numbers for the preceding period. */
export function buildTotals(bookings, previous) {
  const totals = periodTotals(bookings);
  if (!previous) return totals;

  const before = periodTotals(previous);
  return {
    ...totals,
    previous: before,
    delta: {
      bookings: percentChange(before.bookings, totals.bookings),
      revenue: percentChange(before.revenue, totals.revenue),
      averageValue: percentChange(before.averageValue, totals.averageValue),
      players: percentChange(before.players, totals.players),
    },
  };
}

function periodTotals(bookings) {
  const committed = bookings.filter((booking) => COMMITTED.has(booking.status));
  const lost = bookings.filter((booking) => TERMINAL_STATUSES.includes(booking.status));

  // Volume and money count every booking — an uploaded round is still played
  // and still paid for. Conversion and loss are rates *of enquiries*, so they
  // are measured against those alone or an upload would flatter them.
  const enquiries = enquiriesOnly(bookings);
  const enquiriesCommitted = enquiries.filter((booking) => COMMITTED.has(booking.status));
  const enquiriesLost = enquiries.filter((booking) => TERMINAL_STATUSES.includes(booking.status));

  return {
    bookings: bookings.length,
    revenue: round2(sum(committed, 'total')),
    averageValue: round2(committed.length ? sum(committed, 'total') / committed.length : 0),
    players: sum(bookings, 'players'),
    committed: committed.length,
    lost: lost.length,
    enquiries: enquiries.length,
    imported: bookings.length - enquiries.length,
    conversionRate: round1(enquiries.length ? (enquiriesCommitted.length / enquiries.length) * 100 : 0),
    cancellationRate: round1(enquiries.length ? (enquiriesLost.length / enquiries.length) * 100 : 0),
  };
}

/**
 * Stage-by-stage conversion. `conversionFromTop` narrows monotonically for the
 * funnel's geometry; `conversionFromPrevious` is the number that tells the
 * office *where* enquiries are actually being lost.
 */
export function buildFunnel(bookings) {
  const live = enquiriesOnly(bookings).filter((booking) => !TERMINAL_STATUSES.includes(booking.status));
  const top = live.length || 1;

  let previousCount = null;
  return PIPELINE_STAGES.map((stage, index) => {
    const count = live.filter(
      (booking) => PIPELINE_STAGES.indexOf(normaliseStatus(booking.status)) >= index,
    ).length;

    const row = {
      stage,
      count,
      conversionFromTop: round1((count / top) * 100),
      conversionFromPrevious:
        previousCount === null ? 100 : round1(previousCount ? (count / previousCount) * 100 : 0),
      droppedHere: previousCount === null ? 0 : Math.max(previousCount - count, 0),
    };
    previousCount = count;
    return row;
  });
}

/** How far ahead people book — the number that drives when to open the sheet. */
export function buildLeadTime(bookings) {
  const days = bookings.map(leadTimeDays).filter((value) => value !== null);

  const distribution = LEAD_TIME_BUCKETS.map(({ key }) => ({ key, count: 0 }));
  for (const value of days) {
    const index = LEAD_TIME_BUCKETS.findIndex((bucket) => value <= bucket.max);
    distribution[index].count += 1;
  }

  return { distribution, median: median(days), average: days.length ? round1(mean(days)) : null };
}

export function buildPartySizes(bookings) {
  return PARTY_SIZE_BUCKETS.map(({ key, min, max }) => {
    const group = bookings.filter((booking) => {
      const players = num(booking.players);
      return players >= min && players <= max;
    });
    return {
      key,
      count: group.length,
      players: sum(group, 'players'),
      revenue: round2(sum(group.filter((b) => COMMITTED.has(b.status)), 'total')),
    };
  });
}

/**
 * Course mix. `golf_courses` is free text that may name several courses, so a
 * booking counts toward each course it mentions — the totals are deliberately
 * not a partition and the page says so.
 */
export function buildCourseMix(bookings, knownCourses = ['Championship', 'Struie']) {
  const rows = knownCourses.map((course) => ({ key: course, count: 0, revenue: 0, players: 0 }));
  const unspecified = { key: 'Not specified', count: 0, revenue: 0, players: 0 };

  for (const booking of bookings) {
    const text = String(booking.golfCourses ?? '').toLowerCase();
    const matched = rows.filter((row) => text.includes(row.key.toLowerCase()));
    for (const row of matched.length ? matched : [unspecified]) {
      row.count += 1;
      row.players += num(booking.players);
      if (COMMITTED.has(booking.status)) row.revenue += num(booking.total);
    }
  }

  return [...rows, unspecified]
    .filter((row) => row.count > 0)
    .map((row) => ({ ...row, revenue: round2(row.revenue) }))
    .sort((a, b) => b.count - a.count);
}

/** What share of parties also want a bed, and what those parties are worth. */
export function buildAccommodation(bookings) {
  const withStay = bookings.filter((booking) => booking.hotelRequired);
  const committedWith = withStay.filter((booking) => COMMITTED.has(booking.status));
  const committedWithout = bookings.filter(
    (booking) => !booking.hotelRequired && COMMITTED.has(booking.status),
  );

  return {
    total: bookings.length,
    withAccommodation: withStay.length,
    attachRate: round1(bookings.length ? (withStay.length / bookings.length) * 100 : 0),
    averageWith: round2(
      committedWith.length ? sum(committedWith, 'total') / committedWith.length : 0,
    ),
    averageWithout: round2(
      committedWithout.length ? sum(committedWithout, 'total') / committedWithout.length : 0,
    ),
  };
}

/**
 * The slot an enquiry *asked for*. The form's own selection is the truest
 * record of the ask; `teeTime` is what the sheet ended up carrying, so it is
 * only the fallback. On a party that was moved to another slot the two differ,
 * and that difference is the point of this report.
 */
export function requestedTeeHour(booking) {
  return parseTeeHour(firstTimeIn(booking.selectedTeeTimes)) ?? parseTeeHour(booking.teeTime);
}

/** The slot the tee sheet actually carries. */
export function bookedTeeHour(booking) {
  return parseTeeHour(booking.teeTime);
}

/** The band a tee hour falls in, or null when there is no usable time. */
export function bandFor(hour) {
  if (hour === null) return null;
  return TIME_BANDS.find((band) => hour >= band.min && hour <= band.max)?.key ?? null;
}

/** The weekday a tee date falls on, or null when the row has no date. */
export function weekdayFor(date) {
  if (!date) return null;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(time) ? null : DAY_NAMES[new Date(time).getUTCDay()];
}

/**
 * Booking request utilisation: what people *asked for* against what they
 * actually booked, cell by cell on a weekday × time-band grid.
 *
 * Every enquiry lands on the slot it requested, whatever became of it, so a
 * cell answers the question the office keeps asking — is this slot quiet
 * because nobody wants it, or because everybody who wanted it went away? The
 * two are indistinguishable on a grid of confirmed bookings alone, which is
 * why demand and supply are counted separately here:
 *
 *  - `requests`  enquiries that asked for this slot, at any status
 *  - `converted` those that went on to be confirmed or booked
 *  - `declined`  those that were rejected or cancelled
 *  - `open`      those still live in the pipeline
 *  - `missed`    requests that are not (yet) a booking: declined + open
 *  - `bookings`  parties whose tee sheet slot is actually this one
 *  - `movedIn` / `movedOut` parties booked here having asked elsewhere, and
 *              the reverse — the gap between `requests` and `bookings`
 *
 * Every cell exists even at zero, so an unasked-for band reads as a hole in
 * the sheet rather than as a missing row.
 */
export function buildRequestUtilisation(bookings) {
  const cells = [];
  const index = new Map();

  for (const band of TIME_BANDS) {
    for (const day of WEEK_ORDER) {
      const cell = {
        band: band.key,
        day,
        requests: 0,
        requestPlayers: 0,
        converted: 0,
        declined: 0,
        open: 0,
        missed: 0,
        bookings: 0,
        bookedPlayers: 0,
        revenue: 0,
        movedIn: 0,
        movedOut: 0,
        conversion: 0,
      };
      index.set(`${band.key}|${day}`, cell);
      cells.push(cell);
    }
  }

  const shifts = new Map();
  let placed = 0;
  let unplaced = 0;

  // An uploaded booking asked for nothing — it arrived already made — so it is
  // neither demand nor a conversion of any.
  for (const booking of enquiriesOnly(bookings)) {
    const day = weekdayFor(booking.date);
    const requested = day ? index.get(`${bandFor(requestedTeeHour(booking))}|${day}`) : null;
    const committed = COMMITTED.has(booking.status);
    const booked =
      committed && day ? index.get(`${bandFor(bookedTeeHour(booking))}|${day}`) : null;

    if (requested) {
      placed += 1;
      requested.requests += 1;
      requested.requestPlayers += num(booking.players);
      if (committed) requested.converted += 1;
      else if (TERMINAL_STATUSES.includes(booking.status)) requested.declined += 1;
      else requested.open += 1;
    } else {
      unplaced += 1;
    }

    if (booked) {
      booked.bookings += 1;
      booked.bookedPlayers += num(booking.players);
      booked.revenue += num(booking.total);
    }

    // A party that asked for one slot and plays another is demand that stayed
    // and supply that moved. Counted on both ends so neither cell lies.
    if (booked && requested && booked !== requested) {
      requested.movedOut += 1;
      booked.movedIn += 1;
      const key = `${requested.day} ${requested.band} → ${booked.band}`;
      const shift = shifts.get(key) ?? {
        key,
        day: requested.day,
        from: requested.band,
        to: booked.band,
        count: 0,
        players: 0,
      };
      shift.count += 1;
      shift.players += num(booking.players);
      shifts.set(key, shift);
    }
  }

  for (const cell of cells) {
    cell.missed = cell.declined + cell.open;
    cell.conversion = round1(cell.requests ? (cell.converted / cell.requests) * 100 : 0);
    cell.revenue = round2(cell.revenue);
  }

  const asked = cells.filter((cell) => cell.requests > 0);
  const totals = {
    requests: placed,
    unplaced,
    converted: sumBy(asked, 'converted'),
    declined: sumBy(asked, 'declined'),
    open: sumBy(asked, 'open'),
    bookings: sumBy(cells, 'bookings'),
    moved: [...shifts.values()].reduce((total, shift) => total + shift.count, 0),
  };
  totals.missed = totals.declined + totals.open;
  totals.conversion = round1(placed ? (totals.converted / placed) * 100 : 0);

  return {
    cells,
    bands: TIME_BANDS.map((band) => band.key),
    days: WEEK_ORDER,
    placed,
    unplaced,
    totals,
    // The slots people ask for and walk away from, worst first — the list the
    // office works down when it decides what to open, price or chase.
    gaps: [...asked]
      .filter((cell) => cell.missed > 0)
      .sort((a, b) => b.missed - a.missed || b.requests - a.requests)
      .slice(0, 8)
      .map((cell) => ({ ...cell, key: `${cell.day} · ${cell.band}` })),
    shifts: [...shifts.values()].sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

/** First clock time in a free-text field, e.g. 'time: 10:35 AM' -> '10:35 AM'. */
function firstTimeIn(value) {
  if (!value) return null;
  const match = String(value).match(/(\d{1,2}:\d{2}(?:\s*[AP]M)?)/i);
  return match ? match[1] : null;
}

export function buildStatusBreakdown(bookings) {
  return [...PIPELINE_STAGES, ...TERMINAL_STATUSES].map((status) => {
    const group = bookings.filter((booking) => normaliseStatus(booking.status) === status);
    return {
      status,
      count: group.length,
      revenue: round2(sum(group, 'total')),
      players: sum(group, 'players'),
    };
  });
}

export function buildPopularTeeTimes(bookings, limit = 8) {
  const counts = new Map();
  for (const booking of bookings) {
    const key = booking.teeTime;
    if (!key || key === 'Not Specified') continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function buildBusiestDays(bookings) {
  return WEEK_ORDER.map((day) => ({
    key: day,
    count: bookings.filter(
      (booking) =>
        booking.date && DAY_NAMES[new Date(`${booking.date}T00:00:00Z`).getUTCDay()] === day,
    ).length,
  }));
}

/* ---------- payments, trade, lodging and journey emails ---------- */

/**
 * Where the money actually is, on the bookings this club has committed to.
 *
 * `total` is what the booking is worth, `amountPaid` what has landed. A club
 * that never records payments here has nothing behind these numbers, so
 * `tracked` says whether any row in the period carries payment state at all —
 * the page shows the section only when there is something real behind it.
 */
export function buildPaymentHealth(bookings, { today = todayIso() } = {}) {
  const committed = bookings.filter((booking) => COMMITTED.has(booking.status));
  const tracked = bookings.some(
    (booking) =>
      num(booking.amountPaid) > 0 ||
      booking.invoiceNumber ||
      booking.invoicedAt ||
      booking.depositDueDate ||
      booking.balanceDueDate ||
      (booking.paymentStatus && booking.paymentStatus !== 'Unpaid'),
  );

  const byStatus = PAYMENT_STATUSES.map((status) => {
    const group = committed.filter((booking) => paymentStatusOf(booking) === status);
    return {
      key: status,
      count: group.length,
      gross: round2(sum(group, 'total')),
      paid: round2(sum(group, 'amountPaid')),
      outstanding: round2(group.reduce((total, booking) => total + outstandingOn(booking), 0)),
    };
  });

  const overdue = committed
    .filter((booking) => outstandingOn(booking) > 0)
    .map((booking) => ({ booking, due: dueDateOf(booking) }))
    .filter(({ due }) => due && due < today)
    .map(({ booking, due }) => ({ booking, days: daysBetweenDates(due, today) }));

  const ageing = AGEING_BANDS.filter((band) => band.id !== 'current').map((band) => ({
    key: band.label,
    count: overdue.filter(({ days }) => ageingBand(days) === band.id).length,
    amount: round2(
      overdue
        .filter(({ days }) => ageingBand(days) === band.id)
        .reduce((total, { booking }) => total + outstandingOn(booking), 0),
    ),
  }));

  const gross = sum(committed, 'total');
  const paid = sum(committed, 'amountPaid');
  const invoiced = committed.filter((booking) => booking.invoiceNumber || booking.invoicedAt);

  return {
    tracked,
    bookings: committed.length,
    gross: round2(gross),
    paid: round2(paid),
    outstanding: round2(committed.reduce((total, booking) => total + outstandingOn(booking), 0)),
    collectionRate: round1(gross ? (paid / gross) * 100 : 0),
    invoiced: invoiced.length,
    invoicedRate: round1(committed.length ? (invoiced.length / committed.length) * 100 : 0),
    overdue: overdue.length,
    overdueAmount: round2(
      overdue.reduce((total, { booking }) => total + outstandingOn(booking), 0),
    ),
    byStatus,
    ageing,
  };
}

/**
 * Trade against direct, and which accounts carry the book.
 *
 * A booking is trade when it has been matched to a tour operator; `names` maps
 * those ids to account names so the chart reads as accounts rather than as
 * numbers. Without the operators table every booking is direct, which is the
 * honest answer for an install that does not use one.
 */
export function buildTradeMix(bookings, { names = new Map() } = {}) {
  const trade = bookings.filter((booking) => booking.tourOperatorId !== null && booking.tourOperatorId !== undefined);
  const direct = bookings.filter((booking) => booking.tourOperatorId === null || booking.tourOperatorId === undefined);

  const byId = new Map();
  for (const booking of trade) {
    const id = booking.tourOperatorId;
    const row = byId.get(id) ?? {
      key: names.get(id) ?? names.get(String(id)) ?? `Account ${id}`,
      id,
      count: 0,
      players: 0,
      revenue: 0,
      committed: 0,
    };
    row.count += 1;
    row.players += num(booking.players);
    if (COMMITTED.has(booking.status)) {
      row.committed += 1;
      row.revenue += num(booking.total);
    }
    byId.set(id, row);
  }

  return {
    channels: [channel('Direct', direct), channel('Trade', trade)],
    tradeShare: round1(bookings.length ? (trade.length / bookings.length) * 100 : 0),
    operators: [...byId.values()]
      .map((row) => ({
        ...row,
        revenue: round2(row.revenue),
        conversion: round1(row.count ? (row.committed / row.count) * 100 : 0),
      }))
      .sort((a, b) => b.revenue - a.revenue || b.count - a.count)
      .slice(0, 8),
  };
}

function channel(key, group) {
  const committed = group.filter((booking) => COMMITTED.has(booking.status));
  const revenue = sum(committed, 'total');
  return {
    key,
    count: group.length,
    players: sum(group, 'players'),
    revenue: round2(revenue),
    averageValue: round2(committed.length ? revenue / committed.length : 0),
    averageParty: round1(group.length ? sum(group, 'players') / group.length : 0),
    conversion: round1(group.length ? (committed.length / group.length) * 100 : 0),
  };
}

/**
 * The bed side of a golf trip: how long parties stay, how many rooms they
 * take, and what the stay is worth beside the golf.
 *
 * The revenue split treats `total` as the whole booking, so green fees are
 * what is left after the lodging and the resort fee — a booking that records
 * neither reads as all golf, which is what it is.
 */
export function buildLodging(bookings) {
  const withStay = bookings.filter((booking) => booking.hotelRequired);
  const committed = bookings.filter((booking) => COMMITTED.has(booking.status));

  const nights = withStay.map((booking) => nullableNum(booking.lodgingNights)).filter((value) => value !== null);
  const roomNights = withStay.reduce(
    (total, booking) => total + num(booking.lodgingNights) * Math.max(num(booking.lodgingRooms), 1),
    0,
  );

  const lodgingRevenue = committed.reduce((total, booking) => total + num(booking.lodgingCost), 0);
  const resortFees = committed.reduce((total, booking) => total + num(booking.resortFeeTotal), 0);
  const gross = sum(committed, 'total');

  const roomTypes = new Map();
  for (const booking of withStay) {
    const type = String(booking.lodgingRoomType ?? '').trim();
    if (!type) continue;
    const row = roomTypes.get(type) ?? { key: type, count: 0, rooms: 0, nights: 0 };
    row.count += 1;
    row.rooms += num(booking.lodgingRooms);
    row.nights += num(booking.lodgingNights);
    roomTypes.set(type, row);
  }

  return {
    // Anything to say at all: a stay recorded with some detail on it.
    detailed: nights.length > 0 || roomTypes.size > 0 || lodgingRevenue > 0,
    parties: withStay.length,
    nightsTotal: nights.reduce((total, value) => total + value, 0),
    averageNights: nights.length ? round1(mean(nights)) : null,
    medianNights: median(nights),
    roomNights,
    rooms: withStay.reduce((total, booking) => total + num(booking.lodgingRooms), 0),
    nightsDistribution: bucketNights(nights),
    roomTypes: [...roomTypes.values()].sort((a, b) => b.count - a.count),
    revenueMix: [
      { key: 'Golf', value: round2(Math.max(gross - lodgingRevenue - resortFees, 0)) },
      { key: 'Lodging', value: round2(lodgingRevenue) },
      { key: 'Resort fees', value: round2(resortFees) },
    ].filter((row) => row.value > 0),
    lodgingRevenue: round2(lodgingRevenue),
    resortFees: round2(resortFees),
  };
}

const NIGHT_BUCKETS = [
  { key: '1 night', min: 1, max: 1 },
  { key: '2 nights', min: 2, max: 2 },
  { key: '3 nights', min: 3, max: 3 },
  { key: '4 nights', min: 4, max: 4 },
  { key: '5+ nights', min: 5, max: Infinity },
];

function bucketNights(nights) {
  return NIGHT_BUCKETS.map(({ key, min, max }) => ({
    key,
    count: nights.filter((value) => value >= min && value <= max).length,
  }));
}

/**
 * Caddie demand, read off the free-text field the enquiry form writes.
 *
 * "For all players" is the most common answer and carries no number, so the
 * estimate falls back to the party size — it is an estimate, and the card says
 * so rather than presenting it as a booking count.
 */
export function buildCaddieDemand(bookings) {
  const rows = { Requested: [], 'Not required': [], 'Not specified': [] };
  for (const booking of bookings) {
    rows[classifyCaddie(booking.caddieRequirements)].push(booking);
  }

  const requested = rows.Requested;
  const estimated = requested.reduce((total, booking) => total + caddieCount(booking), 0);

  return {
    recorded: bookings.length - rows['Not specified'].length,
    distribution: Object.entries(rows).map(([key, group]) => ({
      key,
      count: group.length,
      players: sum(group, 'players'),
    })),
    requested: requested.length,
    attachRate: round1(bookings.length ? (requested.length / bookings.length) * 100 : 0),
    estimatedCaddies: estimated,
    playersInRequests: sum(requested, 'players'),
  };
}

/** Three answers the field actually gives, from text that is never structured. */
export function classifyCaddie(text) {
  const value = String(text ?? '').trim().toLowerCase();
  if (!value || value === 'none' || value === 'n/a' || value === '-') return 'Not specified';
  if (/\b(no|not)\b(?!\w)/.test(value) && !/\bnumber\b/.test(value)) {
    // "no caddies", "not required" — but never "no. of caddies: 4".
    if (/\bno\.\s*\d|\bno\.\s*of\b/.test(value)) return 'Requested';
    return 'Not required';
  }
  return 'Requested';
}

/** The number in the text, or the party size when it asks for everyone. */
function caddieCount(booking) {
  const text = String(booking.caddieRequirements ?? '');
  const match = text.match(/(\d+)/);
  if (match) return Number(match[1]);
  if (/\ball\b|\beach\b|\bevery\b/i.test(text)) return num(booking.players);
  return 1;
}

/**
 * What people write in the free-text fields, grouped into the handful of
 * themes the office actually acts on.
 *
 * Keyword matching, deliberately: a booking counts toward every theme it
 * mentions, so these do not sum to the total, and a request nobody has a word
 * for lands in none of them. It is a reading aid for the notes, not a
 * classification of them.
 */
export const REQUEST_THEMES = [
  { key: 'Caddies', pattern: /caddie|caddy|looper/i },
  { key: 'Buggy or cart', pattern: /buggy|buggies|cart\b|golf car/i },
  { key: 'Trolley', pattern: /trolley|trolly|push cart/i },
  { key: 'Club hire', pattern: /club hire|hire clubs|rental club|club rental|hire set/i },
  { key: 'Transport', pattern: /transfer|taxi|coach|minibus|pick ?up|airport|chauffeur/i },
  { key: 'Dining', pattern: /lunch|dinner|breakfast|meal|restaurant|catering|table for/i },
  { key: 'Dietary', pattern: /gluten|vegetarian|vegan|allerg|dietary|coeliac|celiac/i },
  { key: 'Celebration', pattern: /birthday|anniversary|honeymoon|celebrat|stag|retirement|wedding/i },
  { key: 'Accessibility', pattern: /wheelchair|mobility|disabled|buggy permit|medical|accessib/i },
  { key: 'Playing together', pattern: /play(ing)? together|same (group|tee|time)|one group|as a (group|four)/i },
  { key: 'Early tee time', pattern: /early (tee|start|morning)|first tee of|as early/i },
  { key: 'Late tee time', pattern: /late (tee|start|afternoon)|afternoon tee|as late/i },
];

export function buildRequestThemes(bookings) {
  const texts = bookings.map(
    (booking) =>
      `${booking.specialRequests ?? ''} ${booking.caddieRequirements ?? ''} ${booking.lodgingPreferences ?? ''}`.trim(),
  );
  const withText = texts.filter(Boolean);

  return {
    withRequests: withText.length,
    rate: round1(bookings.length ? (withText.length / bookings.length) * 100 : 0),
    themes: REQUEST_THEMES.map(({ key, pattern }) => ({
      key,
      count: withText.filter((text) => pattern.test(text)).length,
    }))
      .filter((row) => row.count > 0)
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * Who is booking: how many are coming back, and whether the address looks like
 * a person or a business.
 *
 * "Returning" is only ever within the selected period — this aggregation never
 * sees the rest of the book — so the card says "in this period" rather than
 * claiming a lifetime loyalty number it cannot know.
 */
export function buildGuestMix(bookings) {
  const byEmail = new Map();
  let anonymous = 0;

  for (const booking of bookings) {
    const email = String(booking.guestEmail ?? '').trim().toLowerCase();
    if (!email) {
      anonymous += 1;
      continue;
    }

    const row = byEmail.get(email) ?? {
      key: booking.guestName || email,
      email,
      count: 0,
      players: 0,
      revenue: 0,
    };
    row.count += 1;
    row.players += num(booking.players);
    if (COMMITTED.has(booking.status)) row.revenue += num(booking.total);
    byEmail.set(email, row);
  }

  const guests = [...byEmail.values()];
  const returning = guests.filter((guest) => guest.count > 1);

  let business = 0;
  for (const guest of guests) {
    const domain = emailDomain(guest.email);
    if (domain && !isConsumerDomain(domain)) business += 1;
  }

  return {
    guests: guests.length,
    anonymous,
    returning: returning.length,
    repeatRate: round1(guests.length ? (returning.length / guests.length) * 100 : 0),
    bookingsFromReturning: returning.reduce((total, guest) => total + guest.count, 0),
    business,
    consumer: guests.length - business,
    top: guests
      .map((guest) => ({ ...guest, revenue: round2(guest.revenue) }))
      .sort((a, b) => b.count - a.count || b.revenue - a.revenue)
      .slice(0, 8),
  };
}

/** Ordered buckets, so the axis reads fast to slow. */
export const RESPONSE_BUCKETS = [
  { key: 'Under 1 hour', max: 1 },
  { key: '1–4 hours', max: 4 },
  { key: '4–24 hours', max: 24 },
  { key: '1–3 days', max: 72 },
  { key: '3–7 days', max: 168 },
  { key: 'Over a week', max: Infinity },
];

/**
 * How long an enquiry waits before it is answered.
 *
 * The clock starts when the form was submitted and stops when the booking was
 * confirmed by the guest, or failing that when the row was last touched while
 * committed. Rows that were never answered are counted as outstanding rather
 * than folded in as an enormous response time.
 */
export function buildResponseTimes(bookings) {
  const hours = [];
  let unanswered = 0;

  for (const booking of enquiriesOnly(bookings)) {
    const asked = Date.parse(booking.formSubmittedAt ?? booking.timestamp ?? '');
    if (Number.isNaN(asked)) continue;

    const answeredAt = booking.customerConfirmedAt
      ?? (COMMITTED.has(booking.status) || TERMINAL_STATUSES.includes(booking.status)
        ? booking.updatedAt
        : null);
    const answered = Date.parse(answeredAt ?? '');

    if (Number.isNaN(answered) || answered < asked) {
      unanswered += 1;
      continue;
    }
    hours.push((answered - asked) / 3_600_000);
  }

  const distribution = RESPONSE_BUCKETS.map(({ key }) => ({ key, count: 0 }));
  for (const value of hours) {
    distribution[RESPONSE_BUCKETS.findIndex((bucket) => value <= bucket.max)].count += 1;
  }

  return {
    answered: hours.length,
    unanswered,
    distribution,
    medianHours: hours.length ? round1(medianOf(hours)) : null,
    averageHours: hours.length ? round1(mean(hours)) : null,
    withinDay: round1(hours.length ? (hours.filter((value) => value <= 24).length / hours.length) * 100 : 0),
  };
}

/**
 * Whether the customer-journey campaigns actually reached the bookings they
 * were meant to.
 *
 * Pre-arrival is owed to every committed booking; post-play only once the
 * round has been played, so a future tee date is not counted as a miss.
 */
export function buildEmailCoverage(bookings, { today = todayIso() } = {}) {
  const committed = bookings.filter((booking) => COMMITTED.has(booking.status) && booking.date);
  const played = committed.filter((booking) => booking.date <= today);

  const campaign = (label, eligible, field) => {
    const sent = eligible.filter((booking) => booking[field]).length;
    return {
      key: label,
      eligible: eligible.length,
      sent,
      missed: eligible.length - sent,
      rate: round1(eligible.length ? (sent / eligible.length) * 100 : 0),
    };
  };

  const rows = [
    campaign('Pre-arrival welcome', committed, 'preArrivalEmailSentAt'),
    campaign('Post-play thank you', played, 'postPlayEmailSentAt'),
  ];

  return {
    // A club that sends no journey emails from here would see every row as
    // unsent; saying nothing beats saying zero.
    tracked: bookings.some((booking) => booking.preArrivalEmailSentAt || booking.postPlayEmailSentAt),
    campaigns: rows,
  };
}

export function buildAnalytics(
  bookings,
  { granularity = 'day', previous = null, today = todayIso(), operatorNames = new Map() } = {},
) {
  return {
    granularity: GRANULARITIES.includes(granularity) ? granularity : 'day',
    totals: buildTotals(bookings, previous),
    byStatus: buildStatusBreakdown(bookings),
    series: buildSeries(bookings, granularity),
    funnel: buildFunnel(bookings),
    leadTime: buildLeadTime(bookings),
    partySizes: buildPartySizes(bookings),
    courses: buildCourseMix(bookings),
    accommodation: buildAccommodation(bookings),
    requestUtilisation: buildRequestUtilisation(bookings),
    popularTeeTimes: buildPopularTeeTimes(bookings),
    busiestDays: buildBusiestDays(bookings),

    // Each of these carries its own "is there anything here" flag, so a club
    // that does not use tour operators, lodging detail or the journey emails is
    // told that rather than shown a wall of zeroes.
    payments: buildPaymentHealth(bookings, { today }),
    trade: buildTradeMix(bookings, { names: operatorNames }),
    lodging: buildLodging(bookings),
    caddies: buildCaddieDemand(bookings),
    requestThemes: buildRequestThemes(bookings),
    guests: buildGuestMix(bookings),
    responseTimes: buildResponseTimes(bookings),
    emailCoverage: buildEmailCoverage(bookings, { today }),
  };
}

/* ---------- helpers ---------- */

function spanKeys(first, last, step) {
  const keys = [];
  const cursor = new Date(`${first}T00:00:00Z`);
  const end = Date.parse(`${last}T00:00:00Z`);

  while (cursor.getTime() <= end) {
    keys.push(cursor.toISOString().slice(0, 10));
    if (step === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + (step === 'week' ? 7 : 1));
  }
  return keys;
}

function startOfUtcDay(time) {
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Growth against a zero baseline is undefined rather than infinite — the page
 * shows "new" instead of a meaningless percentage.
 */
function percentChange(before, after) {
  if (!before) return after ? null : 0;
  return round1(((after - before) / before) * 100);
}

/** Whole days, the way the lead-time and nights figures are read. */
function median(values) {
  const exact = medianOf(values);
  return exact === null ? null : Math.round(exact);
}

/** The unrounded median, for the figures where a half matters. */
function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Today in the club's own calendar, so "overdue" means overdue here. */
function todayIso(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BRAND.timeZone }).format(now);
}

function daysBetweenDates(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

function paymentStatusOf(booking) {
  return normalisePaymentStatus(booking.paymentStatus);
}

/**
 * What is still owed on one booking. A refunded or written-off booking owes
 * nothing however the arithmetic reads, which is the whole point of those two
 * states.
 */
function outstandingOn(booking) {
  if (CLOSED_PAYMENT_STATUSES.includes(paymentStatusOf(booking))) return 0;
  return Math.max(num(booking.total) - num(booking.amountPaid), 0);
}

/** The date the money was due: the balance where there is one, else the deposit. */
function dueDateOf(booking) {
  return booking.balanceDueDate ?? booking.depositDueDate ?? null;
}

function nullableNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const sumBy = (items, key) => items.reduce((total, item) => total + item[key], 0);
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const sum = (items, key) => items.reduce((total, item) => total + num(item[key]), 0);
const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
const round2 = (value) => Math.round(value * 100) / 100;
const round1 = (value) => Math.round(value * 10) / 10;
