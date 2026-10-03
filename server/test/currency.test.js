import test from 'node:test';
import assert from 'node:assert/strict';
import { toCurrencyCode } from '../src/lib/currency.js';
import {
  formatAccountMoney,
  serialiseOperator,
  toOperatorColumns,
  validateOperator,
  describeTerms,
} from '../src/lib/operators-domain.js';

test('a currency typed as a symbol or a word reads as its ISO code', () => {
  for (const value of ['EUR', 'eur', ' Eur ', '€', 'euro', 'Euros']) assert.equal(toCurrencyCode(value), 'EUR', value);
  assert.equal(toCurrencyCode('£'), 'GBP');
  assert.equal(toCurrencyCode('sterling'), 'GBP');
  assert.equal(toCurrencyCode('$'), 'USD');
  assert.equal(toCurrencyCode('usd'), 'USD');
});

test('a euro sign mangled on its way through a console still reads as EUR', () => {
  // "€" as UTF-8 read as Windows-1252, and with its middle byte lost - the
  // value that took the Tour Operators page down ("Invalid currency code : â¬").
  assert.equal(toCurrencyCode('â‚¬'), 'EUR');
  assert.equal(toCurrencyCode('â\u0082¬'), 'EUR');
  assert.equal(toCurrencyCode('â¬'), 'EUR');
  assert.equal(toCurrencyCode('Â£'), 'GBP');
});

test('anything that is not a currency falls back', () => {
  assert.equal(toCurrencyCode('XYZ1', 'EUR'), 'EUR');
  assert.equal(toCurrencyCode('', 'EUR'), 'EUR');
  assert.equal(toCurrencyCode(null, 'GBP'), 'GBP');
  assert.equal(toCurrencyCode('banana'), null);
});

test('an operator saved with a bad currency no longer breaks its terms or balances', () => {
  const operator = serialiseOperator({
    id: 1,
    name: 'Links Trail',
    currency: 'â\u0082¬',
    credit_limit: 20000,
    payment_terms_days: 30,
  });
  assert.equal(operator.currency, 'EUR');
  assert.match(describeTerms(operator), /€20,000/);
  assert.equal(formatAccountMoney(1500, '€'), '€1,500');
  assert.equal(formatAccountMoney(1500, 'nonsense'), '€1,500');
});

test('the operator form stores a real code and refuses what is not a currency', () => {
  assert.equal(toOperatorColumns({ name: 'X', currency: '€' }).currency, 'EUR');
  assert.equal(toOperatorColumns({ name: 'X', currency: 'gbp' }).currency, 'GBP');
  assert.equal(validateOperator({ name: 'X', currency: '€' }), null);
  assert.match(validateOperator({ name: 'X', currency: 'banana' }), /not a currency/);
});
