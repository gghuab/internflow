import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { internFlowConfigSchema } from '../src/core/config.js';
import type { RunContext, WorkspaceCandidate } from '../src/core/contracts/index.js';
import { WorkspaceSink } from '../src/plugins/sinks/workspace.js';
import { WorkspaceStore } from '../src/workspaces/index.js';

describe('Engineering Memory workspace', () => {
  it('links cross-day work, persists atomically, and ignores repeated facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-workspace-'));
    const store = new WorkspaceStore('engineering-memory', directory);
    const first = candidate({
      date: '2026-07-24',
      workItemId: 'work-1',
      subjectKey: 'subject-day-1',
      title: '排行榜 Lynx 化',
      goal: '实现群打卡排行榜 Lynx 化',
      changedFiles: ['src/rank.ts'],
      fingerprint: 'fingerprint-1',
    });
    const second = candidate({
      date: '2026-07-25',
      workItemId: 'work-2',
      subjectKey: 'subject-day-2',
      title: '排行榜目录重构',
      goal: '继续推进群打卡排行榜 Lynx 化',
      changedFiles: ['src/rank.ts', 'src/rank-view.ts'],
      fingerprint: 'fingerprint-2',
    });

    const firstResult = await store.apply([first], { now: '2026-07-24T15:50:00.000Z' });
    const secondResult = await store.apply([second], { now: '2026-07-25T15:50:00.000Z' });
    const repeated = await store.apply([second], { now: '2026-07-25T16:00:00.000Z' });
    const state = JSON.parse(await readFile(store.path, 'utf8'));

    expect(firstResult).toMatchObject({ entriesAdded: 1, subjectsCreated: 1 });
    expect(secondResult).toMatchObject({ entriesAdded: 1, subjectsCreated: 0, subjectsUpdated: 1 });
    expect(repeated).toMatchObject({ entriesAdded: 0, subjectsCreated: 0, subjectsUpdated: 0 });
    expect(state).toMatchObject({ version: 1, workspaceId: 'engineering-memory', revision: 2 });
    expect(state.subjects).toHaveLength(1);
    expect(state.subjects[0].subjectKeys).toEqual(['subject-day-1', 'subject-day-2']);
    expect(state.entries).toHaveLength(2);
    expect(state.entries[1].match).toMatchObject({ method: 'cross-day' });
  });

  it('does not merge unrelated work that only shares a repository and branch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-workspace-'));
    const store = new WorkspaceStore('engineering-memory', directory);

    await store.apply([
      candidate({
        date: '2026-07-24',
        workItemId: 'work-1',
        subjectKey: 'subject-1',
        title: '排行榜 Lynx 化',
        goal: '实现排行榜视图',
        changedFiles: ['src/rank.ts'],
        fingerprint: 'fingerprint-1',
      }),
      candidate({
        date: '2026-07-25',
        workItemId: 'work-2',
        subjectKey: 'subject-2',
        title: '支付配置检查',
        goal: '检查支付回调配置',
        changedFiles: ['src/payment.ts'],
        fingerprint: 'fingerprint-2',
      }),
    ]);

    expect((await store.read()).subjects).toHaveLength(2);
  });

  it('does not use cross-day scoring to merge distinct work from the same day', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-workspace-'));
    const store = new WorkspaceStore('engineering-memory', directory);

    await store.apply([
      candidate({
        date: '2026-07-24',
        workItemId: 'work-1',
        subjectKey: 'subject-1',
        title: '排行榜页面实现',
        goal: '实现排行榜页面',
        changedFiles: ['src/rank.ts'],
        fingerprint: 'fingerprint-1',
      }),
      candidate({
        date: '2026-07-24',
        workItemId: 'work-2',
        subjectKey: 'subject-2',
        title: '排行榜埋点实现',
        goal: '实现排行榜埋点',
        changedFiles: ['src/rank.ts'],
        fingerprint: 'fingerprint-2',
      }),
    ]);

    expect((await store.read()).subjects).toHaveLength(2);
  });

  it('accepts a weekday local workspace job without a Codex generator', () => {
    const result = internFlowConfigSchema.safeParse({
      version: 1,
      timezone: 'Asia/Shanghai',
      jobs: {
        'engineering-memory': {
          enabled: true,
          template: 'workspace',
          schedule: {
            time: '23:50',
            days: ['mon', 'tue', 'wed', 'thu', 'fri'],
          },
          source: { type: 'codex', dayEndTime: '23:30' },
          generator: { type: 'local' },
          sinks: [{
            type: 'workspace',
            id: 'engineering-memory',
            directory: '~/.local/share/internflow/workspaces/engineering-memory',
          }],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('materializes an index and keeps unrelated subjects in separate Markdown files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-workspace-'));
    const sink = new WorkspaceSink();
    const result = await sink.apply(
      { dryRun: false } as RunContext,
      { type: 'workspace', id: 'engineering-memory', directory },
      {
        kind: 'workspace',
        candidates: [
          candidate({
            date: '2026-07-24',
            workItemId: 'rank',
            subjectKey: 'rank',
            title: '排行榜 Lynx 化',
            goal: '实现排行榜视图',
            changedFiles: ['src/rank.ts'],
            fingerprint: 'rank-fingerprint',
          }),
          candidate({
            date: '2026-07-24',
            workItemId: 'payment',
            subjectKey: 'payment',
            title: '支付配置检查',
            goal: '检查支付回调配置',
            changedFiles: ['src/payment.ts'],
            fingerprint: 'payment-fingerprint',
          }),
        ],
      },
    );
    const state = await new WorkspaceStore('engineering-memory', directory).read();
    const rank = state.subjects.find((subject) => subject.title === '排行榜 Lynx 化');
    const payment = state.subjects.find((subject) => subject.title === '支付配置检查');
    const index = await readFile(join(directory, 'views/index.md'), 'utf8');
    const rankView = await readFile(join(directory, `views/subjects/${rank?.id}.md`), 'utf8');

    expect(result).toMatchObject({ subjectViewCount: 2 });
    expect(index).toContain(`subjects/${rank?.id}.md`);
    expect(index).toContain(`subjects/${payment?.id}.md`);
    expect(index).toContain(`| [排行榜 Lynx 化](subjects/${rank?.id}.md) | in progress |`);
    expect(rankView).toContain('# 排行榜 Lynx 化');
    expect(rankView).toContain('src/rank.ts');
    expect(rankView).not.toContain('支付配置检查');
  });
});

function candidate(input: {
  date: string;
  workItemId: string;
  subjectKey: string;
  title: string;
  goal: string;
  changedFiles: string[];
  fingerprint: string;
}): WorkspaceCandidate {
  return {
    date: input.date,
    workItemId: input.workItemId,
    subjectKey: input.subjectKey,
    title: input.title,
    goal: input.goal,
    kind: 'feature',
    status: 'in_progress',
    repositoryKey: '/repo/internflow',
    branch: 'feat/rank',
    actions: [`推进 ${input.title}`],
    outcomes: [],
    decisions: [],
    changedFiles: input.changedFiles,
    verifications: [],
    blockers: [],
    activeMinutes: 30,
    durationReliable: true,
    sessionIds: [input.workItemId],
    evidenceIds: [`evidence-${input.workItemId}`],
    factCount: 1,
    snapshotId: `snapshot-${input.date}`,
    commits: [],
    contentFingerprint: input.fingerprint,
  };
}
