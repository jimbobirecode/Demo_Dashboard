import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  DECISION_EMAIL_KINDS,
  MEMBERSHIP_EMAIL_KINDS,
  MEMBERSHIP_STATUSES,
  OPEN_STATUSES,
  STATUS_LABELS,
  TERMINAL_STATUSES,
  TRANSITIONS,
  applicantName,
  buildMembershipEmail,
  canTransition,
  CSV_COLUMNS,
  describeCategoryFees,
  describeEvent,
  firstYearTotal,
  formatFee,
  isMembershipReference,
  isMembershipStatus,
  DEFAULT_MEMBERSHIP_CONTACT_EMAIL,
  membershipContactEmail,
  membershipFormBaseUrl,
  membershipLink,
  membershipSecret,
  membershipUrlFor,
  mintMembershipReference,
  nextStatuses,
  serialiseApplication,
  serialiseCategory,
  serialiseEvent,
  signMembership,
  transitionPlan,
  validateCategory,
  validateMembershipSettings,
  verifyMembershipToken,
} from '../src/lib/membership-domain.js';

const SECRET = 'membership-test-secret';

/* ---------- statuses ---------- */

test('the statuses are the contract’s nine, each labelled and with a transition list', () => {
  assert.deepEqual(MEMBERSHIP_STATUSES, [
    'enquired',
    'submitted',
    'under_review',
    'approved',
    'declined',
    'welcomed',
    'waitlisted',
    'invited',
    'withdrawn',
  ]);
  for (const status of MEMBERSHIP_STATUSES) {
    assert.ok(STATUS_LABELS[status], status);
    assert.ok(Array.isArray(TRANSITIONS[status]), status);
    for (const next of TRANSITIONS[status]) assert.ok(isMembershipStatus(next), `${status} → ${next}`);
  }
  assert.deepEqual(OPEN_STATUSES, ['enquired', 'invited', 'waitlisted']);
  assert.equal(isMembershipStatus('nope'), false);
});

test('review runs submitted → under_review → approved | declined, then approved → welcomed', () => {
  assert.ok(canTransition('submitted', 'under_review'));
  assert.ok(canTransition('under_review', 'approved'));
  assert.ok(canTransition('under_review', 'declined'));
  assert.ok(canTransition('approved', 'welcomed'));
  assert.ok(canTransition('waitlisted', 'invited'));
  for (const open of ['enquired', 'invited', 'waitlisted']) assert.ok(canTransition(open, 'withdrawn'), open);

  assert.equal(canTransition('submitted', 'approved'), false, 'no skipping review');
  assert.equal(canTransition('enquired', 'approved'), false);
  assert.equal(canTransition('approved', 'declined'), false);
  assert.equal(canTransition('submitted', 'withdrawn'), false);
  assert.equal(canTransition('nonsense', 'submitted'), false);
  assert.deepEqual(nextStatuses('nonsense'), []);
});

test('declined, withdrawn and welcomed are the end of the road', () => {
  assert.deepEqual(TERMINAL_STATUSES.sort(), ['declined', 'welcomed', 'withdrawn']);
  for (const status of TERMINAL_STATUSES) {
    for (const to of MEMBERSHIP_STATUSES) assert.equal(canTransition(status, to), false, `${status} → ${to}`);
  }
});

test('a transition plan records who decided, the note and the email to send', () => {
  const approve = transitionPlan('under_review', 'approved', { actor: 'sec', note: '  Welcome aboard ' });
  assert.equal(approve.ok, true);
  assert.deepEqual(approve.sets, {
    status: 'approved',
    decided_by: 'sec',
    decided_at: 'now',
    decision_note: 'Welcome aboard',
  });
  assert.equal(approve.event, 'status:approved');
  assert.equal(approve.emailKind, 'membership_approved');

  const decline = transitionPlan('under_review', 'declined', { actor: 'sec' });
  assert.equal(decline.sets.decision_note, undefined, 'no note, nothing written');
  assert.equal(decline.emailKind, 'membership_declined');

  const review = transitionPlan('submitted', 'under_review', { actor: 'sec' });
  assert.deepEqual(review.sets, { status: 'under_review' });
  assert.equal(review.emailKind, 'membership_under_review');

  const welcome = transitionPlan('approved', 'welcomed', { actor: 'sec' });
  assert.equal(welcome.sets.welcomed_at, 'now');
  assert.equal(welcome.emailKind, 'membership_welcome');

  const withdraw = transitionPlan('enquired', 'withdrawn', { actor: 'sec' });
  assert.equal(withdraw.emailKind, null, 'withdrawing sends nothing');
});

test('an invalid transition is refused with a reason that names the way forward', () => {
  const skip = transitionPlan('submitted', 'approved', { actor: 'sec' });
  assert.equal(skip.ok, false);
  assert.match(skip.error, /Submitted can only move to Under review/);
  const done = transitionPlan('declined', 'approved', { actor: 'sec' });
  assert.match(done.error, /cannot change any more/);
  assert.match(transitionPlan('mystery', 'approved').error, /mystery/);
});

test('every decision email kind is one of the contract kinds', () => {
  for (const kind of Object.values(DECISION_EMAIL_KINDS)) assert.ok(MEMBERSHIP_EMAIL_KINDS.includes(kind), kind);
  assert.equal(MEMBERSHIP_EMAIL_KINDS.length, 9);
});

/* ---------- reference and links ---------- */

test('a reference is MEM-YYYYMMDD-XXXXXXXX from the UTC date and a crypto-random tail', () => {
  const ref = mintMembershipReference(new Date('2026-10-04T23:30:00Z'));
  assert.match(ref, /^MEM-20261004-[A-Z0-9]{8}$/);
  assert.ok(isMembershipReference(ref));
  assert.equal(isMembershipReference('MEM-2026104-ABCDEFGH'), false);
  assert.equal(isMembershipReference('mem-20261004-abcdefgh'), false);
  assert.equal(isMembershipReference(null), false);

  const fixed = mintMembershipReference(new Date('2026-01-02T00:00:00Z'), () => 0);
  assert.equal(fixed, 'MEM-20260102-AAAAAAAA');
  const last = mintMembershipReference(new Date('2026-01-02T00:00:00Z'), (n) => n - 1);
  assert.equal(last, 'MEM-20260102-99999999');

  const many = new Set(Array.from({ length: 200 }, () => mintMembershipReference()));
  assert.equal(many.size, 200);
});

test('the token is the contract HMAC: base64url, unpadded, 32 characters, scoped to club and reference', () => {
  const ref = 'MEM-20261004-ABCD1234';
  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(`royal_dornoch|membership|${ref}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 32);
  const token = signMembership(ref, SECRET, 'royal_dornoch');
  assert.equal(token, expected);
  assert.equal(token.length, 32);

  assert.equal(verifyMembershipToken(ref, token, SECRET, 'royal_dornoch'), true);
  assert.equal(verifyMembershipToken(ref, token, SECRET, 'other_club'), false, 'not another club');
  assert.equal(verifyMembershipToken('MEM-20261004-ZZZZ9999', token, SECRET, 'royal_dornoch'), false);
  assert.equal(verifyMembershipToken(ref, token, 'wrong-secret', 'royal_dornoch'), false);
  assert.equal(verifyMembershipToken(ref, token.slice(0, 31), SECRET, 'royal_dornoch'), false);
  assert.equal(verifyMembershipToken(ref, '', SECRET, 'royal_dornoch'), false);
  assert.equal(verifyMembershipToken(ref, token, null, 'royal_dornoch'), false, 'no secret, no access');
  assert.equal(signMembership(ref, null), null);
  assert.equal(signMembership('', SECRET), null);
  assert.notEqual(signMembership(ref, SECRET), signMembership(ref, SECRET, 'royal_dornoch'));
});

test('links need BOOKING_LINK_SECRET itself — JWT_SECRET alone signs nothing the core API could check', () => {
  assert.equal(membershipSecret({ JWT_SECRET: 'jwt' }), null);
  assert.equal(membershipSecret({ BOOKING_LINK_SECRET: 'shared', JWT_SECRET: 'jwt' }), 'shared');
  assert.equal(membershipSecret({}), null);
});

test('the membership secret is trimmed, so a stray space in one host signs the same links as the core API', () => {
  assert.equal(membershipSecret({ BOOKING_LINK_SECRET: '  shared\n' }), 'shared');
  assert.equal(membershipSecret({ BOOKING_LINK_SECRET: '   ', JWT_SECRET: 'jwt' }), null);
  const app = { reference: 'MEM-20261004-ABCD1234', club: 'royal_dornoch' };
  const base = { MEMBERSHIP_FORM_BASE_URL: 'https://core.example' };
  assert.equal(
    membershipUrlFor(app, 'apply', { ...base, BOOKING_LINK_SECRET: 'shared \r\n' }),
    membershipUrlFor(app, 'apply', { ...base, BOOKING_LINK_SECRET: 'shared' }),
  );
});

test('links are built on MEMBERSHIP_FORM_BASE_URL, to the apply or waitlist form', () => {
  assert.equal(
    membershipFormBaseUrl({ MEMBERSHIP_FORM_BASE_URL: ' https://core.example/// ' }),
    'https://core.example',
  );
  assert.equal(membershipFormBaseUrl({ MEMBERSHIP_FORM_BASE_URL: '' }), null);
  assert.equal(membershipFormBaseUrl({}), null);

  assert.equal(
    membershipLink('https://core.example/', 'apply', 'MEM-20261004-ABCD1234', 'tok+/='),
    'https://core.example/membership/apply?ref=MEM-20261004-ABCD1234&token=tok%2B%2F%3D',
  );
  assert.match(membershipLink('https://core.example', 'waitlist', 'R', 'T'), /\/membership\/waitlist\?ref=R&token=T$/);

  const env = { BOOKING_LINK_SECRET: SECRET, MEMBERSHIP_FORM_BASE_URL: 'https://core.example' };
  const url = new URL(membershipUrlFor({ reference: 'MEM-20261004-ABCD1234', club: 'rd' }, 'apply', env));
  assert.equal(url.pathname, '/membership/apply');
  assert.equal(url.searchParams.get('token'), signMembership('MEM-20261004-ABCD1234', SECRET, 'rd'));
  assert.match(membershipUrlFor({ reference: 'MEM-20261004-ABCD1234' }, 'waitlist', env), /\/membership\/waitlist\?/);

  assert.equal(membershipUrlFor({ reference: 'R', club: 'rd' }, 'apply', { BOOKING_LINK_SECRET: SECRET }), null);
  assert.equal(
    membershipUrlFor({ reference: 'R', club: 'rd' }, 'apply', { MEMBERSHIP_FORM_BASE_URL: 'https://x' }),
    null,
  );
  assert.equal(membershipUrlFor({ club: 'rd' }, 'apply', env), null);
});

/* ---------- settings ---------- */

test('settings keep the five known keys, trimmed, and drop the rest', () => {
  const check = validateMembershipSettings({
    intro: '  Thanks for your interest ',
    next_steps: 'Pay fees',
    closed_message: 'Closed for now',
    contact_email: 'memberships@club.teemail.io',
    committee_name: 'The Membership Committee',
    extra: 'dropped',
    committee: '',
  });
  assert.equal(check.ok, true);
  assert.deepEqual(check.value, {
    intro: 'Thanks for your interest',
    next_steps: 'Pay fees',
    closed_message: 'Closed for now',
    contact_email: 'memberships@club.teemail.io',
    committee_name: 'The Membership Committee',
  });
  assert.deepEqual(validateMembershipSettings({ intro: '   ' }).value, {}, 'blank is left out');
  assert.deepEqual(validateMembershipSettings(undefined).value, {});
});

test('settings are length-limited and the contact email must look like one', () => {
  assert.match(validateMembershipSettings({ intro: 'x'.repeat(2001) }).errors[0], /Introduction must be 2000/);
  assert.match(validateMembershipSettings({ committee_name: 'x'.repeat(121) }).errors[0], /Committee name/);
  assert.match(validateMembershipSettings({ contact_email: 'not-an-email' }).errors[0], /email address/);
  assert.match(validateMembershipSettings({ next_steps: 42 }).errors[0], /must be text/);
  assert.equal(validateMembershipSettings([]).ok, false);
  assert.equal(validateMembershipSettings('text').ok, false);
});

/* ---------- categories ---------- */

test('a category needs a name and sane fees and ages', () => {
  const ok = validateCategory({
    name: ' Intermediate ',
    description: 'For younger adults',
    eligibility: 'Ages 19–29',
    joiningFee: '500',
    annualFee: 900.456,
    minAge: 19,
    maxAge: '29',
    sortOrder: 3,
  });
  assert.equal(ok.ok, true, ok.errors.join());
  assert.deepEqual(ok.value, {
    name: 'Intermediate',
    description: 'For younger adults',
    eligibility: 'Ages 19–29',
    joining_fee: 500,
    annual_fee: 900.46,
    min_age: 19,
    max_age: 29,
    sort_order: 3,
    active: true,
  });

  const snake = validateCategory({ name: 'Junior', joining_fee: 0, annual_fee: 250, max_age: 18, active: false });
  assert.equal(snake.value.annual_fee, 250);
  assert.equal(snake.value.min_age, null);
  assert.equal(snake.value.active, false);

  const errors = (body) => validateCategory(body).errors.join(' | ');
  assert.match(errors({}), /A name is required/);
  assert.match(errors({ name: 'x'.repeat(81) }), /Name must be 80/);
  assert.match(errors({ name: 'A', joiningFee: -1 }), /Joining fee must be between 0 and 100,000/);
  assert.match(errors({ name: 'A', annualFee: 100001 }), /Annual subscription/);
  assert.match(errors({ name: 'A', annualFee: 'lots' }), /Annual subscription/);
  assert.match(errors({ name: 'A', minAge: 12.5 }), /Minimum age must be a whole number/);
  assert.match(errors({ name: 'A', maxAge: 150 }), /Maximum age/);
  assert.match(errors({ name: 'A', minAge: 30, maxAge: 20 }), /cannot be above/);
  assert.match(errors({ name: 'A', sortOrder: 'first' }), /Sort order/);
  assert.match(errors({ name: 42 }), /Name must be text/);
  assert.match(errors({ name: 'A', description: 'x'.repeat(1001) }), /Description/);
  assert.equal(validateCategory(null).ok, false);
  assert.equal(validateCategory({ name: 'A', joiningFee: '', minAge: '' }).value.joining_fee, 0);
});

/* ---------- serialising ---------- */

test('rows serialise to the shape the page reads', () => {
  const app = serialiseApplication({
    id: 7,
    reference: 'MEM-20261004-ABCD1234',
    kind: 'application',
    status: 'under_review',
    category_id: 2,
    category_name: 'Full',
    first_name: 'Isla',
    last_name: 'Munro',
    email: 'isla@example.com',
    date_of_birth: new Date('1990-05-06T00:00:00Z'),
    recommended_category_ids: [2, '3'],
    consent: true,
    submitted_at: '2026-10-01T10:00:00Z',
    created_at: new Date('2026-09-30T09:00:00Z'),
  });
  assert.equal(app.name, 'Isla Munro');
  assert.equal(app.statusLabel, 'Under review');
  assert.deepEqual(app.nextStatuses, ['approved', 'declined']);
  assert.equal(app.dateOfBirth, '1990-05-06');
  assert.deepEqual(app.recommendedCategoryIds, [2, 3]);
  assert.equal(app.submittedAt, '2026-10-01T10:00:00.000Z');
  assert.equal(app.decidedAt, null);
  assert.equal(app.phone, '');
  assert.equal(app.postcode, '');
  assert.equal(app.otherClubs, '');
  assert.equal(app.cdhNumber, '');

  const detailed = serialiseApplication({
    id: 8,
    status: 'waitlisted',
    address: '4 Castle Street, Dornoch',
    postcode: 'IV25 3SN',
    home_club: 'Tain Golf Club',
    other_clubs: 'Brora Golf Club',
    cdh_number: '1000000101',
    handicap: '11.2',
  });
  assert.equal(detailed.address, '4 Castle Street, Dornoch');
  assert.equal(detailed.postcode, 'IV25 3SN');
  assert.equal(detailed.homeClub, 'Tain Golf Club');
  assert.equal(detailed.otherClubs, 'Brora Golf Club');
  assert.equal(detailed.cdhNumber, '1000000101');

  const bare = serialiseApplication({
    id: 1,
    reference: 'R',
    status: 'weird',
    email: 'a@b.c',
    date_of_birth: '1980-01-02',
  });
  assert.equal(bare.statusLabel, 'weird');
  assert.deepEqual(bare.recommendedCategoryIds, []);
  assert.equal(bare.dateOfBirth, '1980-01-02');
  assert.equal(serialiseApplication({ id: 1, status: 'enquired', date_of_birth: 'junk' }).dateOfBirth, null);

  assert.equal(applicantName({ firstName: 'A', lastName: '' }), 'A');

  const category = serialiseCategory({
    id: 1,
    name: 'Full',
    joining_fee: '2500.00',
    annual_fee: '1850.00',
    applications: '4',
  });
  assert.equal(category.joiningFee, 2500);
  assert.equal(category.annualFee, 1850);
  assert.equal(category.active, true);
  assert.equal(category.applications, 4);
  assert.equal(serialiseCategory({ id: 2, name: 'X', active: false }).applications, undefined);

  const event = serialiseEvent({ id: 1, event: 'status:approved', actor: 'sec', created_at: '2026-10-01T10:00:00Z' });
  assert.equal(event.label, 'Moved to Approved');
  assert.equal(event.note, '');
});

test('events read as sentences', () => {
  assert.equal(describeEvent('enquired'), 'Enquiry received');
  assert.equal(describeEvent('note'), 'Note');
  assert.equal(describeEvent('status:under_review'), 'Moved to Under review');
  assert.equal(describeEvent('status:odd'), 'Moved to odd');
  assert.equal(describeEvent('email:membership_welcome'), 'Welcome email sent');
  assert.equal(describeEvent('email:custom'), 'Email sent (custom)');
  assert.equal(describeEvent('something_else'), 'something_else');
  assert.equal(describeEvent(null), '');
});

/* ---------- money and emails ---------- */

const FULL = { name: 'Full', joiningFee: 2500, annualFee: 1850 };
const JUNIOR = { name: 'Junior', joining_fee: 0, annual_fee: 250 };
const APPLICATION = { reference: 'MEM-20261004-ABCD1234', firstName: 'Isla Rose', email: 'isla@example.com' };
const ENV = { MEMBERSHIP_CONTACT_EMAIL: 'club@example.com', REPLY_TO_EMAIL: 'desk@example.com' };

test('fees are spelled in the club currency, whole amounts without pennies', () => {
  assert.equal(formatFee(2500, 'EUR', 'en-GB'), '€2,500');
  assert.equal(formatFee(99.5, 'EUR', 'en-GB'), '€99.50');
  assert.equal(formatFee('junk', 'GBP', 'en-GB'), '£0');
  assert.equal(describeCategoryFees(FULL, 'EUR'), 'Full: joining fee €2,500, annual subscription €1,850');
  assert.equal(describeCategoryFees(JUNIOR, 'EUR'), 'Junior: no joining fee, annual subscription €250');
  assert.equal(describeCategoryFees(null), '');
  assert.equal(firstYearTotal(FULL), 4350);
  assert.equal(firstYearTotal(JUNIOR), 250);
  assert.equal(firstYearTotal(null), 0);
});

test('each decision email is warm, names the category with its fees and says what happens next', () => {
  const settings = {
    committee_name: 'The Membership Committee',
    next_steps: 'Collect your bag tag from the pro shop.',
  };
  const under = buildMembershipEmail({
    kind: 'under_review',
    application: APPLICATION,
    category: FULL,
    settings,
    currency: 'EUR',
    env: ENV,
  });
  assert.match(under.subject, /with The Membership Committee/);
  assert.match(under.text, /^Dear Isla,/);
  assert.match(under.text, /MEM-20261004-ABCD1234/);
  assert.match(under.text, /You applied for Full: joining fee €2,500, annual subscription €1,850\./);
  assert.match(under.text, /club@example\.com/);
  assert.match(under.html, /Joining fee €2,500 · Annual subscription €1,850/);

  const approved = buildMembershipEmail({
    kind: 'approved',
    application: APPLICATION,
    category: FULL,
    settings,
    note: 'Delighted to have you.',
    currency: 'EUR',
    env: ENV,
  });
  assert.match(approved.subject, /approved/);
  assert.match(approved.text, /€4,350/);
  assert.match(approved.text, /Delighted to have you\./);
  assert.match(approved.text, /bag tag/);

  const free = buildMembershipEmail({
    kind: 'approved',
    application: APPLICATION,
    category: { name: 'Honorary', joiningFee: 0, annualFee: 0 },
    currency: 'EUR',
    env: {},
  });
  assert.match(free.text, /welcome pack/);
  assert.doesNotMatch(free.text, /amount due/);
  assert.match(free.text, /write to memberships@club\.teemail\.io\./, 'the default membership address');

  const declined = buildMembershipEmail({
    kind: 'declined',
    application: APPLICATION,
    note: 'The list is full.',
    env: ENV,
  });
  assert.match(declined.text, /not able to offer you membership/);
  assert.match(declined.text, /The list is full\./);
  assert.match(declined.text, /Membership, /, 'signed by Membership when no committee is named');

  const welcome = buildMembershipEmail({
    kind: 'welcomed',
    application: APPLICATION,
    category: FULL,
    settings: { contact_email: 'memberships@club.teemail.io' },
    currency: 'EUR',
    env: ENV,
  });
  assert.match(welcome.subject, /^Welcome to /);
  assert.match(welcome.text, /Fees payable: €4,350/);
  assert.match(welcome.text, /memberships@club\.teemail\.io/);
  assert.match(welcome.text, /locker/);

  const welcomeFree = buildMembershipEmail({
    kind: 'welcomed',
    application: APPLICATION,
    category: JUNIOR,
    currency: 'EUR',
    env: {},
  });
  assert.match(welcomeFree.text, /€250/);
  const welcomeBare = buildMembershipEmail({ kind: 'welcomed', application: { reference: 'R' }, env: {} });
  assert.match(welcomeBare.text, /^Dear there,/);
  assert.match(welcomeBare.text, /starts straight away/);
  assert.match(welcomeBare.text, /Write to memberships@club\.teemail\.io/);
});

test('an invitation carries the signed apply link as a button and in the text', () => {
  const link = 'https://core.example/membership/apply?ref=MEM-20261004-ABCD1234&token=abc';
  const invite = buildMembershipEmail({
    kind: 'invited',
    application: APPLICATION,
    category: JUNIOR,
    link,
    currency: 'EUR',
    env: ENV,
  });
  assert.match(invite.subject, /applications are open/);
  assert.match(invite.text, new RegExp(`Apply for membership: ${link.replace(/[?]/g, '\\?')}`));
  assert.match(
    invite.html,
    /href="https:\/\/core\.example\/membership\/apply\?ref=MEM-20261004-ABCD1234&amp;token=abc"/,
  );
  assert.match(invite.text, /interested in Junior: no joining fee/);

  const noLink = buildMembershipEmail({ kind: 'invited', application: APPLICATION, env: ENV });
  assert.match(noLink.text, /reply to this email and we will send you an application form/);
  assert.doesNotMatch(noLink.html, /Apply for membership<\/a>/);
});

test('everything from outside is escaped in the HTML', () => {
  const email = buildMembershipEmail({
    kind: 'declined',
    application: { reference: 'MEM-1', firstName: '<img src=x onerror=alert(1)>' },
    category: { name: '<b>Full</b>', joiningFee: 1, annualFee: 1 },
    settings: { committee_name: '<script>x</script>' },
    note: '"quoted" & <tag>',
    env: {},
  });
  assert.doesNotMatch(email.html, /<img src=x/);
  assert.doesNotMatch(email.html, /<script>x/);
  assert.doesNotMatch(email.html, /<b>Full<\/b>/);
  assert.match(email.html, /&quot;quoted&quot; &amp; &lt;tag&gt;/);
});

test('an unknown email kind is a programming error', () => {
  assert.throws(() => buildMembershipEmail({ kind: 'nope', application: APPLICATION }), /Unknown membership email/);
});

test('the CSV columns read from the serialised application', () => {
  const row = serialiseApplication({ id: 1, reference: 'R', status: 'approved', email: 'a@b.c', first_name: '=cmd' });
  const values = CSV_COLUMNS.map(([, pick]) => pick(row));
  assert.equal(values[0], 'R');
  assert.equal(values[1], 'Approved');
  assert.equal(values[3], '=cmd', 'defused by lib/csv.js when written');
  assert.ok(values.every((value) => typeof value === 'string'));

  const labels = CSV_COLUMNS.map(([label]) => label);
  for (const label of ['Address', 'Postcode', 'Handicap', 'CDH number', 'Home club', 'Other clubs']) {
    assert.ok(labels.includes(label), label);
  }
  const full = serialiseApplication({
    id: 2,
    status: 'submitted',
    postcode: 'IV25 3SN',
    other_clubs: 'Brora',
    cdh_number: 'X1',
  });
  const pick = (label) => CSV_COLUMNS.find(([l]) => l === label)[1](full);
  assert.equal(pick('Postcode'), 'IV25 3SN');
  assert.equal(pick('Other clubs'), 'Brora');
  assert.equal(pick('CDH number'), 'X1');
});

test('the token matches the core API’s cross-service test vector exactly', () => {
  // Verified on the core API side against the same contract.
  const token = signMembership('MEM-20261004-ABCDEFGH', 'test-secret', 'royal_dornoch');
  assert.equal(token, '6G-gH72yiTObhng71GzSOIjhJBwKH2MD');
  assert.ok(verifyMembershipToken('MEM-20261004-ABCDEFGH', token, 'test-secret', 'royal_dornoch'));
});

test('membership mail names the club setting, then MEMBERSHIP_CONTACT_EMAIL, then the default — never the booking desk', () => {
  assert.equal(DEFAULT_MEMBERSHIP_CONTACT_EMAIL, 'memberships@club.teemail.io');
  const desk = { REPLY_TO_EMAIL: 'desk@example.com', FROM_EMAIL: 'bookings@example.com' };
  assert.equal(membershipContactEmail({}, desk), 'memberships@club.teemail.io');
  assert.equal(
    membershipContactEmail({}, { ...desk, MEMBERSHIP_CONTACT_EMAIL: ' join@example.com ' }),
    'join@example.com',
  );
  assert.equal(membershipContactEmail({}, { ...desk, MEMBERSHIP_CONTACT_EMAIL: '  ' }), 'memberships@club.teemail.io');
  assert.equal(
    membershipContactEmail(
      { contact_email: 'sec@example.com' },
      { ...desk, MEMBERSHIP_CONTACT_EMAIL: 'join@example.com' },
    ),
    'sec@example.com',
  );
  assert.equal(membershipContactEmail(undefined, {}), 'memberships@club.teemail.io');

  for (const kind of ['under_review', 'approved', 'declined', 'welcomed', 'invited']) {
    const email = buildMembershipEmail({ kind, application: APPLICATION, env: desk });
    assert.match(email.text, /memberships@club\.teemail\.io/, kind);
    assert.match(email.html, /mailto:memberships@club\.teemail\.io/, `${kind} footer`);
    assert.doesNotMatch(email.text + email.html, /desk@example\.com|bookings@example\.com/, kind);
    assert.equal(email.replyTo, 'memberships@club.teemail.io', kind);
  }
  const own = buildMembershipEmail({
    kind: 'invited',
    application: APPLICATION,
    env: { ...desk, MEMBERSHIP_CONTACT_EMAIL: 'join@example.com' },
  });
  assert.match(own.text, /write to join@example\.com\./);
  assert.equal(own.replyTo, 'join@example.com');
});
