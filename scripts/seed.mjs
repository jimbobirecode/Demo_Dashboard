/**
 * Seed the dashboard with realistic sample bookings and tour operators.
 *
 *   npm run seed                  -- add sample data, keep anything already there
 *   npm run seed -- --reset       -- remove previously seeded rows first
 *   npm run seed -- --operators   -- only the tour operators and their bookings
 *                                    (for a database that already has bookings)
 *
 * Safety: every booking this writes carries the DEMO_PREFIX booking_id, every
 * operator it writes is marked by SAMPLE_OPERATOR_NOTE and books from a
 * reserved `.example` domain (so no reminder can reach a real company), and
 * --reset only ever deletes rows carrying those marks. Real bookings and real
 * operators are never touched.
 */
import '../server/src/env.js';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../server/src/db.js';
import { BRAND } from '../server/src/lib/brand.js';
import { migrate } from '../server/src/db/migrate.js';

const DEMO_PREFIX = 'RD-DEMO-';
const USERNAME = process.env.SEED_USERNAME ?? 'demo';

const FIRST_NAMES = [
  'James',
  'Sarah',
  'Michael',
  'Fiona',
  'David',
  'Aoife',
  'Thomas',
  'Claire',
  'Robert',
  'Niamh',
  'William',
  'Emma',
  'Patrick',
  'Hannah',
  'Andrew',
  'Laura',
  'Stephen',
  'Rachel',
  'Conor',
  'Megan',
  'Daniel',
  'Sophie',
  'Mark',
  'Orla',
];
const LAST_NAMES = [
  'Harrington',
  'McAllister',
  'Donnelly',
  'Whitfield',
  'O’Connor',
  'Brennan',
  'Fitzgerald',
  'Kavanagh',
  'Sinclair',
  'Doherty',
  'Armstrong',
  'Gallagher',
  'Pemberton',
  'Hughes',
  'Caldwell',
  'Redmond',
  'Thornton',
  'Mulligan',
];
const DOMAINS = ['gmail.com', 'outlook.com', 'btinternet.com', 'yahoo.co.uk', 'me.com'];

/** The TeeMail club's visitor green fee, per player per round (in BRAND.currency). */
const GREEN_FEE = 430;

const COURSES = [
  { name: 'Championship Course', fee: GREEN_FEE, weight: 6 },
  { name: 'Links Course', fee: GREEN_FEE, weight: 3 },
  // Both courses the same day: the second round is a 50% replay.
  { name: 'Championship Course, Links Course', fee: GREEN_FEE * 1.5, weight: 2 },
];

// The sheet runs in roughly 10-minute intervals.
const TEE_TIMES = [
  '07:20 AM',
  '07:40 AM',
  '08:00 AM',
  '08:20 AM',
  '08:50 AM',
  '09:10 AM',
  '09:40 AM',
  '10:04 AM',
  '10:24 AM',
  '10:50 AM',
  '11:20 AM',
  '11:50 AM',
  '12:30 PM',
  '01:10 PM',
  '01:40 PM',
  '02:20 PM',
  '02:50 PM',
  '03:30 PM',
];

const SOURCES = [
  'Enquiry received via the website booking form.',
  'Enquiry forwarded from the pro shop inbox.',
  'Telephone enquiry, details taken by reception.',
  'Enquiry received via the tour operator portal.',
];

const EXTRA_NOTES = [
  'Group is travelling from the US and would prefer a morning slot.',
  'Two of the party are members at a partner club.',
  'Buggy required for one player (medical).',
  'Celebrating a 50th birthday, asked about a table in the clubhouse after.',
  'Flexible on time if the requested slot is unavailable.',
  'Return visitors — played the Championship Course in 2024.',
  'Would like caddies arranged for all players if possible.',
  'Asked whether clubs can be hired on the day.',
  'Playing the Highland loop, also booked at Brora and Castle Stuart that week.',
  '',
  '',
];

/**
 * Status mix of a realistic pipeline: plenty of new enquiries at the top,
 * fewer surviving to Booked, with a tail of rejections and cancellations.
 */
const STATUS_MIX = [
  ...Array(9).fill('Inquiry'),
  ...Array(2).fill('Pending'),
  ...Array(7).fill('Requested'),
  ...Array(6).fill('Confirmed'),
  ...Array(8).fill('Booked'),
  ...Array(2).fill('Rejected'),
  ...Array(2).fill('Cancelled'),
];

// Deterministic PRNG so re-seeding produces the same believable data set.
let seedState = 20260911;
function random() {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
}
const pick = (list) => list[Math.floor(random() * list.length)];

function pickCourse() {
  const total = COURSES.reduce((sum, course) => sum + course.weight, 0);
  let roll = random() * total;
  for (const course of COURSES) {
    roll -= course.weight;
    if (roll <= 0) return course;
  }
  return COURSES[0];
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function buildNote({ name, email, teeDate, teeTime, players, course }) {
  const extra = pick(EXTRA_NOTES);
  return [
    pick(SOURCES),
    '',
    `Name: ${name}`,
    `Email: ${email}`,
    `Course: ${course.name}`,
    `Date: ${teeDate.toDateString()}`,
    `Time: ${teeTime}`,
    `Players: ${players}`,
    extra ? `\n${extra}` : '',
  ]
    .join('\n')
    .trim();
}

/**
 * Seeded rows are only visible to a user whose customer_id matches the row's
 * club, so guessing wrong makes the dashboard look empty. Prefer the club the
 * existing dashboard users are actually on.
 */
async function resolveClub(client) {
  if (process.env.SEED_CLUB) return process.env.SEED_CLUB;

  const { rows } = await client.query(
    `SELECT customer_id, COUNT(*)::int AS users
       FROM public.dashboard_users
      WHERE customer_id IS NOT NULL
      GROUP BY customer_id
      ORDER BY users DESC`,
  );

  if (rows.length === 1) {
    console.log(`Using club "${rows[0].customer_id}" (from the existing dashboard user).`);
    return rows[0].customer_id;
  }

  if (rows.length > 1) {
    console.error('Several clubs exist on this database:');
    for (const row of rows) console.error(`  ${row.customer_id} (${row.users} user(s))`);
    console.error('Re-run with SEED_CLUB set to the one you want.');
    process.exit(1);
  }

  // A fresh database gets this install's own club id. An existing one is
  // never re-labelled — the branches above take the club from its own rows,
  // because customer_id is data and renaming it would orphan every booking.
  console.log(`No dashboard users yet — using club "${BRAND.clubId}".`);
  return BRAND.clubId;
}

async function ensureUser(client, CLUB) {
  const { rows } = await client.query('SELECT id FROM public.dashboard_users WHERE username = $1', [USERNAME]);

  if (rows.length) {
    console.log(`User "${USERNAME}" already exists — password left unchanged.`);
    return null;
  }

  // A random password unless one is supplied, so a public deployment never
  // ends up with a guessable default.
  const password = process.env.SEED_PASSWORD ?? crypto.randomBytes(9).toString('base64url');
  const hash = await bcrypt.hash(password, 12);

  await client.query(
    `INSERT INTO public.dashboard_users
       (username, password_hash, customer_id, full_name, is_active, must_change_password)
     VALUES ($1, $2, $3, $4, TRUE, FALSE)`,
    [USERNAME, hash, CLUB, 'Demo Manager'],
  );

  return password;
}

function buildBookings(count) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const bookings = [];

  for (let i = 0; i < count; i += 1) {
    // Tee dates from 21 days back to ~100 days ahead, so both the trend
    // line and the "next 30 days" default view have something in them.
    const dayOffset = Math.floor(random() * 121) - 21;
    const teeDate = new Date(today);
    teeDate.setUTCDate(teeDate.getUTCDate() + dayOffset);

    // Weekends draw more play; skip roughly half of midweek candidates.
    const weekday = teeDate.getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;
    if (!isWeekend && random() < 0.35) continue;

    const course = pickCourse();
    const players = [1, 2, 2, 3, 4, 4, 4][Math.floor(random() * 7)];
    const teeTime = pick(TEE_TIMES);
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const name = `${first} ${last}`;
    const email = `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}@${pick(DOMAINS)}`;

    let status = pick(STATUS_MIX);
    // A past tee date can't still be an open enquiry.
    if (dayOffset < 0 && ['Inquiry', 'Pending', 'Requested'].includes(status)) {
      status = random() < 0.8 ? 'Booked' : 'Cancelled';
    }

    // Enquiries arrive well before the tee date.
    const requestedAt = new Date(teeDate);
    requestedAt.setUTCDate(requestedAt.getUTCDate() - (3 + Math.floor(random() * 45)));
    requestedAt.setUTCHours(7 + Math.floor(random() * 12), Math.floor(random() * 60));
    const cappedRequestedAt = requestedAt > new Date() ? new Date() : requestedAt;

    const hotelRequired = random() < 0.28;
    const hotelCheckin = new Date(teeDate);
    hotelCheckin.setUTCDate(hotelCheckin.getUTCDate() - 1);
    const hotelCheckout = new Date(teeDate);
    hotelCheckout.setUTCDate(hotelCheckout.getUTCDate() + 1 + Math.floor(random() * 2));

    const touched = ['Confirmed', 'Booked', 'Rejected', 'Cancelled'].includes(status);

    bookings.push({
      bookingId: `${DEMO_PREFIX}${String(1000 + bookings.length)}`,
      email,
      date: isoDate(teeDate),
      // A few rows deliberately have no tee_time so "Fix tee times" has
      // something to extract from the note.
      teeTime: random() < 0.12 ? null : teeTime,
      players,
      total: (course.fee * players).toFixed(2),
      status,
      note: buildNote({ name, email, teeDate, teeTime, players, course }),
      timestamp: cappedRequestedAt.toISOString(),
      updatedAt: touched ? new Date().toISOString() : null,
      updatedBy: touched ? USERNAME : null,
      hotelRequired,
      hotelCheckin: hotelRequired ? isoDate(hotelCheckin) : null,
      hotelCheckout: hotelRequired ? isoDate(hotelCheckout) : null,
      course: course.name,
      teeTimeLabel: teeTime,
    });
  }

  return bookings;
}

// ---------------------------------------------------------------------------
// Tour operators
// ---------------------------------------------------------------------------

const OPERATOR_PREFIX = `${DEMO_PREFIX}OP-`;
const SAMPLE_OPERATOR_NOTE = 'Sample operator (seeded).';

/**
 * Six fictional trade partners, one for each situation the Tour Operators page
 * has to show: a model account, one running late, one near its limit, one on
 * hold, a deposit-then-balance account and a retired one. Each booking is
 * { day: tee date relative to today, players, rounds, status, invoiced: days
 * ago it was invoiced (null = not yet), paid: share of the total received }.
 */
const OPERATORS = [
  {
    name: 'Fairway & Firth Golf Tours',
    code: 'FFG',
    contact: 'Moira Buchanan',
    phone: '+44 131 496 0101',
    domain: 'fairwayfirth.example',
    terms: { days: 30, deposit: 25, depositBefore: 60, balanceBefore: 30, limit: 60000 },
    notes: 'Long-standing partner. Pays promptly; prefers morning tee times for groups.',
    bookings: [
      { day: -35, players: 8, rounds: 1, status: 'Booked', invoiced: 70, paid: 1 },
      { day: -12, players: 12, rounds: 2, status: 'Booked', invoiced: 50, paid: 1 },
      { day: 24, players: 8, rounds: 1, status: 'Booked', invoiced: 40, paid: 1 },
      { day: 45, players: 16, rounds: 2, status: 'Booked', invoiced: 20, paid: 0.25 },
      { day: 75, players: 8, rounds: 1, status: 'Booked', invoiced: 5, paid: 0 },
      { day: 110, players: 4, rounds: 1, status: 'Requested', invoiced: null, paid: 0 },
    ],
  },
  {
    name: 'Links Trail Golf Travel',
    code: 'LTG',
    contact: 'Callum Reid',
    phone: '+44 20 7946 0102',
    domain: 'linkstrail.example',
    terms: { days: 30, deposit: 0, depositBefore: null, balanceBefore: null, limit: 20000 },
    notes: 'High volume. Balances regularly run past 30 days - chase early.',
    bookings: [
      { day: -60, players: 12, rounds: 1, status: 'Booked', invoiced: 75, paid: 0 },
      { day: -40, players: 8, rounds: 1, status: 'Booked', invoiced: 50, paid: 0.5 },
      { day: -8, players: 8, rounds: 2, status: 'Booked', invoiced: 15, paid: 0 },
      { day: 18, players: 12, rounds: 1, status: 'Booked', invoiced: 10, paid: 0 },
      { day: 40, players: 8, rounds: 1, status: 'Inquiry', invoiced: null, paid: 0 },
    ],
  },
  {
    name: 'Atlantic Tee Holidays',
    code: 'ATH',
    contact: 'Brooke Sullivan',
    phone: '+1 617 555 0103',
    domain: 'atlantictee.example',
    terms: { days: 14, deposit: 50, depositBefore: null, balanceBefore: 45, limit: 80000 },
    notes: 'North American groups. 50% deposit on invoice, balance 45 days before play.',
    bookings: [
      { day: 30, players: 16, rounds: 2, status: 'Booked', invoiced: 90, paid: 0.5 },
      { day: 65, players: 12, rounds: 1, status: 'Booked', invoiced: 30, paid: 0.5 },
      { day: 95, players: 20, rounds: 2, status: 'Booked', invoiced: 20, paid: 0 },
      { day: 140, players: 8, rounds: 1, status: 'Requested', invoiced: null, paid: 0 },
    ],
  },
  {
    name: 'Highland Swing Golf Breaks',
    code: 'HSG',
    contact: 'Euan Mackay',
    phone: '+44 1463 496 0104',
    domain: 'highlandswing.example',
    terms: { days: 30, deposit: 0, depositBefore: null, balanceBefore: null, limit: 5000 },
    onHold: true,
    notes:
      'ON HOLD: two invoices over 90 days and over its credit limit. No new tee times until the account is settled.',
    bookings: [
      { day: -130, players: 8, rounds: 1, status: 'Booked', invoiced: 140, paid: 0 },
      { day: -100, players: 4, rounds: 2, status: 'Booked', invoiced: 110, paid: 0.25 },
      { day: 20, players: 8, rounds: 1, status: 'Requested', invoiced: null, paid: 0 },
    ],
  },
  {
    name: 'Clubhouse Corporate Events',
    code: 'CCE',
    contact: 'Priya Nair',
    phone: '+44 161 496 0105',
    domain: 'clubhouseevents.example',
    terms: { days: 14, deposit: 0, depositBefore: null, balanceBefore: null, limit: null },
    notes: 'Corporate days and client golf. Invoiced on booking, 14-day terms.',
    bookings: [
      { day: -20, players: 24, rounds: 1, status: 'Booked', invoiced: 45, paid: 1 },
      { day: 12, players: 16, rounds: 1, status: 'Booked', invoiced: 10, paid: 0 },
      { day: 55, players: 32, rounds: 1, status: 'Confirmed', invoiced: null, paid: 0 },
    ],
  },
  {
    name: 'Old Course Connections',
    code: 'OCC',
    contact: 'Graham Lister',
    phone: '+44 1334 496 0106',
    domain: 'oldcourseconnections.example',
    terms: { days: 30, deposit: 20, depositBefore: 90, balanceBefore: 30, limit: 15000 },
    active: false,
    notes: 'Retired partner - ceased trading with the club. Kept for history.',
    bookings: [{ day: -300, players: 8, rounds: 1, status: 'Booked', invoiced: 330, paid: 1 }],
  },
];

const TEAM_TEE_TIMES = ['08:00 AM', '08:10 AM', '08:20 AM', '08:30 AM', '09:00 AM', '09:10 AM', '10:30 AM', '01:10 PM'];

function daysFromToday(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

/** A group's tee times: one per four players, ten minutes apart. */
function groupTeeTimes(players, start) {
  const [clock, meridiem] = start.split(' ');
  const [hours, minutes] = clock.split(':').map(Number);
  let at = ((hours % 12) + (meridiem === 'PM' ? 12 : 0)) * 60 + minutes;
  const times = [];
  for (let i = 0; i < Math.ceil(players / 4); i += 1, at += 10) {
    const h = Math.floor(at / 60);
    const label = `${String(((h + 11) % 12) + 1).padStart(2, '0')}:${String(at % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
    times.push(label);
  }
  return times;
}

/** Everything an operator booking needs, derived from its scenario line. */
function buildOperatorBooking(operator, line, index) {
  // A second round the same day is a 50% replay.
  const perPlayer = GREEN_FEE * (line.rounds === 2 ? 1.5 : 1);
  const total = Math.round(perPlayer * line.players * 100) / 100;
  const paid = Math.round(total * line.paid * 100) / 100;
  const paymentStatus = paid <= 0 ? 'Unpaid' : paid >= total ? 'Paid' : 'Deposit paid';
  const teeTimes = groupTeeTimes(line.players, TEAM_TEE_TIMES[index % TEAM_TEE_TIMES.length]);
  const courses = line.rounds === 2 ? 'Championship Course, Links Course' : 'Championship Course';
  const date = daysFromToday(line.day);
  const requested = daysFromToday(Math.min(line.day, 0) - (line.invoiced ?? 3) - 5);
  const reference = `${OPERATOR_PREFIX}${operator.code}-${String(index + 1).padStart(2, '0')}`;

  return {
    bookingId: reference,
    email: `groups@${operator.domain}`,
    date,
    teeTime: teeTimes[0],
    players: line.players,
    total: total.toFixed(2),
    status: line.status,
    note: [
      `Group booking from ${operator.name} (account ${operator.code}).`,
      '',
      `Contact: ${operator.contact}`,
      `Players: ${line.players} (${teeTimes.length} tee time${teeTimes.length === 1 ? '' : 's'})`,
      `Course: ${courses}`,
      line.rounds === 2 ? 'Playing 36 holes - second round charged at the 50% same-day replay rate.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
    timestamp: `${requested}T09:30:00Z`,
    course: courses,
    selectedTeeTimes: JSON.stringify(teeTimes),
    paymentStatus,
    amountPaid: paid.toFixed(2),
    invoiceNumber: line.invoiced == null ? null : `INV-${operator.code}-${String(2600 + index)}`,
    invoicedAt: line.invoiced == null ? null : daysFromToday(-line.invoiced),
  };
}

/**
 * Seed the sample tour operators and their bookings. Operators are upserted
 * by name, so re-running refreshes their terms instead of duplicating them.
 */
export async function seedTourOperators(client, CLUB, { reset = false } = {}) {
  if (reset) {
    const bookings = await client.query('DELETE FROM public.bookings WHERE booking_id LIKE $1', [
      `${OPERATOR_PREFIX}%`,
    ]);
    const operators = await client.query('DELETE FROM public.tour_operators WHERE club = $1 AND notes LIKE $2', [
      CLUB,
      `${SAMPLE_OPERATOR_NOTE}%`,
    ]);
    console.log(
      `--reset: removed ${operators.rowCount} sample operator(s) and ${bookings.rowCount} of their booking(s).`,
    );
  }

  let bookingsInserted = 0;
  for (const operator of OPERATORS) {
    const t = operator.terms;
    const { rows } = await client.query(
      `INSERT INTO public.tour_operators
         (club, name, contact_name, contact_email, contact_phone, account_code, email_domains,
          payment_terms_days, deposit_percent, deposit_due_days_before_play, balance_due_days_before_play,
          credit_limit, currency, on_hold, active, notes, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'seed')
       ON CONFLICT (club, (LOWER(name))) DO UPDATE SET
         contact_name = EXCLUDED.contact_name, contact_email = EXCLUDED.contact_email,
         contact_phone = EXCLUDED.contact_phone, account_code = EXCLUDED.account_code,
         email_domains = EXCLUDED.email_domains, payment_terms_days = EXCLUDED.payment_terms_days,
         deposit_percent = EXCLUDED.deposit_percent,
         deposit_due_days_before_play = EXCLUDED.deposit_due_days_before_play,
         balance_due_days_before_play = EXCLUDED.balance_due_days_before_play,
         credit_limit = EXCLUDED.credit_limit, currency = EXCLUDED.currency,
         on_hold = EXCLUDED.on_hold, active = EXCLUDED.active, notes = EXCLUDED.notes,
         updated_at = NOW(), updated_by = 'seed'
       WHERE public.tour_operators.notes LIKE '${SAMPLE_OPERATOR_NOTE}%'
       RETURNING id`,
      [
        CLUB,
        operator.name,
        operator.contact,
        `accounts@${operator.domain}`,
        operator.phone,
        operator.code,
        [operator.domain],
        t.days,
        t.deposit,
        t.depositBefore,
        t.balanceBefore,
        t.limit,
        BRAND.currency,
        Boolean(operator.onHold),
        operator.active !== false,
        `${SAMPLE_OPERATOR_NOTE} ${operator.notes}`,
      ],
    );
    if (!rows.length) {
      // A real operator already has this name: leave it and its bookings alone.
      console.log(`  skipped "${operator.name}" - a real operator already uses that name.`);
      continue;
    }
    const operatorId = rows[0].id;

    for (const [index, line] of operator.bookings.entries()) {
      const b = buildOperatorBooking(operator, line, index);
      const { rowCount } = await client.query(
        `INSERT INTO public.bookings
           (booking_id, guest_email, date, tee_time, players, total, status, note, club,
            timestamp, created_at, golf_courses, selected_tee_times,
            tour_operator_id, payment_status, amount_paid, invoice_number, invoiced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (booking_id) DO NOTHING`,
        [
          b.bookingId,
          b.email,
          b.date,
          b.teeTime,
          b.players,
          b.total,
          b.status,
          b.note,
          CLUB,
          b.timestamp,
          b.course,
          b.selectedTeeTimes,
          operatorId,
          b.paymentStatus,
          b.amountPaid,
          b.invoiceNumber,
          b.invoicedAt,
        ],
      );
      bookingsInserted += rowCount;
    }
  }

  console.log(
    `Seeded ${OPERATORS.length} tour operator(s) and ${bookingsInserted} operator booking(s) for club "${CLUB}".`,
  );
  return { operators: OPERATORS.length, bookings: bookingsInserted };
}

export async function seed({ client, reset = false, operatorsOnly = false } = {}) {
  // The schema comes from db/migrations: the server runs them at boot, and
  // the CLI below runs them before seeding.
  const CLUB = await resolveClub(client);
  if (operatorsOnly) {
    const operators = await seedTourOperators(client, CLUB, { reset });
    return { club: CLUB, inserted: operators.bookings, operators, password: null };
  }
  {
    if (reset) {
      const { rowCount } = await client.query(
        'DELETE FROM public.bookings WHERE booking_id LIKE $1 AND booking_id NOT LIKE $2',
        [`${DEMO_PREFIX}%`, `${OPERATOR_PREFIX}%`],
      );
      console.log(`--reset: removed ${rowCount} previously seeded booking(s).`);
    }

    const password = await ensureUser(client, CLUB);
    const bookings = buildBookings(150);

    let inserted = 0;
    for (const booking of bookings) {
      const { rowCount } = await client.query(
        `INSERT INTO public.bookings
           (booking_id, guest_email, date, tee_time, players, total, status, note, club,
            timestamp, created_at, updated_at, updated_by,
            hotel_required, hotel_checkin, hotel_checkout, golf_courses, selected_tee_times)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (booking_id) DO NOTHING`,
        [
          booking.bookingId,
          booking.email,
          booking.date,
          booking.teeTime,
          booking.players,
          booking.total,
          booking.status,
          booking.note,
          CLUB,
          booking.timestamp,
          booking.updatedAt,
          booking.updatedBy,
          booking.hotelRequired,
          booking.hotelCheckin,
          booking.hotelCheckout,
          booking.course,
          // selected_tee_times is JSONB.
          booking.teeTime ? JSON.stringify([booking.teeTimeLabel]) : null,
        ],
      );
      inserted += rowCount;
    }

    const { rows } = await client.query(
      `SELECT status, COUNT(*)::int AS count
         FROM public.bookings
        WHERE club = $1 AND booking_id LIKE $2
        GROUP BY status ORDER BY count DESC`,
      [CLUB, `${DEMO_PREFIX}%`],
    );

    console.log(`\nSeeded ${inserted} booking(s) for club "${CLUB}".`);
    console.log(rows.map((row) => `  ${row.status.padEnd(10)} ${row.count}`).join('\n'));

    if (password) {
      console.log(`\n  Sign in with:  ${USERNAME} / ${password}`);
      console.log('  Save it now — it is not stored anywhere and is not shown again.');
    }
    if (!inserted && !reset) {
      console.log('\nNothing new inserted. Re-run with --reset to rebuild the sample data.');
    }

    console.log('');
    const operators = await seedTourOperators(client, CLUB, { reset });

    return { club: CLUB, inserted, operators, password };
  }
}

/** Run as a CLI only when invoked directly, not when imported by the server. */
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Point it at the dashboard database and retry.');
    process.exit(1);
  }

  await migrate({ pool });
  const client = await pool.connect();
  try {
    await seed({
      client,
      reset: process.argv.includes('--reset'),
      operatorsOnly: process.argv.includes('--operators'),
    });
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
