import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ActivityBatch,
  CaptureQuality,
  CaptureSnapshot,
  WorkEvidence,
  WorkFactIndex,
  WorkItem,
} from '../src/core/contracts/index.js';
import { ArtifactStore } from '../src/core/persistence/index.js';
import {
  buildPeriodBatch,
  linkScore,
  PERIOD_LINK_THRESHOLD,
  projectPeriod,
} from '../src/reports/period/build.js';
import {
  compactPeriodView,
  renderPeriodReport,
  validatePeriodDraft,
  verificationSummary,
} from '../src/reports/period/report.js';

describe('period report pipeline', () => {
  it('rebuilds missing days sequentially and only accepts finalized artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-period-'));
    const artifacts = new ArtifactStore({ rootDirectory: root });
    let active = 0;
    let maxActive = 0;
    const collected: string[] = [];
    const collectDay = async (date: string): Promise<ActivityBatch> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      collected.push(date);
      const batch = dayBatch(date, true, [item(`item-${date}`, `subject-${date}`, '目标', 'session')]);
      await artifacts.saveWorkLayer(date, batch);
      active -= 1;
      return batch;
    };

    const batch = await buildPeriodBatch({
      unit: 'week', endDate: '2026-07-15', timezone: 'Asia/Shanghai', skipDates: [], artifacts, collectDay,
    });

    expect(collected).toEqual(['2026-07-13', '2026-07-14', '2026-07-15']);
    expect(maxActive).toBe(1);
    expect(batch.periodView?.snapshotIds).toHaveLength(3);
    expect(batch.periodView?.quality.coverage).toBe('high');
  });

  it('skips clean empty days and soft-includes partial days without failing the period', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-period-empty-'));
    const artifacts = new ArtifactStore({ rootDirectory: root });
    await artifacts.saveWorkLayer('2026-07-13', dayBatch('2026-07-13', true, [
      item('a1', 'subject-a1', '完成事实索引', 'session-a', ['src/facts.ts']),
    ]));
    await artifacts.saveWorkLayer('2026-07-14', dayBatch('2026-07-14', true, [], {
      coverage: 'high',
      reasons: [],
    }));
    await artifacts.saveWorkLayer('2026-07-15', dayBatch('2026-07-15', true, [
      item('b1', 'subject-b1', '部分覆盖的工作', 'session-b', ['src/partial.ts']),
    ], {
      coverage: 'partial',
      reasons: ['存在无法关联调用的工具输出'],
      orphanToolOutputs: 1,
    }));

    const batch = await buildPeriodBatch({
      unit: 'week',
      endDate: '2026-07-15',
      timezone: 'Asia/Shanghai',
      skipDates: [],
      artifacts,
      collectDay: async () => {
        throw new Error('should not recollect existing days');
      },
    });

    expect(batch.periodView?.groups).toHaveLength(2);
    expect(batch.periodView?.quality.coverage).toBe('partial');
    expect(batch.periodView?.quality.reasons.join('\n')).toContain('2026-07-14：无工作项，已跳过');
    expect(batch.periodView?.quality.reasons.join('\n')).toContain('2026-07-15');
  });

  it('hard-fails dirty ledgers and not-finalized days with structured reasons', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-period-dirty-'));
    const artifacts = new ArtifactStore({ rootDirectory: root });
    await artifacts.saveWorkLayer('2026-07-13', dayBatch('2026-07-13', true, [
      item('a1', 'subject-a1', '脏账本', 'session-a'),
    ], {
      coverage: 'low',
      reasons: ['事件记账差额为 2'],
      accountingDifference: 2,
    }));

    await expect(buildPeriodBatch({
      unit: 'week',
      endDate: '2026-07-13',
      timezone: 'Asia/Shanghai',
      skipDates: [],
      artifacts,
      collectDay: async () => dayBatch('2026-07-13', true, [], {
        coverage: 'low',
        reasons: ['事件记账差额为 2'],
        accountingDifference: 2,
      }),
    })).rejects.toThrow(/Period day 2026-07-13 rejected \(dirty_ledger\)/);

    await expect(buildPeriodBatch({
      unit: 'week',
      endDate: '2026-07-14',
      timezone: 'Asia/Shanghai',
      skipDates: ['2026-07-13'],
      artifacts,
      collectDay: async () => dayBatch('2026-07-14', false, [
        item('open', 'subject-open', '未 finalized', 'session-open'),
      ]),
    })).rejects.toThrow(/Period day 2026-07-14 rejected \(not_finalized\)/);
  });

  it('does not persist v1 migration when persist=false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-period-persist-'));
    const artifacts = new ArtifactStore({ rootDirectory: root });
    const date = '2026-07-15';
    const snapshotId = `snapshot-${date}`;
    const { writeFile, mkdir, readFile } = await import('node:fs/promises');
    await mkdir(root, { recursive: true });
    await writeFile(artifacts.captureAuditPath(date), `${JSON.stringify({
      id: snapshotId,
      date,
      timezone: 'Asia/Shanghai',
      asOf: `${date}T23:30:00+08:00`,
      finalized: true,
      lateEventCount: 0,
      quality: quality(),
      events: [],
      evidence: [],
    })}\n`);
    // 手写 v1 索引，验证 dry-run/persist=false 不会写回 v2。
    await writeFile(artifacts.workFactsPath(date), JSON.stringify({
      version: 1,
      date,
      timezone: 'Asia/Shanghai',
      snapshotId,
      facts: [],
    }));
    await writeFile(artifacts.workItemsPath(date), JSON.stringify({
      snapshotId,
      workItems: [],
    }));
    await writeFile(artifacts.dailyViewPath(date), JSON.stringify({
      snapshotId,
      dailyView: { items: [], visualPlan: [], quality: { coverage: 'high', reasons: [] } },
    }));

    const batch = await buildPeriodBatch({
      unit: 'week',
      endDate: date,
      timezone: 'Asia/Shanghai',
      skipDates: ['2026-07-13', '2026-07-14'],
      artifacts,
      collectDay: async () => {
        throw new Error('should use stored v1 day');
      },
      persist: false,
    });
    expect(batch.periodView?.groups).toEqual([]);

    const facts = JSON.parse(await readFile(artifacts.workFactsPath(date), 'utf8')) as { version: number };
    expect(facts.version).toBe(1);
    await expect(access(artifacts.periodViewPath('week', date))).rejects.toThrow();
  });

  it('links only strong cross-day continuations and never merges two items from one day', () => {
    // 目标含稳定主题词「缓存投影」，避免动作词被 stableTopic 洗掉后失去重叠。
    const firstA = item('a1', 'subject-a1', '落地缓存投影', 'session-a', ['src/cache.ts']);
    const firstB = item('b1', 'subject-b1', '整理独立文档', 'shared-session');
    const secondA = item('a2', 'subject-a2', '回归缓存投影', 'session-b', ['src/cache.ts']);
    const secondB = item('b2', 'subject-b2', '修复完全不同的登录问题', 'shared-session');
    const days = [
      periodDay('2026-07-13', [firstA, firstB], { a1: 'feat/cache', b1: 'main' }),
      periodDay('2026-07-14', [secondA, secondB], { a2: 'feat/cache', b2: 'main' }),
    ];

    const view = projectPeriod('week', ['2026-07-13', '2026-07-14'], days);
    const cacheGroup = view.groups.find((group) => group.entries.some((entry) => entry.workItemId === 'a1'));
    const unrelated = view.groups.find((group) => group.entries.some((entry) => entry.workItemId === 'b1'));
    expect(cacheGroup?.entries.map((entry) => entry.workItemId)).toEqual(['a1', 'a2']);
    expect(unrelated?.entries.map((entry) => entry.workItemId)).toEqual(['b1']);
    expect(view.groups.flatMap((group) => group.entries)).toHaveLength(4);
    expect(view.groups.every((group) => new Set(group.dates).size === group.dates.length)).toBe(true);
  });

  it('does not merge same-file same-branch work with unrelated topics', () => {
    const left = entry({
      date: '2026-07-13',
      workItemId: 'cfg-1',
      subjectKey: 'subject-cfg',
      title: '调整配置',
      goal: '调整配置',
      branch: 'feat/x',
      changedFiles: ['src/config.ts'],
      sessionIds: ['s1'],
    });
    const right = entry({
      date: '2026-07-14',
      workItemId: 'cfg-2',
      subjectKey: 'subject-settings',
      title: '修改设置',
      goal: '修改设置',
      branch: 'feat/x',
      changedFiles: ['src/config.ts'],
      sessionIds: ['s2'],
    });
    // 同文件+强分支但无主题重叠：双信号门禁应挡下误合并。
    expect(linkScore(left, right)).toBeLessThan(PERIOD_LINK_THRESHOLD);

    const sessionOnly = entry({
      ...right,
      title: '修复登录问题',
      goal: '修复登录问题',
      branch: 'main',
      changedFiles: [],
      sessionIds: ['shared'],
    });
    const leftSession = entry({
      ...left,
      title: '整理独立文档',
      goal: '整理独立文档',
      branch: 'main',
      changedFiles: [],
      sessionIds: ['shared'],
    });
    expect(linkScore(leftSession, sessionOnly)).toBeLessThan(PERIOD_LINK_THRESHOLD);
  });

  it('rejects omitted groups and renders verification counts without file dumps', () => {
    const work = item('a1', 'subject-a1', '完成事实索引', 'session-a', ['src/facts.ts']);
    work.verifications = [{
      command: 'npm test',
      normalizedCommand: 'npm test',
      outcome: 'passed',
      exitCode: 0,
      timestamp: '2026-07-13T10:00:00.000Z',
      evidenceIds: ['e-a1'],
    }];
    const view = projectPeriod('week', ['2026-07-13'], [periodDay(
      '2026-07-13',
      [work],
      { a1: 'feat/facts' },
    )]);
    expect(() => validatePeriodDraft(view, {
      title: '周报', overview: '概览', groups: [], risks: [], nextActions: [],
    })).toThrow('omitted');

    const markdown = renderPeriodReport({ periodView: view } as ActivityBatch, {
      title: '周报', overview: '概览',
      groups: [{ groupId: view.groups[0]!.id, title: '事实索引', summary: '完成事实索引', highlights: ['索引可追溯'] }],
      risks: [], nextActions: [],
    });
    expect(markdown).toContain('2026-07-13：已完成事实索引');
    expect(markdown).toContain('涉及模块**：facts');
    expect(markdown).not.toContain('src/facts.ts');
    expect(markdown).toContain('1 条引用事实');
    expect(markdown).toContain('通过 1');
    expect(verificationSummary(work.verifications)).toBe('共 1 项（通过 1）');

    const compact = compactPeriodView(view);
    expect(JSON.stringify(compact)).not.toContain('session-a');
    expect(JSON.stringify(compact)).not.toContain('src/facts.ts');
    expect(compact.groups[0]?.days[0]?.goal).toBe('完成事实索引');
  });
});

function periodDay(date: string, items: WorkItem[], branches: Record<string, string>) {
  const facts = items.map((workItem): WorkEvidence => ({
    id: `e-${workItem.id}`,
    workItemKey: workItem.subjectKey,
    kind: 'change',
    status: 'confirmed',
    timestamp: `${date}T10:00:00.000Z`,
    repository: '/repo',
    workspace: '/repo',
    branch: branches[workItem.id],
    files: workItem.changes.flatMap((change) => change.files),
    summary: workItem.goal,
    sourceEventIds: [`source-${workItem.id}`],
    confidence: 'confirmed',
  }));
  const index: WorkFactIndex = {
    version: 2, date, timezone: 'Asia/Shanghai', snapshotId: `snapshot-${date}`,
    asOf: `${date}T23:30:00+08:00`, finalized: true, quality: quality(), facts,
  };
  return { date, facts: index, items, quality: { coverage: 'high' as const, reasons: [] } };
}

function item(id: string, subjectKey: string, goal: string, sessionId: string, files: string[] = []): WorkItem {
  return {
    id, subjectKey, repositoryKey: '/repo', kind: 'feature', status: 'completed', title: goal, goal,
    actions: [`处理${goal}`], outcomes: [`已${goal}`], decisions: [],
    changes: files.length ? [{ files, summary: goal, excerpts: [], evidenceIds: [`e-${id}`] }] : [],
    verifications: [], blockers: [], startedAt: '2026-07-13T09:00:00.000Z', endedAt: '2026-07-13T10:00:00.000Z',
    activeMinutes: 60, durationReliable: true, sessionIds: [sessionId], evidenceIds: [`e-${id}`], confidence: 'confirmed',
  };
}

function entry(partial: Partial<ReturnType<typeof baseEntry>> & Pick<ReturnType<typeof baseEntry>, 'date' | 'workItemId' | 'subjectKey' | 'title' | 'goal'>) {
  return { ...baseEntry(), ...partial };
}

function baseEntry() {
  return {
    date: '2026-07-13',
    workItemId: 'a',
    subjectKey: 's1',
    title: '工作',
    goal: '工作',
    kind: 'feature' as const,
    status: 'completed' as const,
    repositoryKey: '/repo',
    actions: [] as string[],
    outcomes: [] as string[],
    decisions: [] as string[],
    changedFiles: [] as string[],
    verifications: [] as WorkItem['verifications'],
    blockers: [] as string[],
    activeMinutes: 10,
    durationReliable: true,
    sessionIds: [] as string[],
    evidenceIds: [] as string[],
    factCount: 0,
  };
}

function dayBatch(
  date: string,
  finalized: boolean,
  items: WorkItem[],
  qualityOverride: Partial<CaptureQuality> & { coverage?: CaptureQuality['coverage']; reasons?: string[] } = {},
): ActivityBatch {
  const snapshot: CaptureSnapshot = {
    id: `snapshot-${date}`, date, timezone: 'Asia/Shanghai', asOf: `${date}T23:30:00+08:00`, finalized,
    lateEventCount: 0,
    quality: quality(qualityOverride),
    events: [],
    evidence: items.length
      ? periodDay(date, items, {}).facts.facts
      : [],
  };
  return {
    date, timezone: 'Asia/Shanghai', sourceCount: items.length, activities: [], filteredCount: 0,
    captureSnapshot: snapshot, workItems: items,
    dailyView: {
      items, longestWorkItemId: null, longestReason: '', longestTiedIds: [], excludedUnreliableCount: 0,
      deepDiveCandidateIds: [], takeawayCandidateIds: [],
      presentationPlan: [],
      quality: {
        coverage: qualityOverride.coverage || snapshot.quality.coverage,
        reasons: qualityOverride.reasons || snapshot.quality.reasons,
      },
    },
  };
}

function quality(override: Partial<CaptureQuality> = {}): CaptureQuality {
  return {
    discoveredFiles: 1, scannedBytes: 1, validLines: 1, invalidLines: 0, targetOccurrences: 1,
    included: 1, duplicate: 0, replay: 0, unsupported: 0, invalid: 0, rolledBack: 0, aborted: 0,
    orphanToolOutputs: 0, unresolvedParents: [], unknownRelevantEventTypes: [], accountingDifference: 0,
    coverage: 'high', reasons: [],
    ...override,
  };
}
