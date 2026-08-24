import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createStarterConfig, type SourceConfig } from '../src/core/config.js';
import type {
  Activity,
  ActivitySourceBatch,
  CaptureSnapshot,
  RunContext,
  WorkEvidence,
} from '../src/core/contracts/index.js';
import { projectWorkday } from '../src/workflows/workday/index.js';

describe('workday workflow', () => {
  it('uses WorkItem as the only daily semantic route', () => {
    const context = runContext('daily-report');
    const captured = sourceBatch([
      activity('development', '修复 src/api.ts 登录接口'),
      activity('meta', '修改 Codex 日报生成脚本'),
    ], [
      evidence('request', 'development', 'request', '修复 src/api.ts 登录接口'),
      evidence('change', 'development', 'change', '修改 src/api.ts', ['src/api.ts']),
      evidence('meta-request', 'meta', 'request', '修改 Codex 日报生成脚本'),
    ]);

    const result = projectWorkday(captured, context, preciseConfig());

    expect(result).not.toHaveProperty('tasks');
    expect(result).not.toHaveProperty('longestTask');
    expect(result.workItems).toHaveLength(1);
    expect(result.dailyView?.items).toHaveLength(1);
    expect(result.activities.map((item) => item.id)).toEqual(['development']);
    expect(captured.activities).toHaveLength(2);
  });

  it('projects dev-log candidates without TaskSummary grouping', () => {
    const context = runContext('dev-log');
    const captured = sourceBatch([
      activity('development', '实现 src/api.ts 登录接口'),
      activity('learning', '解释 TypeScript 类型系统'),
    ], [
      evidence('request', 'development', 'request', '实现 src/api.ts 登录接口'),
      evidence('change', 'development', 'change', '修改 src/api.ts', ['src/api.ts']),
      evidence('learning-request', 'learning', 'request', '解释 TypeScript 类型系统'),
    ]);

    const result = projectWorkday(captured, context, preciseConfig());

    expect(result).not.toHaveProperty('tasks');
    expect(result.devLogCandidates).toHaveLength(1);
    expect(result.activities.map((item) => item.id)).toEqual(['development']);
    expect(result.workEvidence?.every((item) => result.devLogCandidates?.[0]?.evidenceIds.includes(item.id)))
      .toBe(true);
  });

  it('fails closed when precise capture has no snapshot', () => {
    const context = runContext('daily-report');
    const captured: ActivitySourceBatch = {
      date: context.date,
      timezone: context.timezone,
      sourceCount: 1,
      activities: [activity('development', '实现 src/api.ts 登录接口')],
    };

    expect(() => projectWorkday(captured, context, preciseConfig()))
      .toThrow('requires a CaptureSnapshot');
  });

  it('keeps CodexSource independent from task and report projections', async () => {
    const source = await readFile(new URL('../src/sessions/codex/source.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\.\/\.\.\/(?:tasks|reports|work-items)\//);
  });
});

function runContext(template: 'daily-report' | 'dev-log'): RunContext {
  const starter = createStarterConfig();
  const daily = starter.jobs['daily-report'];
  if (!daily) throw new Error('Missing starter job');
  return {
    jobName: template,
    job: { ...daily, template },
    date: '2026-07-16',
    timezone: 'Asia/Shanghai',
    dryRun: true,
    force: false,
  };
}

function preciseConfig(): SourceConfig {
  return { type: 'codex', captureMode: 'precise' };
}

function sourceBatch(activities: Activity[], evidenceItems: WorkEvidence[]): ActivitySourceBatch {
  const context = runContext('daily-report');
  return {
    date: context.date,
    timezone: context.timezone,
    sourceCount: activities.length,
    activities,
    captureSummary: {
      mode: 'precise', coverage: 'high', rawEventCount: evidenceItems.length,
      relevantEventCount: evidenceItems.length, capturedEventCount: evidenceItems.length,
      duplicateCount: 0, replayDroppedCount: 0, rollbackCount: 0, abortedTurnCount: 0,
      compactionCount: 0, truncatedCount: 0, unhandledEventTypes: [], reasons: [],
    },
    captureSnapshot: snapshot(evidenceItems),
  };
}

function snapshot(evidenceItems: WorkEvidence[]): CaptureSnapshot {
  return {
    id: 'snapshot', date: '2026-07-16', timezone: 'Asia/Shanghai',
    asOf: '2026-07-16T23:30:00+08:00', finalized: true,
    finalizationBasis: 'configured-cutoff', lateEventCount: 0, events: [], evidence: evidenceItems,
    quality: {
      discoveredFiles: 1, scannedBytes: 1, validLines: 1, invalidLines: 0,
      targetOccurrences: 0, included: 0, duplicate: 0, replay: 0, unsupported: 0,
      invalid: 0, rolledBack: 0, aborted: 0, orphanToolOutputs: 0, unresolvedParents: [],
      unknownRelevantEventTypes: [], accountingDifference: 0, coverage: 'high', reasons: [],
    },
  };
}

function activity(id: string, goal: string): Activity {
  return {
    file: `/tmp/${id}.jsonl`, id, rootSessionId: id, title: goal, cwd: '/workspace/app',
    gitBranch: `feat/${id}`, gitSha: '', startedAt: '2026-07-16T01:00:00Z',
    endedAt: '2026-07-16T01:10:00Z', originalStartedAt: '', originalEndedAt: '',
    activeMinutes: 10, durationMinutes: 10, observedSpanMinutes: 10, durationReliable: true,
    hadReplayBurst: false, durationReason: '可靠', targetDateActivityCount: 2,
    firstUserMessage: goal, userMessages: [goal], assistantMessages: ['已完成'],
    changedFiles: id === 'development' ? ['src/api.ts'] : [], commands: [], commandCount: 0, errors: [],
  };
}

function evidence(
  id: string,
  root: string,
  kind: WorkEvidence['kind'],
  summary: string,
  files: string[] = [],
): WorkEvidence {
  return {
    id, workItemKey: `/workspace/app|feat/${root}|${root}`, kind, status: 'confirmed',
    timestamp: '2026-07-16T01:01:00Z', workspace: '/workspace/app', branch: `feat/${root}`,
    files, summary, sourceEventIds: [`event-${id}`], confidence: 'confirmed',
  };
}
