import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Activity, WorkEvidence } from '../src/core/contracts/index.js';
import { assembleWorkItems } from '../src/work-items/index.js';
import type { WorkItemKind, WorkItemStatus } from '../src/work-items/types.js';

interface GoldenEvidence {
  kind: WorkEvidence['kind'];
  summary: string;
  files?: string[];
  verification?: WorkEvidence['verification'];
}

interface GoldenCase {
  name: string;
  goal: string;
  activityTitle: string;
  assistantMessages: string[];
  evidence: GoldenEvidence[];
  expectedTitle: string;
  expectedKind: WorkItemKind;
  expectedStatus: WorkItemStatus;
}

interface GoldenDay {
  date: string;
  cases: GoldenCase[];
}

describe('three-day WorkItem semantic golden samples', () => {
  for (const date of ['2026-07-13', '2026-07-14', '2026-07-15']) {
    it(`${date} keeps deterministic titles and manually reviewed statuses`, async () => {
      const fixture = await loadFixture(date);
      for (const sample of fixture.cases) {
        const item = assembleGolden(fixture.date, sample);
        expect(item, sample.name).toMatchObject({
          title: sample.expectedTitle,
          kind: sample.expectedKind,
          status: sample.expectedStatus,
        });
        expect(item?.title, sample.name).not.toMatch(/^(?:已完成|直接开始|你帮我|你来帮我|技术分析$)/);
        expect(item?.title, sample.name).not.toMatch(/[?？]$/);
      }
    });
  }
});

async function loadFixture(date: string): Promise<GoldenDay> {
  return JSON.parse(await readFile(
    new URL(`./fixtures/work-items/${date}.json`, import.meta.url),
    'utf8',
  )) as GoldenDay;
}

function assembleGolden(date: string, sample: GoldenCase) {
  const root = sample.name;
  const changedFiles = sample.evidence
    .filter((item) => item.kind === 'change')
    .flatMap((item) => item.files || []);
  const activity: Activity = {
    file: `/tmp/${root}.jsonl`, id: root, rootSessionId: root, title: sample.activityTitle,
    cwd: '/workspace/app', gitBranch: 'main', gitSha: '',
    startedAt: `${date}T01:00:00Z`, endedAt: `${date}T01:10:00Z`,
    originalStartedAt: '', originalEndedAt: '', activeMinutes: 10, durationMinutes: 10,
    observedSpanMinutes: 10, durationReliable: true, durationReason: '可靠', hadReplayBurst: false,
    targetDateActivityCount: 1, firstUserMessage: sample.goal, userMessages: [sample.goal],
    assistantMessages: sample.assistantMessages, changedFiles, commands: [], commandCount: 0, errors: [],
  };
  const evidence = sample.evidence.map((item, index): WorkEvidence => ({
    id: `${root}-${index}`, workItemKey: `/workspace/app|main|${root}`, kind: item.kind,
    status: 'confirmed', timestamp: `${date}T01:${String(index).padStart(2, '0')}:00Z`,
    workspace: '/workspace/app', branch: 'main', files: item.files || [], summary: item.summary,
    sourceEventIds: [`event-${root}-${index}`], confidence: 'confirmed',
    ...(item.verification ? { verification: item.verification } : {}),
  }));
  return assembleWorkItems({ activities: [activity], evidence })[0];
}
