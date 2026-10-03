import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapColumns,
  markDuplicates,
  mintBatchId,
  mintImportedBookingId,
  parseDate,
  parseMoney,
  parseTeeSheet,
  parseTeeTime,
} from '../src/lib/import-domain.js';
import { parseCsv } from '../src/routes/imports.js';

test('columns are found whatever the club calls them', () => {
  const { mapping, unmapped, missingRequired } = mapColumns([
    'Confirmation Number',
    'Customer Name',
    'Email Address',
    'Playing Date',
    'Start Time',
    'Pax',
    'Green Fees',
    'Course',
    'Remarks',
    'Handicap',
  ]);

  assert.equal(mapping.bookingId, 0);
  assert.equal(mapping.guestName, 1);
  assert.equal(mapping.guestEmail, 2);
  assert.equal(mapping.date, 3);
  assert.equal(mapping.teeTime, 4);
  assert.equal(mapping.players, 5);
  assert.equal(mapping.total, 6);
  assert.deepEqual(unmapped, ['Handicap'], 'a column we have no use for is reported, not silently dropped');
  assert.deepEqual(missingRequired, []);

  // Spacing, case and punctuation in a header mean nothing.
  assert.equal(mapColumns(['TEE_DATE']).mapping.date, 0);
  assert.equal(mapColumns([' Tee Date ']).mapping.date, 0);
  assert.deepEqual(mapColumns(['Player', 'Handicap']).missingRequired, ['date']);
});

test('dates are read in every shape a spreadsheet holds them', () => {
  assert.equal(parseDate('2026-04-03'), '2026-04-03');
  assert.equal(parseDate('03/04/2026'), '2026-04-03', 'day first by default — these are UK clubs');
  assert.equal(parseDate('03/04/2026', { dayFirst: false }), '2026-03-04');
  assert.equal(parseDate('3-4-26'), '2026-04-03');
  assert.equal(parseDate('3 April 2026'), '2026-04-03');
  assert.equal(parseDate('Apr 3, 2026'), '2026-04-03');
  assert.equal(parseDate(new Date(Date.UTC(2026, 3, 3))), '2026-04-03');

  // A value over 12 can only be the day, whatever the convention says.
  assert.equal(parseDate('13/04/2026', { dayFirst: false }), '2026-04-13');

  assert.equal(parseDate('31/02/2026'), null, '31 February is not rolled into March');
  assert.equal(parseDate('rubbish'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate(null), null);
});

test('tee times survive a 24-hour sheet, a 12-hour one and Excel', () => {
  assert.equal(parseTeeTime('09:35'), '09:35 AM', 'a UK sheet is usually 24-hour');
  assert.equal(parseTeeTime('9:35'), '09:35 AM');
  assert.equal(parseTeeTime('0935'), '09:35 AM');
  assert.equal(parseTeeTime('14:10'), '02:10 PM');
  assert.equal(parseTeeTime('2:10 PM'), '02:10 PM');
  assert.equal(parseTeeTime('9.35am'), '09:35 AM');
  assert.equal(parseTeeTime('00:30'), '12:30 AM');
  assert.equal(parseTeeTime(0.4), '09:36 AM', 'Excel stores a bare time as a fraction of a day');
  assert.equal(parseTeeTime('25:00'), null);
  assert.equal(parseTeeTime('9:99'), null);
  assert.equal(parseTeeTime(''), null);
});

test('money survives currency symbols, separators and accountants', () => {
  assert.equal(parseMoney('£1,440.00'), 1440);
  assert.equal(parseMoney('1 440'), 1440);
  assert.equal(parseMoney('1.440,00'), 1440, 'European separators');
  assert.equal(parseMoney('(120)'), -120, 'a bracketed number is negative');
  assert.equal(parseMoney(420), 420);
  assert.equal(parseMoney('n/a'), null);
  assert.equal(parseMoney(''), null);
});

test('CSV quoting is handled, including commas and quotes inside a field', () => {
  const rows = parseCsv('a,b\n"one, two","he said ""hi"""\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['one, two', 'he said "hi"'],
  ]);
  assert.deepEqual(parseCsv('﻿a,b\n1,2')[0], ['a', 'b'], 'Excel writes a byte-order mark');
});

const SHEET = [
  ['Confirmation Number', 'Customer Name', 'Email Address', 'Playing Date', 'Start Time', 'Pax', 'Green Fees'],
  ['CLB-1', 'Alan Reid', 'Alan@Example.com', '03/04/2026', '09:35', '4', '£1,440.00'],
  ['', '', '', '', '', '', ''],
  ['CLB-2', 'Bad Row', 'bad@example.com', 'not a date', '10:00', '2', '£500'],
  ['TOTALS', '', '', '', '', '6', '£1,940'],
];

test('a sheet becomes bookings, and the rest becomes complaints', () => {
  const parsed = parseTeeSheet(SHEET);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.bookings.length, 1, 'the blank spacer is skipped silently');
  assert.deepEqual(
    parsed.rejected.map((row) => row.line),
    [4, 5],
    'the bad date and the totals line',
  );
  assert.match(parsed.rejected[0].reason, /Could not read the date "not a date"/);

  const [booking] = parsed.bookings;
  assert.equal(booking.date, '2026-04-03');
  assert.equal(booking.teeTime, '09:35 AM');
  assert.equal(booking.players, 4);
  assert.equal(booking.total, 1440);
  assert.equal(booking.guestEmail, 'alan@example.com', 'lower-cased, so it matches an existing guest');
  assert.equal(booking.status, 'Booked', 'a tee sheet holds bookings, not enquiries');
  assert.equal(booking.line, 2, 'the row number the spreadsheet shows');
});

test('a sheet with no date column is refused rather than half-read', () => {
  const parsed = parseTeeSheet([
    ['Name', 'Handicap'],
    ['Alan', '12'],
  ]);

  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /Could not find a date column/);
  assert.match(parsed.error, /Name, Handicap/, 'the headers it did read, so the cause is visible');
  assert.deepEqual(parsed.bookings, []);
  assert.equal(parseTeeSheet([]).ok, false);
});

test('the day-first reading is carried through and reported', () => {
  assert.equal(parseTeeSheet(SHEET).bookings[0].date, '2026-04-03');
  assert.equal(parseTeeSheet(SHEET, { dayFirst: false }).bookings[0].date, '2026-03-04');
  assert.equal(parseTeeSheet(SHEET, { dayFirst: false }).dayFirst, false, 'so the page can show which was used');
});

test('duplicates are found by reference and by slot, including within one file', () => {
  const parsed = [
    { bookingId: 'CLB-1', guestEmail: 'a@b.com', date: '2026-04-03', teeTime: '09:35 AM' },
    { bookingId: null, guestEmail: 'c@d.com', date: '2026-04-03', teeTime: '10:00 AM' },
    { bookingId: null, guestEmail: 'c@d.com', date: '2026-04-03', teeTime: '10:00 AM' },
    { bookingId: 'CLB-9', guestEmail: 'e@f.com', date: '2026-04-04', teeTime: '11:00 AM' },
  ];
  const existing = [{ bookingId: 'CLB-1', guestEmail: 'zzz@other.com', date: '2026-01-01', teeTime: '08:00 AM' }];

  const { fresh, duplicates } = markDuplicates(parsed, existing);
  assert.equal(duplicates.length, 2, 'the known reference, and the row the file repeats');
  assert.deepEqual(
    fresh.map((row) => row.guestEmail),
    ['c@d.com', 'e@f.com'],
  );
});

test('generated references are dated and traceable to their batch', () => {
  const batch = mintBatchId(new Date('2026-09-23T10:00:00Z'), () => 1);
  assert.equal(batch, 'IMP-20260923-BBBBBB');
  // A row without a reference gets one in the core API's format.
  assert.match(mintImportedBookingId(), /^[A-Z]{2,6}-\d{8}-[A-Z0-9]{10}$/);
});
