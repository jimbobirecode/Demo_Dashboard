/**
 * CSV cells that are safe to open in a spreadsheet.
 *
 * A cell that starts with = + - or @ is read by Excel, Sheets and LibreOffice
 * as a formula, and some of what lands in an export — a guest's name, a note,
 * a course typed into a form — was written by somebody outside the club. A
 * leading tab or carriage return is treated the same way by some of them.
 * Such a cell is prefixed with a single quote, which every one of those
 * programs shows as text and does not evaluate.
 *
 * Numbers pass through untouched, including a string that is nothing but a
 * number ("-12.50"): a refund is negative, and quoting it would turn it into
 * text the accounts team could not add up. A numeric string cannot carry a
 * formula, so letting it through costs nothing.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function neutraliseFormula(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  const text = String(value);
  if (PLAIN_NUMBER.test(text)) return text;
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** One cell: neutralised, then quoted when it holds a comma, quote or newline. */
export function csvCell(value) {
  const text = neutraliseFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values) {
  return values.map(csvCell).join(',');
}
