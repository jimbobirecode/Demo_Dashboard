/**
 * Who the club is writing to, and what to call them.
 *
 * A booking carries its lead guest's name and address, but the person writing
 * in is often somebody else: much of a club's trade comes through tour
 * operators, secretaries and friends booking for a group. The lead guest may
 * never have emailed the club at all.
 *
 * So the dashboard names the correspondent from the address it is replying to,
 * not from the booking. Only where the two are the same address is the
 * booking's name used - otherwise the composer titles, the greeting a quick
 * reply opens with and the notice after sending would all call an operator by
 * the name of the guest they booked for.
 */
export function correspondent({ email = '', leadGuestEmail = '', leadGuestName = '' } = {}) {
  const to = address(email);
  const isLeadGuest = Boolean(to) && to === address(leadGuestEmail);
  const name = isLeadGuest ? String(leadGuestName ?? '').trim() : '';
  return {
    email: to,
    name,
    isLeadGuest,
    /** What to show on screen: their name when we know it is theirs, else the address. */
    label: name || to,
    /** What a greeting opens with, or '' for a plain "Hello," - never a guessed name. */
    firstName: name.split(/\s+/)[0] ?? '',
  };
}

const address = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/**
 * Mailbox and company names that are not a person to be greeted by.
 *
 * The club would rather open with "Hello," than "Hi Bookings," or "Hi
 * Halcyon," -- so would whoever is reading it. An operator account's name is
 * the agency's, and a shared mailbox writes itself as a department, so neither
 * is a first name however confident we are that it is the right label.
 */
const NOT_A_PERSON = new Set([
  'accounts',
  'admin',
  'bookings',
  'contact',
  'enquiries',
  'enquiry',
  'general',
  'golf',
  'hello',
  'info',
  'information',
  'mail',
  'no-reply',
  'noreply',
  'office',
  'reservations',
  'sales',
  'support',
  'team',
  'travel',
]);

/**
 * The first name a reply opens with, or '' for a plain "Hello,".
 *
 * `who` is a correspondent: either the one the server described from the
 * club's records, or one of this module's own. Only a name we believe belongs
 * to one person is used.
 */
export function greetingFirstName(who) {
  if (!who) return '';
  // An agency, or an address that books for several people, is nobody to greet.
  if (who.kind === 'operator' || who.kind === 'shared') return '';
  const name = String(who.name ?? '').trim();
  if (!name) return '';
  // A mailbox's punctuation, as in "Bookings | Halcyon Golf Travel".
  if (/[|/@,;:()[\]<>]/.test(name)) return '';
  const first = name.split(/\s+/)[0] ?? '';
  if (first.length < 2) return '';
  if (NOT_A_PERSON.has(first.toLowerCase().replace(/[.]+$/, ''))) return '';
  // "SWING GOLF IRELAND" is a signature, not how anybody is addressed.
  if (first === first.toUpperCase() && first.length > 3) return '';
  return first;
}

/**
 * The booking's lead guest, where they are somebody other than the person the
 * club is writing to -- a name to mention, never a name to address.
 *
 * Returns '' when there is nobody else to name: when the lead guest is the
 * correspondent, when the booking has no name, or when the name column is only
 * the address spelled out again, as older rows have it. In each of those a
 * second line naming them again reads as two people where there is one.
 */
export function leadGuestAside(booking, who = null) {
  const name = String(booking?.guestName ?? booking?.leadGuestName ?? '').trim();
  if (!name) return '';
  if (who?.isLeadGuest) return '';
  const theirs = [who?.email, who?.name, booking?.guestEmail].map((value) =>
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
  // With no correspondent to compare against, the booking's own address is
  // still worth checking: that is the case the older rows fail.
  if (theirs.includes(name.toLowerCase())) return '';
  return name;
}
