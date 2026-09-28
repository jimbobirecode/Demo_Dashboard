/**
 * Turning whatever somebody typed for a currency into the ISO 4217 code that
 * Intl.NumberFormat and Stripe need.
 *
 * A currency arrives from people, not only from code: a CLUB_CURRENCY set on
 * the host, an operator's currency typed into the form, a row pasted in through
 * a SQL console. "€" is the natural thing to type, and a console or an env
 * editor that is not UTF-8 all the way through turns it into "â‚¬" or "â¬".
 * Intl throws on any of those - and one bad value on one operator took the
 * whole Tour Operators page down - so every currency is read through here.
 */

const SYMBOLS = new Map([
  ['€', 'EUR'], ['EURO', 'EUR'], ['EUROS', 'EUR'],
  ['£', 'GBP'], ['POUND', 'GBP'], ['POUNDS', 'GBP'], ['STERLING', 'GBP'], ['GB£', 'GBP'],
  ['$', 'USD'], ['US$', 'USD'], ['DOLLAR', 'USD'], ['DOLLARS', 'USD'],
  ['C$', 'CAD'], ['CA$', 'CAD'], ['A$', 'AUD'], ['AU$', 'AUD'], ['NZ$', 'NZD'],
  ['¥', 'JPY'], ['CHF', 'CHF'], ['KR', 'SEK'],
]);

/** UTF-8 text that was read as Latin-1 ("â‚¬" for "€"), put back; anything else unchanged. */
function unmangle(text) {
  if (!/[À-ÿ]/.test(text)) return text;
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    // Windows-1252 puts "‚" where UTF-8's continuation byte 0x82 was.
    const cp1252 = { 0x201a: 0x82, 0x20ac: 0x80, 0x2019: 0x92 }[code];
    if (cp1252 !== undefined) bytes.push(cp1252);
    else if (code <= 0xff) bytes.push(code);
    else return text;
  }
  const decoded = Buffer.from(bytes).toString('utf8');
  return decoded.includes('�') ? text : decoded;
}

function isValidCode(code) {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}

/**
 * The ISO code for `value` ("EUR", "eur", "€", "euro", "â‚¬" all give "EUR"),
 * or `fallback` when it cannot be read as one.
 */
export function toCurrencyCode(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  let text = unmangle(String(value).trim());
  // "â¬": the invisible 0x82 of a mangled "€" was dropped along the way.
  if (text === 'â¬' || text === 'â\u0082¬') text = '€';
  const upper = text.toUpperCase().replace(/\s+/g, '');
  if (!upper) return fallback;
  if (SYMBOLS.has(upper)) return SYMBOLS.get(upper);
  if (SYMBOLS.has(text)) return SYMBOLS.get(text);
  return isValidCode(upper) ? upper : fallback;
}
