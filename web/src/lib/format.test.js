import { describe, expect, test } from 'vitest';
import { formatCurrency, formatDate, formatDateTime, formatNumber } from './format.js';
import { nextStage, normaliseStatus, statusColor, STATUS_COLORS } from './status.js';

describe('format helpers', () => {
  test('anything that is not a number reads as a dash, never NaN', () => {
    expect(formatNumber('abc')).toBe('—');
    expect(formatCurrency(undefined)).toBe('—');
    expect(formatNumber(1234)).toBe('1,234');
  });

  test('whole amounts drop the pence; part amounts keep two places', () => {
    expect(formatCurrency(430)).toMatch(/^€430$/);
    expect(formatCurrency(430.5)).toMatch(/^€430\.50$/);
  });

  test('a date-only value is the same day whatever the browser time zone', () => {
    expect(formatDate('2026-03-18')).toBe('18 Mar 2026');
    expect(formatDate('2026-03-18T23:30:00-05:00')).toBe('18 Mar 2026');
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not a date')).toBe('—');
  });

  test('timestamps render in the club time zone', () => {
    expect(formatDateTime('2026-07-01T13:30:00Z')).toBe('01 Jul 2026, 14:30');
    expect(formatDateTime('')).toBe('—');
  });
});

describe('status helpers', () => {
  test('retired spellings read as the status they became', () => {
    expect(normaliseStatus('Pending')).toBe('Inquiry');
    expect(normaliseStatus('confirmed')).toBe('Booked');
    expect(normaliseStatus('booked')).toBe('Booked');
    expect(normaliseStatus('')).toBe('Inquiry');
    expect(statusColor('Confirmed')).toBe(STATUS_COLORS.Booked);
  });

  test('the pipeline moves forward and stops at the end', () => {
    expect(nextStage('Inquiry')).toBe('Requested');
    expect(nextStage('Requested')).toBe('Booked');
    expect(nextStage('Booked')).toBeNull();
    expect(nextStage('Cancelled')).toBeNull();
  });
});
