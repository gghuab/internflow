import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionAssessment, WorkItem, WorkItemKind } from '../src/core/contracts/index.js';
import { validateDecisionAssessment } from '../src/core/decision-audit.js';
import { projectDailyWorkItems } from '../src/reports/daily/view.js';
import { projectDevLogCandidates } from '../src/reports/dev-log/candidates.js';

interface FixtureItem {
  id: string;
  kind?: WorkItemKind;
  title?: string;
  goal: string;
  actions?: string[];
  decisions?: string[];
  files: string[];
  expectedMode?: string;
}

describe('decision policy replay', () => {
  it('keeps known admission and visual decisions stable', async () => {
    const fixture = JSON.parse(await readFile(join(
      process.cwd(), 'test', 'fixtures', 'decision-policies.json',
    ), 'utf8')) as {
      devLogAdmission: Array<{ item: FixtureItem; expectedSection: 'requirement' | null }>;
      visual: FixtureItem[];
      expectedFullDiagramCount: number;
    };
    const assessments: DecisionAssessment[] = [];

    for (const entry of fixture.devLogAdmission) {
      const candidates = projectDevLogCandidates([workItem(entry.item)], { type: 'codex' }, assessments);
      expect(candidates[0]?.section || null).toBe(entry.expectedSection);
    }

    const visualItems = fixture.visual.map(workItem);
    const view = projectDailyWorkItems(visualItems, { type: 'codex' }, undefined, assessments);
    for (const entry of fixture.visual) {
      const mode = view.visualPlan.find((plan) => plan.workItemId === entry.id)?.mode || 'none';
      expect(mode).toBe(entry.expectedMode);
    }
    expect(view.visualPlan.filter((plan) => plan.mode !== 'inline')).toHaveLength(
      fixture.expectedFullDiagramCount,
    );
    expect(assessments.filter((item) => item.policyId === 'daily.visual-need')).toHaveLength(view.items.length);
    expect(assessments.every((item) => {
      validateDecisionAssessment(item);
      return item.policyVersion.length > 0 && item.reasons.length > 0;
    })).toBe(true);
  });
});

function workItem(input: FixtureItem): WorkItem {
  return {
    id: input.id,
    subjectKey: input.id,
    repositoryKey: '/workspace',
    kind: input.kind || 'feature',
    status: 'completed',
    title: input.title || input.goal,
    goal: input.goal,
    actions: input.actions || ['完成代码改动'],
    outcomes: ['完成目标'],
    decisions: input.decisions || [],
    changes: input.files.length ? [{
      files: input.files, summary: input.goal, excerpts: [], evidenceIds: [`e-${input.id}`],
    }] : [],
    verifications: [], blockers: [],
    startedAt: '2026-07-16T01:00:00Z', endedAt: '2026-07-16T01:10:00Z',
    activeMinutes: 10, durationReliable: true, sessionIds: [`s-${input.id}`],
    evidenceIds: [`e-${input.id}`], confidence: 'confirmed',
  };
}
