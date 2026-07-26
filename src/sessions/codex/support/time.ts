import type { ParsedSession, JsonEvent, ReplayBurst } from '../projection/types.js';

const REPLAY_BURST_MS = 1000;
const REPLAY_BURST_USER_THRESHOLD = 5;
const REPLAY_BURST_FUNCTION_THRESHOLD = 30;
export const ACTIVE_GAP_CAP_MS = 15 * 60 * 1000;

export function detectReplayBursts(
  events: JsonEvent[],
  date: string,
  timezone: string,
): ReplayBurst[] {
  const targetEvents = events
    .filter((event) => isTargetDateEvent(event, date, timezone))
    .map((event) => ({ event, time: Date.parse(event.timestamp || '') }))
    .filter((item) => Number.isFinite(item.time))
    .sort((a, b) => a.time - b.time);
  const bursts: ReplayBurst[] = [];
  for (let startIndex = 0; startIndex < targetEvents.length; startIndex += 1) {
    const start = targetEvents[startIndex]?.time;
    if (start === undefined) continue;
    let userCount = 0;
    let functionCount = 0;
    let endIndex = startIndex;
    for (; endIndex < targetEvents.length; endIndex += 1) {
      const item = targetEvents[endIndex];
      if (!item || item.time - start > REPLAY_BURST_MS) break;
      const payload = item.event.payload || {};
      if (
        (item.event.type === 'event_msg' && payload.type === 'user_message')
        || (item.event.type === 'response_item' && payload.type === 'message' && payload.role === 'user')
      ) userCount += 1;
      if (
        item.event.type === 'response_item'
        && ['function_call', 'custom_tool_call'].includes(String(payload.type || ''))
      ) functionCount += 1;
    }
    if (userCount > REPLAY_BURST_USER_THRESHOLD || functionCount > REPLAY_BURST_FUNCTION_THRESHOLD) {
      bursts.push({ start, end: start + REPLAY_BURST_MS });
      startIndex = Math.max(startIndex, endIndex - 1);
    }
  }
  return bursts;
}

export function isReplayBurstEvent(event: JsonEvent, replayBursts: ReplayBurst | ReplayBurst[] | null): boolean {
  if (!replayBursts) return false;
  const time = Date.parse(event.timestamp || '');
  const bursts = Array.isArray(replayBursts) ? replayBursts : [replayBursts];
  return Number.isFinite(time) && bursts.some((burst) => time >= burst.start && time <= burst.end);
}

export function isTargetDateEvent(event: JsonEvent, date: string, timezone: string): boolean {
  if (!event.timestamp) return false;
  const time = Date.parse(event.timestamp);
  return Number.isFinite(time) && localDate(event.timestamp, timezone) === date;
}

export function collectActivityTimestamp(event: JsonEvent, session: ParsedSession): void {
  if (event.timestamp) session.activityTimestamps.push(event.timestamp);
}

export function activeMinutesFromTimestamps(timestamps: number[]): number {
  let total = 0;
  for (let index = 1; index < timestamps.length; index += 1) {
    const previous = timestamps[index - 1];
    const current = timestamps[index];
    if (previous === undefined || current === undefined) continue;
    const gap = current - previous;
    if (!Number.isFinite(gap) || gap <= 0) continue;
    total += Math.min(gap, ACTIVE_GAP_CAP_MS);
  }
  return Math.max(1, Math.round(total / 60000));
}

export function localDate(timestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function addDays(date: string, offset: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}
