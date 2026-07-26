import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SourceConfig } from '../../core/config.js';
import { expandHome } from '../../core/paths.js';
import { stateDirectory } from '../../core/paths.js';
import type { Activity, ActivitySourceBatch, CaptureSummary, RunContext, SourcePlugin } from '../../core/contracts/index.js';
import { mergedActiveDurationMinutes, mergedDurationMinutes } from '../../core/activity-duration.js';
import { discoverSessionFiles, loadTitleIndex } from './storage/files.js';
import { captureCodexDay } from './capture/capture.js';
import { parseSessionEvents } from './projection/parse.js';
import type { NormalizedCodexEvent, ReadJsonlRecord, RuntimeCapture } from './capture/ledger-types.js';
import {
  buildSessionManifest,
  loadCodexSourceCache,
  refreshSessionManifest,
  saveCodexSourceCache,
} from './storage/source-cache.js';

export class CodexSource implements SourcePlugin {
  readonly name = 'codex' as const;

  async collect(context: RunContext, config: SourceConfig): Promise<ActivitySourceBatch> {
    const sessionsDir = expandHome(config.sessionsDir || join(homedir(), '.codex', 'sessions'));
    const sessionRoots = config.sessionsDir
      ? [sessionsDir]
      : [sessionsDir, join(homedir(), '.codex', 'archived_sessions')];
    const indexPath = expandHome(config.sessionIndex || join(homedir(), '.codex', 'session_index.jsonl'));
    const titleIndex = await loadTitleIndex(indexPath);
    const files = await discoverSessionFiles(sessionRoots, context.date);
    const cacheDirectory = !config.sessionsDir
      ? join(
          stateDirectory(),
          'captures',
          createHash('sha256').update(`${sessionRoots.join('\n')}\n${context.timezone}`).digest('hex').slice(0, 16),
        )
      : '';
    const sourceCacheFile = cacheDirectory
      ? join(cacheDirectory, `${context.date}.source.json`)
      : '';
    const snapshotCacheFile = cacheDirectory
      ? join(cacheDirectory, `${context.date}.snapshot.json`)
      : '';
    const manifest = await buildSessionManifest(files);
    const configKey = JSON.stringify({
      workSemanticVersion: 6,
      includeAssistantMessages: config.includeAssistantMessages ?? true,
      includeToolOutput: config.includeToolOutput ?? true,
      dayEndTime: config.dayEndTime || '23:30',
    });
    const cachedCandidate = cacheDirectory
      ? await loadCodexSourceCache(sourceCacheFile, {
          date: context.date,
          timezone: context.timezone,
          configKey,
        })
      : null;
    const refreshedManifest = cachedCandidate
      ? await refreshSessionManifest(cachedCandidate.manifest, manifest, context.date, context.timezone)
      : null;
    const cached = cachedCandidate && refreshedManifest
      ? { ...cachedCandidate, manifest: refreshedManifest }
      : null;
    if (cached && cacheDirectory) {
      await saveCodexSourceCache(sourceCacheFile, cached);
    }
    let runtimeCapture: RuntimeCapture | null = null;
    let sourceActivities: Activity[];
    let captureSummary: CaptureSummary;
    if (cached) {
      sourceActivities = cached.sourceActivities;
      captureSummary = cached.captureSummary;
    } else {
      runtimeCapture = await captureCodexDay(
        sessionsDir,
        context.date,
        context.timezone,
        new Date(),
        {
          files,
          finalizationCutoff: config.dayEndTime || '23:30',
          ...(snapshotCacheFile ? { cacheFile: snapshotCacheFile } : {}),
        },
      );
      const parsed = files.map((file) => {
          const capture = runtimeCapture as RuntimeCapture;
          const activity = parseSessionEvents(
            file,
            confirmedProjectionRecords(capture, file, context.date).map((record) => record.event),
            titleIndex,
            context,
            config,
          );
          if (activity) {
            activity.capture = sessionLedgerCapture(
              capture.events.filter((event) => event.sessionId === activity.id),
              context.date,
              activity.capture,
            );
            activity.hadReplayBurst = activity.capture.replayDroppedCount > 0;
            if (activity.hadReplayBurst && activity.durationReliable && !activity.durationReason.includes('重放')) {
              activity.durationReason += '；已先排除上下文恢复/重放事件';
            }
          }
          return activity;
        });
      const rootBySession = new Map(
        (runtimeCapture?.events || []).map((event) => [event.sessionId, event.rootSessionId || event.sessionId]),
      );
      const parsedActivities = parsed.filter((item): item is Activity => item !== null);
      for (const activity of parsedActivities) {
        activity.rootSessionId = rootBySession.get(activity.id) || activity.rootSessionId || activity.id;
      }
      sourceActivities = mergeSubagentActivities(parsedActivities)
        .filter((activity) => activity.userMessages.length > 0 || activity.commands.length > 0);
      captureSummary = runtimeCapture
        ? ledgerCaptureSummary(runtimeCapture.events, context.date, sourceActivities)
        : aggregateCaptureSummary(sourceActivities);
      if (cacheDirectory && runtimeCapture?.snapshot.finalized) {
        await saveCodexSourceCache(sourceCacheFile, {
          version: 2,
          date: context.date,
          timezone: context.timezone,
          configKey,
          manifest,
          snapshot: runtimeCapture.snapshot,
          captureSummary,
          sourceActivities,
        });
      }
    }
    const snapshot = runtimeCapture?.snapshot || cached?.snapshot;
    return {
      date: context.date,
      timezone: context.timezone,
      generatedAt: new Date().toISOString(),
      workspace: process.cwd(),
      sourceCount: sourceActivities.length,
      activities: sourceActivities,
      captureSummary,
      ...(snapshot ? { captureSnapshot: snapshot } : {}),
      ...(snapshot && snapshotCacheFile ? { captureSnapshotPath: snapshotCacheFile } : {}),
    };
  }
}

function confirmedProjectionRecords(
  capture: RuntimeCapture,
  file: string,
  date: string,
): ReadJsonlRecord[] {
  const states = new Map(
    capture.events
      .filter((event) => event.source.file === file)
      .map((event) => [event.source.byteStart, event]),
  );
  return (capture.recordsByFile.get(file) || []).filter((record) => {
    const state = states.get(record.source.byteStart);
    if (!state || state.localDate !== date) return true;
    if (['rollback', 'abort'].includes(state.kind)) return false;
    return state.disposition === 'included' && state.lifecycle === 'confirmed';
  });
}

function ledgerCaptureSummary(
  events: NormalizedCodexEvent[],
  date: string,
  activities: Activity[],
): CaptureSummary {
  const base = sessionLedgerCapture(events, date);
  base.truncatedCount = activities.reduce(
    (total, activity) => total + (activity.capture?.truncatedCount || 0),
    0,
  );
  if (base.truncatedCount) addReason(base, '部分超长消息或工具输出已截断');
  return base;
}

function sessionLedgerCapture(
  events: NormalizedCodexEvent[],
  date: string,
  parserCapture?: CaptureSummary,
): CaptureSummary {
  const target = events.filter((event) => event.localDate === date);
  const relevant = target.filter((event) => !['session_metadata', 'telemetry'].includes(event.kind));
  const rollbackCount = target
    .filter((event) => event.kind === 'rollback')
    .reduce((total, event) => {
      const value = event.raw.payload?.num_turns;
      return total + (typeof value === 'number' && Number.isFinite(value) ? Math.max(1, value) : 1);
    }, 0);
  const abortedTurnCount = target.filter((event) => event.kind === 'abort').length;
  const compactionCount = target.filter((event) => event.kind === 'context_compacted').length;
  const duplicateCount = target.filter((event) => event.disposition === 'duplicate').length;
  const replayDroppedCount = target.filter((event) => event.disposition === 'replay').length;
  const unhandledEventTypes = [...new Set(
    target.filter((event) => event.disposition === 'unsupported').map((event) => event.representation),
  )].sort();
  const reasons: string[] = [];
  if (compactionCount) reasons.push('会话发生过上下文压缩');
  if (abortedTurnCount) reasons.push('已排除被中断的轮次');
  if (rollbackCount) reasons.push('已排除被回滚的轮次');
  if (replayDroppedCount) reasons.push('已排除上下文恢复/重放事件');
  if (unhandledEventTypes.length) reasons.push('存在尚未识别的相关事件类型');
  if (parserCapture?.truncatedCount) reasons.push('部分超长消息或工具输出已截断');
  const coverage: CaptureSummary['coverage'] = unhandledEventTypes.length
    ? 'low'
    : reasons.length
      ? 'partial'
      : 'high';
  return {
    mode: 'precise',
    coverage,
    rawEventCount: target.length,
    relevantEventCount: relevant.length,
    capturedEventCount: relevant.filter((event) => (
      event.disposition === 'included' && event.lifecycle === 'confirmed'
    )).length,
    duplicateCount,
    replayDroppedCount,
    rollbackCount,
    abortedTurnCount,
    compactionCount,
    truncatedCount: parserCapture?.truncatedCount || 0,
    unhandledEventTypes,
    reasons,
  };
}

function addReason(summary: CaptureSummary, reason: string): void {
  if (!summary.reasons.includes(reason)) summary.reasons.push(reason);
  if (summary.coverage === 'high') summary.coverage = 'partial';
}

function mergeSubagentActivities(activities: Activity[]): Activity[] {
  const groups = new Map<string, Activity[]>();
  for (const activity of activities) {
    const root = activity.rootSessionId || activity.parentSessionId || activity.id;
    const values = groups.get(root) || [];
    values.push(activity);
    groups.set(root, values);
  }
  const result: Activity[] = [];
  for (const [root, values] of groups) {
    const parent = values.find((activity) => activity.id === root)
      || values.find((activity) => !activity.parentSessionId)
      || values[0];
    if (!parent) continue;
    parent.rootSessionId = root;
    for (const child of values) {
      if (child === parent) continue;
      // 每次工具执行都是真实 occurrence，不能再按 command + cwd 合并合法重试。
      parent.commands.push(...child.commands);
      parent.commandCount = parent.commands.length;
      parent.changedFiles = uniqueStrings([...parent.changedFiles, ...child.changedFiles]);
      parent.errors = uniqueStrings([...parent.errors, ...child.errors]);
      parent.assistantMessages = uniqueStrings([...parent.assistantMessages, ...child.assistantMessages]);
      parent.targetDateActivityCount += child.targetDateActivityCount;
      parent.capture = aggregateCaptureSummary(
        [parent, child],
      );
    }
    if (values.length > 1) {
      const durationReliable = values.every((activity) => activity.durationReliable);
      const starts = values.map((activity) => activity.startedAt).filter(Boolean).sort();
      const ends = values.map((activity) => activity.endedAt).filter(Boolean).sort();
      parent.startedAt = starts[0] || parent.startedAt;
      parent.endedAt = ends.at(-1) || parent.endedAt;
      parent.durationReliable = durationReliable;
      parent.durationMinutes = durationReliable ? mergedActiveDurationMinutes(values) : null;
      parent.activeMinutes = parent.durationMinutes;
      parent.observedSpanMinutes = mergedDurationMinutes(values);
      parent.durationReason = durationReliable
        ? `父子 Agent 活跃时长按 ${values.length} 个会话区间去重合并`
        : '父子 Agent 中存在无法可靠计时的会话';
    }
    result.push(parent);
  }
  return result;
}

function aggregateCaptureSummary(
  activities: Activity[],
): CaptureSummary {
  const captures = activities.map((activity) => activity.capture).filter((value) => value !== undefined);
  const sum = (key: keyof CaptureSummary) => captures.reduce((total, capture) => {
    const value = capture[key];
    return total + (typeof value === 'number' ? value : 0);
  }, 0);
  const reasons = uniqueStrings(captures.flatMap((capture) => capture.reasons));
  const unhandledEventTypes = uniqueStrings(captures.flatMap((capture) => capture.unhandledEventTypes));
  const coverage: CaptureSummary['coverage'] = captures.some((capture) => capture.coverage === 'low')
    ? 'low'
    : captures.some((capture) => capture.coverage === 'partial')
      ? 'partial'
      : 'high';
  return {
    mode: 'precise',
    coverage,
    rawEventCount: sum('rawEventCount'),
    relevantEventCount: sum('relevantEventCount'),
    capturedEventCount: sum('capturedEventCount'),
    duplicateCount: sum('duplicateCount'),
    replayDroppedCount: sum('replayDroppedCount'),
    rollbackCount: sum('rollbackCount'),
    abortedTurnCount: sum('abortedTurnCount'),
    compactionCount: sum('compactionCount'),
    truncatedCount: sum('truncatedCount'),
    unhandledEventTypes,
    reasons,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
