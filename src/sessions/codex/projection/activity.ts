import type { Activity, CaptureSummary } from '../../../core/contracts/index.js';
import { ACTIVE_GAP_CAP_MS, activeMinutesFromTimestamps, localDate } from '../support/time.js';
import type { ParsedSession } from './types.js';

export function clipSessionToDate(session: ParsedSession, date: string, timezone: string): Activity | null {
  const targetTimes = session.activityTimestamps
    .map((timestamp) => Date.parse(timestamp))
    .filter((time) => Number.isFinite(time) && localDate(new Date(time).toISOString(), timezone) === date)
    .sort((a, b) => a - b);
  if (!targetTimes.length) return null;

  const clippedStart = targetTimes[0];
  const clippedEnd = targetTimes.at(-1);
  if (clippedStart === undefined || clippedEnd === undefined || clippedEnd < clippedStart) return null;
  const durationReliable = targetTimes.length >= 2;
  const durationMinutes = durationReliable ? activeMinutesFromTimestamps(targetTimes) : null;
  // 每次工具执行都是真实 occurrence，保留合法的相同命令重试。
  const commands = session.commands;
  const userMessages = unique(session.userMessages);
  const capture = finalizeCaptureSummary(session);

  return {
    file: session.file,
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    gitBranch: session.gitBranch,
    gitSha: session.gitSha,
    originalStartedAt: session.startedAt,
    originalEndedAt: session.endedAt,
    startedAt: new Date(clippedStart).toISOString(),
    endedAt: new Date(clippedEnd).toISOString(),
    activeMinutes: durationMinutes,
    durationMinutes,
    observedSpanMinutes: Math.max(0, Math.round((clippedEnd - clippedStart) / 60000)),
    durationReliable,
    hadReplayBurst: session.hadReplayBurst,
    durationReason: durationReliable
      ? `目标日期内活跃事件间隔累计，单段空闲超过 ${ACTIVE_GAP_CAP_MS / 60000} 分钟按上限截断${session.hadReplayBurst ? '；已先排除上下文恢复/重放事件' : ''}`
      : '会话包含上下文恢复/重放时间戳，无法从日志可靠还原真实执行时长',
    targetDateActivityCount: targetTimes.length,
    firstUserMessage: session.userMessages[0] || '',
    userMessages,
    assistantMessages: session.assistantMessages,
    changedFiles: [...session.changedFiles],
    commandCount: commands.length,
    commands,
    errors: session.errors,
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    rootSessionId: session.rootSessionId || session.id,
    continuedFromPreviousDate: Boolean(
      session.startedAt && localDate(session.startedAt, timezone) < date,
    ),
    ...(session.previousUserMessage || session.previousAssistantMessage
      ? {
          previousContext: {
            userMessage: session.previousUserMessage,
            assistantMessage: session.previousAssistantMessage,
          },
        }
      : {}),
    capture,
  };
}

function finalizeCaptureSummary(session: ParsedSession): CaptureSummary {
  if (session.capture.replayDroppedCount) {
    session.capture.reasons.add('已排除上下文恢复/重放事件');
  }
  const relevant = session.capture.relevantEventCount;
  const accounted = session.capture.capturedEventCount
    + session.capture.duplicateCount
    + session.capture.replayDroppedCount;
  const ratio = relevant ? accounted / relevant : 1;
  const coverage: CaptureSummary['coverage'] = ratio < 0.6
    || session.capture.unhandledEventTypes.size > 2
    ? 'low'
    : session.capture.reasons.size
      ? 'partial'
      : 'high';
  return {
    mode: session.capture.mode,
    coverage,
    rawEventCount: session.capture.rawEventCount,
    relevantEventCount: relevant,
    capturedEventCount: session.capture.capturedEventCount,
    duplicateCount: session.capture.duplicateCount,
    replayDroppedCount: session.capture.replayDroppedCount,
    rollbackCount: session.capture.rollbackCount,
    abortedTurnCount: session.capture.abortedTurnCount,
    compactionCount: session.capture.compactionCount,
    truncatedCount: session.capture.truncatedCount,
    unhandledEventTypes: [...session.capture.unhandledEventTypes].sort(),
    reasons: [...session.capture.reasons],
  };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
