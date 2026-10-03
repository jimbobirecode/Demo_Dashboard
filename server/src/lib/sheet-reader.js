/**
 * Reading an uploaded spreadsheet without trusting its size.
 *
 * An .xlsx is a zip, and 8MB of zip can inflate to gigabytes of XML. Loading
 * the whole workbook (ExcelJS's `xlsx.load`) builds every cell in memory
 * before anything can say "too big", so the importer reads the first sheet as
 * a stream instead and stops the moment it passes MAX_SHEET_ROWS. A tee sheet
 * is a few thousand rows; anything past the ceiling is refused, not truncated,
 * because a silently shortened import looks complete.
 */
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';

/** Rows read from one upload before it is refused outright. */
export const MAX_SHEET_ROWS = 20_000;

/** Cells kept per row. A tee sheet has a dozen columns; the rest is noise. */
export const MAX_SHEET_COLUMNS = 100;

export class SheetTooLargeError extends Error {
  constructor(limit) {
    super(`That sheet has more than ${limit.toLocaleString('en-GB')} rows. Split it and upload each part.`);
    this.name = 'SheetTooLargeError';
  }
}

/** A cell as the tee sheet parser wants it: the value, or what a formula showed. */
export function cellValue(cell) {
  if (cell && typeof cell === 'object' && 'result' in cell) return cell.result;
  if (cell && typeof cell === 'object' && 'text' in cell) return cell.text;
  if (cell && typeof cell === 'object' && Array.isArray(cell.richText)) {
    return cell.richText.map((part) => part.text ?? '').join('');
  }
  return cell ?? '';
}

/**
 * The first worksheet's non-empty rows, as arrays of cell values.
 * Throws SheetTooLargeError past `maxRows`.
 */
export async function readXlsxRows(buffer, { maxRows = MAX_SHEET_ROWS, maxColumns = MAX_SHEET_COLUMNS } = {}) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([buffer]), {
    entries: 'emit',
    sharedStrings: 'cache',
    // Styles are what mark a number as a date; without them every date cell
    // would arrive as a serial number.
    styles: 'cache',
    hyperlinks: 'ignore',
    worksheets: 'emit',
  });

  const rows = [];
  for await (const worksheet of reader) {
    for await (const row of worksheet) {
      if (!row.hasValues) continue;
      if (rows.length >= maxRows) throw new SheetTooLargeError(maxRows);
      rows.push(row.values.slice(1, maxColumns + 1).map(cellValue));
    }
    // Only the first sheet is a tee sheet; the rest are never inflated.
    break;
  }
  return rows;
}

/** The same ceiling for CSV, which is parsed in full but cheaply. */
export function checkRowCount(rows, maxRows = MAX_SHEET_ROWS) {
  if (rows.length > maxRows) throw new SheetTooLargeError(maxRows);
  return rows;
}
