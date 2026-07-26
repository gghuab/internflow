export interface TimedActivity {
  startedAt: string;
  endedAt: string;
  activeMinutes?: number | null;
  durationMinutes?: number | null;
}

export function mergedDurationMinutes(activities: TimedActivity[]): number {
  const intervals = activities
    .map((activity) => ({ start: Date.parse(activity.startedAt), end: Date.parse(activity.endedAt) }))
    .filter((interval) => Number.isFinite(interval.start)
      && Number.isFinite(interval.end)
      && interval.end >= interval.start)
    .sort((left, right) => left.start - right.start);
  let total = 0;
  let currentStart: number | null = null;
  let currentEnd: number | null = null;
  for (const interval of intervals) {
    if (currentStart === null || currentEnd === null) {
      currentStart = interval.start;
      currentEnd = interval.end;
      continue;
    }
    if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
      continue;
    }
    total += currentEnd - currentStart;
    currentStart = interval.start;
    currentEnd = interval.end;
  }
  if (currentStart !== null && currentEnd !== null) total += currentEnd - currentStart;
  return Math.round(total / 60_000);
}

export function mergedActiveDurationMinutes(activities: TimedActivity[]): number {
  const activeTotal = activities.reduce(
    (total, activity) => total + (activity.durationMinutes ?? activity.activeMinutes ?? 0),
    0,
  );
  if (activeTotal <= 0) return 0;

  // 并行活动只能占用同一段墙钟时间一次，活跃时长不得超过观察区间并集。
  return Math.min(activeTotal, Math.max(1, mergedDurationMinutes(activities)));
}
