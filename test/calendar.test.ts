import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  assertLocalDate,
  dateSkipReason,
  isLastWorkdayOfMonth,
  isValidLocalDate,
  isWeekendLocalDate,
  localDateString,
  periodDates,
  weekdayForLocalDate,
  yesterdayLocalDateString,
} from '../src/core/calendar.js';

describe('calendar', () => {
  it('formats dates and yesterday in the configured timezone', () => {
    const midnightInShanghai = new Date('2026-07-14T16:00:00.000Z');

    expect(localDateString(midnightInShanghai, 'Asia/Shanghai')).toBe('2026-07-15');
    expect(localDateString(midnightInShanghai, 'UTC')).toBe('2026-07-14');
    expect(yesterdayLocalDateString(midnightInShanghai, 'Asia/Shanghai')).toBe('2026-07-14');
  });

  it('uses calendar arithmetic across month and leap-year boundaries', () => {
    expect(addLocalDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addLocalDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addLocalDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('rejects malformed and impossible calendar dates', () => {
    expect(isValidLocalDate('2026-02-29')).toBe(false);
    expect(isValidLocalDate('2024-02-29')).toBe(true);
    expect(() => assertLocalDate('../2026-07-15')).toThrow('Expected YYYY-MM-DD');
    expect(() => addLocalDays('2026-07-15', 0.5)).toThrow('integer day offset');
  });

  it('matches the legacy weekend and skip-date reasons', () => {
    expect(isWeekendLocalDate('2026-07-18')).toBe(true);
    expect(isWeekendLocalDate('2026-07-19')).toBe(true);
    expect(isWeekendLocalDate('2026-07-15')).toBe(false);
    expect(weekdayForLocalDate('2026-07-15')).toBe('wed');
    expect(dateSkipReason('2026-07-15', ['2026-07-15'])).toBe('date_in_skip_list');
    expect(dateSkipReason('2026-07-18', ['2026-07-18'])).toBe('weekend_no_record');
    expect(dateSkipReason('2026-07-16')).toBeNull();
  });

  it('cuts fixed workweeks and workmonths without weekends', () => {
    expect(periodDates('week', '2026-07-15')).toEqual([
      '2026-07-13', '2026-07-14', '2026-07-15',
    ]);
    expect(periodDates('month', '2026-07-06', ['2026-07-03'])).toEqual([
      '2026-07-01', '2026-07-02', '2026-07-06',
    ]);
  });

  it('recognizes the last non-skipped workday of a month', () => {
    expect(isLastWorkdayOfMonth('2026-07-31')).toBe(true);
    expect(isLastWorkdayOfMonth('2026-07-30')).toBe(false);
    expect(isLastWorkdayOfMonth('2026-07-30', ['2026-07-31'])).toBe(true);
  });
});
