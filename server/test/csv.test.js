import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvLine, neutraliseFormula } from '../src/lib/csv.js';

test('cells a spreadsheet would run as a formula are made text', () => {
  assert.equal(neutraliseFormula('=HYPERLINK("http://x","click")'), `'=HYPERLINK("http://x","click")`);
  assert.equal(neutraliseFormula('+1+cmd|calc'), "'+1+cmd|calc");
  assert.equal(neutraliseFormula('-2+3'), "'-2+3");
  assert.equal(neutraliseFormula('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(neutraliseFormula('\t=1'), "'\t=1");
  assert.equal(neutraliseFormula('\r=1'), "'\r=1");
});

test('numbers, and strings that are only a number, pass untouched', () => {
  assert.equal(neutraliseFormula(-12.5), '-12.5');
  assert.equal(neutraliseFormula('-12.50'), '-12.50', 'a refund stays a number');
  assert.equal(neutraliseFormula('3440.00'), '3440.00');
  assert.equal(neutraliseFormula(0), '0');
});

test('ordinary text, blanks and nulls are as they were', () => {
  assert.equal(neutraliseFormula('Links Tours'), 'Links Tours');
  assert.equal(neutraliseFormula('a=b'), 'a=b', 'only a leading character counts');
  assert.equal(neutraliseFormula(null), '');
  assert.equal(neutraliseFormula(undefined), '');
});

test('csvCell neutralises before it quotes', () => {
  assert.equal(csvCell('=1,2'), `"'=1,2"`);
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvLine(['=cmd', 2, 'North, South']), `'=cmd,2,"North, South"`);
});

test('an .xlsx row defuses formula-like strings and keeps other types', async () => {
  const { defuseRow } = await import('../src/lib/csv.js');
  const row = defuseRow({ name: '=HYPERLINK("x")', total: 12.5, refund: '-5', paid: true, extra: 'dropped' }, [
    'name',
    'total',
    'refund',
    'paid',
  ]);
  assert.deepEqual(row, { name: `'=HYPERLINK("x")`, total: 12.5, refund: '-5', paid: true });
});
