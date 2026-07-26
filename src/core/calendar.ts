const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type DateSkipReason = 'weekend_no_record' | 'date_in_skip_list';
export type WeekdayName = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

const WEEKDAYS: readonly WeekdayName[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

export function localDateString(
  date: Date,
  timezone = 'Asia/Shanghai',
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string | undefined => (
    parts.find((part) => part.type === type)?.value
  );
  const year = value('year');
  const month = value('month');
  const day = value('day');
  if (!year || !month || !day) {
    throw new Error(`Cannot format local date in timezone ${timezone}.`);
  }
  return `${year}-${month}-${day}`;
}

export function yesterdayLocalDateString(
  now = new Date(),
  timezone = 'Asia/Shanghai',
): string {
  return addLocalDays(localDateString(now, timezone), -1);
}

export function isValidLocalDate(date: string): boolean {
  try {
    parseLocalDate(date);
    return true;
  } catch {
    return false;
  }
}

export function assertLocalDate(date: string): void {
  parseLocalDate(date);
}

export function addLocalDays(date: string, days: number): string {
  const { year, month, day } = parseLocalDate(date);
  if (!Number.isInteger(days)) throw new Error(`Expected an integer day offset, received ${days}.`);

  // setUTCFullYear avoids Date.UTC's special handling of years 0-99.
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(year, month - 1, day + days);
  const result = formatDateParts({
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  });
  assertLocalDate(result);
  return result;
}

export function isWeekendLocalDate(date: string): boolean {
  const weekday = weekdayForLocalDate(date);
  return weekday === 'sun' || weekday === 'sat';
}

export function weekdayForLocalDate(date: string): WeekdayName {
  const { year, month, day } = parseLocalDate(date);
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(year, month - 1, day);
  const weekday = WEEKDAYS[value.getUTCDay()];
  if (!weekday) throw new Error(`Cannot determine weekday for ${date}.`);
  return weekday;
}

export function dateSkipReason(
  date: string,
  skipDates: readonly string[] = [],
): DateSkipReason | null {
  // 与旧任务保持一致：周末优先于显式跳过日期。
  if (isWeekendLocalDate(date)) return 'weekend_no_record';
  return skipDates.includes(date) ? 'date_in_skip_list' : null;
}

export function periodDates(
  unit: 'week' | 'month',
  endDate: string,
  skipDates: readonly string[] = [],
): string[] {
  assertLocalDate(endDate);
  let startDate = endDate;
  if (unit === 'week') {
    const weekday = WEEKDAYS.indexOf(weekdayForLocalDate(endDate));
    startDate = addLocalDays(endDate, -(weekday === 0 ? 6 : weekday - 1));
  } else {
    startDate = `${endDate.slice(0, 8)}01`;
  }
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addLocalDays(date, 1)) {
    if (!dateSkipReason(date, skipDates)) dates.push(date);
  }
  return dates;
}

export function isLastWorkdayOfMonth(date: string, skipDates: readonly string[] = []): boolean {
  if (dateSkipReason(date, skipDates)) return false;
  const month = date.slice(0, 7);
  for (let candidate = addLocalDays(date, 1); candidate.startsWith(month); candidate = addLocalDays(candidate, 1)) {
    if (!dateSkipReason(candidate, skipDates)) return false;
  }
  return true;
}

function parseLocalDate(date: string): LocalDateParts {
  const match = LOCAL_DATE_PATTERN.exec(date);
  if (!match) throw new Error(`Invalid date ${date}. Expected YYYY-MM-DD.`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    throw new Error(`Invalid calendar date: ${date}.`);
  }

  const lastDay = new Date(0);
  lastDay.setUTCHours(0, 0, 0, 0);
  lastDay.setUTCFullYear(year, month, 0);
  if (day > lastDay.getUTCDate()) throw new Error(`Invalid calendar date: ${date}.`);
  return { year, month, day };
}

function formatDateParts({ year, month, day }: LocalDateParts): string {
  if (year < 0 || year > 9999) throw new Error(`Date year is outside YYYY range: ${year}.`);
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}
