import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { MAX_SHEET_ROWS, SheetTooLargeError, cellValue, checkRowCount, readXlsxRows } from '../src/lib/sheet-reader.js';

async function workbook(rows, { extraSheet = false } = {}) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Tee sheet');
  rows.forEach((row) => sheet.addRow(row));
  if (extraSheet) book.addWorksheet('Notes').addRow(['ignored']);
  return Buffer.from(await book.xlsx.writeBuffer());
}

test('reads the first sheet as rows of plain values, dates and formulas included', async () => {
  const played = new Date(Date.UTC(2026, 9, 18));
  const buffer = await workbook(
    [
      ['Date', 'Name', 'Players', 'Total'],
      [played, 'Ann Guest', 4, { formula: 'C2*100', result: 400 }],
    ],
    { extraSheet: true },
  );

  const rows = await readXlsxRows(buffer);
  assert.equal(rows.length, 2, 'only the first sheet');
  assert.deepEqual(rows[0], ['Date', 'Name', 'Players', 'Total']);
  assert.ok(rows[1][0] instanceof Date, 'a date cell arrives as a Date, not a serial number');
  assert.equal(rows[1][0].toISOString().slice(0, 10), '2026-10-18');
  assert.equal(rows[1][2], 4);
  assert.equal(rows[1][3], 400, 'a formula reads as what it showed');
});

test('a sheet past the ceiling is refused, not truncated', async () => {
  const buffer = await workbook(Array.from({ length: 12 }, (_, i) => [`row ${i}`]));
  await assert.rejects(readXlsxRows(buffer, { maxRows: 10 }), SheetTooLargeError);
  assert.equal((await readXlsxRows(buffer, { maxRows: 12 })).length, 12);
});

test('very wide rows are cut to the column limit', async () => {
  const buffer = await workbook([Array.from({ length: 50 }, (_, i) => i)]);
  assert.equal((await readXlsxRows(buffer, { maxColumns: 10 }))[0].length, 10);
});

test('CSV rows face the same ceiling', () => {
  assert.equal(MAX_SHEET_ROWS, 20_000);
  assert.throws(() => checkRowCount(new Array(11).fill(['x']), 10), /more than 10 rows/);
  assert.equal(checkRowCount([['x']], 10).length, 1);
});

test('cellValue flattens rich text and hyperlinks', () => {
  assert.equal(cellValue({ richText: [{ text: 'Old ' }, { text: 'Course' }] }), 'Old Course');
  assert.equal(cellValue({ text: 'link', hyperlink: 'https://x' }), 'link');
  assert.equal(cellValue(null), '');
});
