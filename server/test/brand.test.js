/**
 * The club profile, and what survives a service that was configured by hand.
 *
 * Both of these were found in one real email on the County Louth install: a
 * booking confirmation that went out signed with the wrong club's name, in the
 * wrong teal, with a dead manage-booking link. The code was right and the
 * deployment was missing CLUB_FULL_NAME, EMAIL_BRAND_COLOR and a scheme on
 * APP_URL — none of which anything complained about, because every one of them
 * had a quiet fallback that was wrong.
 *
 * The scheme fix is tested here because it is a property of the code. The
 * name fallback is NOT the same as on that install: this is the demo, whose
 * defaults are deliberately TeeMail's. See `src/lib/brand.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAND, DEFAULT_APP_URL, appBaseUrl } from '../src/lib/brand.js';

test('an address with no scheme is still an address, not a relative path', () => {
  // The bug: APP_URL="democlub.teemail.io" went into an email as
  // href="democlub.teemail.io/manage-booking?..." — which a mail client
  // resolves against its own base, so the link was dead in every email sent.
  // It reads correctly in the HTML source, which is why it survived.
  assert.equal(appBaseUrl({ APP_URL: 'democlub.teemail.io' }), 'https://democlub.teemail.io');
  assert.equal(appBaseUrl({ APP_URL: 'democlub.teemail.io/' }), 'https://democlub.teemail.io');
  assert.equal(appBaseUrl({ PUBLIC_URL: 'dash.example.com' }), 'https://dash.example.com');

  // A scheme that is already there is left exactly as it is.
  assert.equal(appBaseUrl({ APP_URL: 'https://dash.example.com/' }), 'https://dash.example.com');
  assert.equal(appBaseUrl({ APP_URL: 'http://localhost:5173' }), 'http://localhost:5173');

  // And nothing configured is still an absolute address, never a blank.
  assert.equal(appBaseUrl({}), DEFAULT_APP_URL);
  assert.match(DEFAULT_APP_URL, /^https:\/\//);
});

test('every emailed link is absolute, whatever the service was given', () => {
  // The property that matters, rather than the spellings above: a link in an
  // email has no page to be relative to.
  for (const value of ['democlub.teemail.io', 'https://x.example', 'x.example/', '']) {
    const base = appBaseUrl(value ? { APP_URL: value } : {});
    assert.match(base, /^https?:\/\/[^/]+/, `${JSON.stringify(value)} produced "${base}"`);
    assert.doesNotMatch(base, /\/$/, 'no trailing slash, so paths append cleanly');
  }
});

test('the profile is complete when the environment is empty', () => {
  // This is the demo install, so the fallback is the vendor rather than a
  // club: there is no one club here to lose the name of. A club served from
  // this deployment sets the CLUB_* variables.
  assert.equal(BRAND.fullName, 'TeeMail Golf Club');
  assert.equal(BRAND.fromName, 'TeeMail Golf Club', 'the name on the From line');
  assert.equal(BRAND.name, 'TeeMail');
  assert.equal(BRAND.clubId, 'teemail');

  assert.equal(BRAND.locale, 'en-GB');
  assert.equal(BRAND.currency, 'EUR');
  assert.equal(BRAND.timeZone, 'Europe/London');

  // The footer's contact line, which was simply absent when these were unset.
  // The values matter less than the line existing at all.
  assert.ok(BRAND.address, 'the footer has an address');
  assert.match(BRAND.phone, /^\+/, 'a dialable number');
  assert.match(BRAND.website, /^https:\/\//, 'an absolute website link');
});

test('an environment-configured club overrides every default', async () => {
  // The demo's defaults must never leak into a club that has set its own —
  // that override is the whole mechanism by which this one deployment serves
  // any club, and the thing a real install depends on. County Louth's values
  // are used here precisely because they are not this install's: if any of
  // them came back as TeeMail's, the override would be broken.
  //
  // BRAND is built at import time, so the environment is set first and the
  // module re-imported under a fresh URL to get past the ESM cache.
  const before = { ...process.env };
  Object.assign(process.env, {
    CLUB_ID: 'county_louth',
    CLUB_NAME: 'Baltray',
    CLUB_FULL_NAME: 'County Louth Golf Club',
    CLUB_PHONE: '+353 41 988 1530',
    CLUB_ADDRESS: 'Baltray, Drogheda, Co. Louth, Ireland',
    CLUB_WEBSITE: 'https://www.countylouthgolfclub.com',
    CLUB_LOCALE: 'en-IE',
    CLUB_CURRENCY: 'EUR',
    CLUB_TIMEZONE: 'Europe/Dublin',
    DEFAULT_COURSE: 'Championship Links',
  });
  try {
    const { BRAND: configured } = await import('../src/lib/brand.js?configured');
    assert.equal(configured.clubId, 'county_louth');
    assert.equal(configured.name, 'Baltray');
    assert.equal(configured.fullName, 'County Louth Golf Club');
    assert.equal(configured.fromName, 'County Louth Golf Club');
    assert.equal(configured.defaultCourse, 'Championship Links');
    assert.equal(configured.phone, '+353 41 988 1530');
    assert.equal(configured.website, 'https://www.countylouthgolfclub.com');
    assert.equal(configured.locale, 'en-IE');
    assert.equal(configured.timeZone, 'Europe/Dublin');

    assert.ok(!JSON.stringify(configured).includes('TeeMail'), 'no demo default is left anywhere a guest can read it');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});
