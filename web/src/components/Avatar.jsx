/**
 * Initials on a tinted disc, for a person or an account.
 *
 * The tint is picked from the name, so the same guest is the same colour on
 * every screen and across reloads — which is the only thing the colour is for.
 * It carries no meaning: every pairing is one of the status tints already in
 * use, each measured at 4.5:1 or better, but none of them says anything about
 * the booking. The name beside it does that.
 */
const TINTS = [
  ['#e4eceb', '#1a5e58'],
  ['#dbeafe', '#1d4ed8'],
  ['#fef3c7', '#92400e'],
  ['#f3f4f6', '#4b5563'],
  ['#e0e7ef', '#2f5d7c'],
];

/** Up to two initials; an email address gives its first letter. */
export function initialsOf(name) {
  const text = String(name ?? '').trim();
  if (!text) return '?';
  const local = text.includes('@') ? text.split('@')[0] : text;
  const words = local
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (!words.length) return '?';
  const first = words[0][0];
  const second = words.length > 1 ? words[words.length - 1][0] : '';
  return (first + second).toUpperCase();
}

/** A stable index into TINTS for a string. */
export function tintIndexOf(name) {
  let hash = 0;
  for (const char of String(name ?? '')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % TINTS.length;
}

export default function Avatar({ name, size = 32 }) {
  const [background, color] = TINTS[tintIndexOf(name)];
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, background, color, fontSize: Math.round(size * 0.38) }}
    >
      {initialsOf(name)}
    </span>
  );
}
