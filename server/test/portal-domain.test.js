import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnquiry,
  isCurrent,
  operatorForEmail,
  portalBooking,
  portalSignInLink,
  statementCsv,
} from '../src/lib/portal-domain.js';

const operators = [
  {
    id: 1,
    name: 'Links Tours',
    contactEmail: 'Bookings@LinksTours.com',
    emailDomains: ['linkstours.com'],
    active: true,
  },
  { id: 2, name: 'Old Co', contactEmail: 'ops@oldco.ie', emailDomains: ['oldco.ie'], active: false },
  { id: 3, name: 'Gmail Guy', contactEmail: 'guy@gmail.com', emailDomains: ['gmail.com'], active: true },
];

test('operatorForEmail matches the contact address, case-insensitively', () => {
  assert.equal(operatorForEmail('bookings@linkstours.com', operators)?.id, 1);
});

test('operatorForEmail matches anyone on an operator domain', () => {
  assert.equal(operatorForEmail('sarah@linkstours.com', operators)?.id, 1);
});

test('operatorForEmail never lets a personal-mail domain in, only the exact contact', () => {
  assert.equal(operatorForEmail('stranger@gmail.com', operators), null);
  assert.equal(operatorForEmail('guy@gmail.com', operators)?.id, 3);
});

test('operatorForEmail ignores retired accounts and junk', () => {
  assert.equal(operatorForEmail('ops@oldco.ie', operators), null);
  assert.equal(operatorForEmail('someone@oldco.ie', operators), null);
  assert.equal(operatorForEmail('not-an-email', operators), null);
  assert.equal(operatorForEmail('', operators), null);
});

test('portalSignInLink trims trailing slashes and encodes the token', () => {
  assert.equal(
    portalSignInLink('https://democlub.teemail.io/', 'a+b'),
    'https://democlub.teemail.io/portal/sign-in?token=a%2Bb',
  );
});

const booking = {
  bookingId: 'B-1',
  date: '2026-10-10',
  teeTime: 'Not Specified',
  players: 8,
  status: 'Confirmed',
  total: 3440,
  notes: 'internal',
  payment: { paid: 1000, outstanding: 2440, dueDate: '2026-09-20', overdue: true, daysOverdue: 9 },
};

test('portalBooking exposes the trade view, not internal notes', () => {
  const view = portalBooking(booking, { payable: true });
  assert.equal(view.teeTime, null);
  assert.equal(view.outstanding, 2440);
  assert.equal(view.overdue, true);
  assert.equal(view.canPay, true);
  assert.equal('notes' in view, false);
});

test('portalBooking only offers payment when online payment is set up and something is owed on a live booking', () => {
  assert.equal(portalBooking(booking, { payable: false }).canPay, false);
  assert.equal(portalBooking({ ...booking, status: 'Cancelled' }, { payable: true }).canPay, false);
  assert.equal(portalBooking({ ...booking, status: 'Inquiry' }, { payable: true }).canPay, false);
  assert.equal(portalBooking({ ...booking, payment: { outstanding: 0 } }, { payable: true }).canPay, false);
});

test('isCurrent keeps future rounds and anything still owing', () => {
  assert.equal(isCurrent({ date: '2026-10-01', outstanding: 0 }, '2026-09-29'), true);
  assert.equal(isCurrent({ date: '2026-01-01', outstanding: 50 }, '2026-09-29'), true);
  assert.equal(isCurrent({ date: '2026-01-01', outstanding: 0 }, '2026-09-29'), false);
});

test('statementCsv quotes awkward cells and includes every booking', () => {
  const csv = statementCsv([portalBooking({ ...booking, golfCourses: 'North, South' })], { currency: 'EUR' });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Total \(EUR\)/);
  assert.match(lines[1], /"North, South"/);
  assert.match(lines[1], /3440\.00,1000\.00,2440\.00/);
});

test('buildEnquiry validates the date and party size', () => {
  assert.match(buildEnquiry({ date: 'soon', players: 0 }, operators[0], 'a@b.c').error, /date.*players/i);
});

test('buildEnquiry writes an email the club can act on', () => {
  const out = buildEnquiry(
    { date: '2026-11-02', players: '12', course: 'Old Course', notes: 'Buggies x2' },
    operators[0],
    'sarah@linkstours.com',
  );
  assert.equal(out.error, undefined);
  assert.match(out.subject, /12 players on 2026-11-02 - Links Tours/);
  assert.match(out.body, /Requested by: sarah@linkstours.com/);
  assert.match(out.body, /Buggies x2/);
  assert.match(out.summary, /\(Old Course\)/);
});

test('statementCsv defuses spreadsheet formulas but keeps amounts numeric', () => {
  const csv = statementCsv([
    portalBooking({ ...booking, golfCourses: '=HYPERLINK("http://evil","x")', guestName: '@me' }),
  ]);
  const row = csv.trim().split('\r\n')[1];
  assert.match(row, /"'=HYPERLINK\(""http:\/\/evil"",""x""\)"/);
  assert.doesNotMatch(row, /,=/);
  assert.match(row, /3440\.00,1000\.00,2440\.00/);
});
