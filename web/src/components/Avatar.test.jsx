import { describe, expect, test } from 'vitest';
import { initialsOf, tintIndexOf } from './Avatar.jsx';
import { statusTone } from '../lib/status.js';
import { paymentTone } from '../lib/payments.js';

describe('initialsOf', () => {
  test('first and last name, however many are between', () => {
    expect(initialsOf('Anna Lindqvist')).toBe('AL');
    expect(initialsOf('Mary Jane van der Berg')).toBe('MB');
    expect(initialsOf('Cher')).toBe('C');
  });

  test('an account name ignores its punctuation', () => {
    expect(initialsOf('Harbour & Heath Golf Tours')).toBe('HT');
  });

  test('an email address gives what is before the @', () => {
    expect(initialsOf('groups@example.com')).toBe('G');
    expect(initialsOf('anna.lindqvist@example.com')).toBe('AL');
  });

  test('nothing to go on is a question mark, not a blank disc', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf(null)).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
});

describe('tintIndexOf', () => {
  test('the same name is always the same colour', () => {
    expect(tintIndexOf('Anna Lindqvist')).toBe(tintIndexOf('Anna Lindqvist'));
  });

  test('always a valid tint, whatever it is given', () => {
    for (const name of ['', null, undefined, 'a', 'Ünïcødé Ñame', 'x'.repeat(500)]) {
      const index = tintIndexOf(name);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(5);
    }
  });
});

describe('tones', () => {
  test('Booked is the only good news and Rejected the only bad', () => {
    expect(statusTone('Booked')).toBe('positive');
    expect(statusTone('Rejected')).toBe('negative');
    expect(statusTone('Cancelled')).toBe('closed');
    expect(statusTone('Inquiry')).toBe('neutral');
    expect(statusTone('Requested')).toBe('info');
  });

  test('a retired spelling takes the tone of the status it stands for', () => {
    expect(statusTone('Confirmed')).toBe('positive');
    expect(statusTone('Pending')).toBe('neutral');
  });

  test('unpaid is a warning, not an error: it is usually just not due yet', () => {
    expect(paymentTone('Unpaid')).toBe('warning');
    expect(paymentTone('Paid')).toBe('positive');
    expect(paymentTone('Refunded')).toBe('closed');
    expect(paymentTone('something new')).toBe('neutral');
  });
});
