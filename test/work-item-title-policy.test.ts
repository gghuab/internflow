import { describe, expect, it } from 'vitest';
import type { Activity, WorkEvidence } from '../src/core/contracts/index.js';
import { isMetaMaintenanceText } from '../src/core/source-filter.js';
import { projectDailyWorkItems } from '../src/reports/daily/view.js';
import { projectDevLogCandidates } from '../src/reports/dev-log/candidates.js';
import { workGoal } from '../src/work-items/assembly/text.js';
import { isWorkRelated } from '../src/work-items/policies/classification.js';
import { inferWorkItemTitle } from '../src/work-items/policies/title.js';
import type { WorkItem } from '../src/work-items/types.js';

describe('title and meta policy without project overfit', () => {
  it('prefers a business goal over generic chatter when scoring requests', () => {
    const goal = workGoal(
      [
        request('看不了'),
        request('第三个我修复了'),
        request('发布器也拉不起来，帮忙看下启动失败'),
      ],
      [activity('发布器也拉不起来，帮忙看下启动失败')],
    );
    expect(goal).toContain('发布器');
    expect(goal).not.toBe('看不了');
    expect(goal).not.toBe('第三个我修复了');
  });

  it('keeps business phrases that used to match personal demote sentences', () => {
    const title = inferWorkItemTitle(
      '发布器也拉不起来',
      ['修复了发布器启动失败'],
      ['src/publisher/start.ts'],
      'bugfix',
    );
    expect(title).toMatch(/发布器/);
    expect(title).not.toBe('问题修复');
  });

  it('titles a margin-removal goal without a hardcoded 两边留白 rewrite', () => {
    expect(inferWorkItemTitle('卡片现在两边留白去掉', [], [], 'bugfix')).toBe('卡片现在两边留白修复');
  });

  it('does not treat pet/product domain words as built-in meta noise', () => {
    expect(isMetaMaintenanceText('换一个宠物外观')).toBe(false);
    expect(isMetaMaintenanceText('实现宠物外观换肤')).toBe(false);
    expect(isMetaMaintenanceText('日报格式维护')).toBe(true);
    expect(isMetaMaintenanceText('修改 daily-report 生成脚本')).toBe(true);

    const petEvidence: WorkEvidence[] = [{
      id: 'e1',
      workItemKey: 'repo|main|pet',
      kind: 'change',
      status: 'confirmed',
      timestamp: '2026-07-16T01:00:00Z',
      workspace: '/workspace/app',
      branch: 'main',
      files: ['src/pet/skin.ts'],
      summary: '实现宠物外观换肤',
      sourceEventIds: ['event-1'],
      confidence: 'confirmed',
    }];
    expect(isWorkRelated('实现宠物外观换肤', petEvidence)).toBe(true);

    const petItem = item({
      id: 'pet',
      kind: 'feature',
      title: '宠物外观换肤',
      goal: '实现宠物外观换肤',
      changes: [{
        files: ['src/pet/skin.ts'],
        summary: '实现宠物外观换肤',
        excerpts: [],
        evidenceIds: ['e1'],
      }],
      evidenceIds: ['e1'],
    });
    expect(projectDailyWorkItems([petItem], { type: 'codex' }).items.map((value) => value.id))
      .toEqual(['pet']);
    expect(projectDevLogCandidates([petItem]).map((value) => value.id)).toHaveLength(1);
  });

  it('still excludes report self-maintenance from daily and dev-log projections', () => {
    const meta = item({ id: 'meta', kind: 'docs', title: '日报格式维护', goal: '调整日报格式' });
    expect(projectDailyWorkItems([meta], { type: 'codex' }).items).toEqual([]);
    expect(projectDevLogCandidates([
      item({
        id: 'meta-file',
        kind: 'bugfix',
        title: '日报脚本修复',
        changes: [{
          files: ['src/reports/daily/prompt.ts'],
          summary: '修复日报脚本',
          excerpts: [],
          evidenceIds: ['e1'],
        }],
        evidenceIds: ['e1'],
      }),
    ])).toEqual([]);
  });
});

function request(summary: string): WorkEvidence {
  return {
    id: summary,
    workItemKey: 'repo|main|topic',
    kind: 'request',
    status: 'confirmed',
    timestamp: '2026-07-16T01:00:00Z',
    workspace: '/workspace/app',
    branch: 'main',
    files: [],
    summary,
    sourceEventIds: [`event-${summary}`],
    confidence: 'confirmed',
  };
}

function activity(goal: string): Activity {
  return {
    file: '/tmp/session.jsonl',
    id: 'session',
    rootSessionId: 'session',
    title: goal,
    cwd: '/workspace/app',
    gitBranch: 'main',
    gitSha: '',
    startedAt: '2026-07-16T01:00:00Z',
    endedAt: '2026-07-16T01:10:00Z',
    originalStartedAt: '',
    originalEndedAt: '',
    activeMinutes: 10,
    durationMinutes: 10,
    observedSpanMinutes: 10,
    durationReliable: true,
    durationReason: '可靠',
    hadReplayBurst: false,
    targetDateActivityCount: 1,
    firstUserMessage: goal,
    userMessages: [goal],
    assistantMessages: [],
    changedFiles: [],
    commands: [],
    commandCount: 0,
    errors: [],
  };
}

function item(partial: Partial<WorkItem> & Pick<WorkItem, 'id'>): WorkItem {
  return {
    subjectKey: partial.id,
    repositoryKey: '/workspace/app',
    kind: 'feature',
    status: 'completed',
    title: '功能实现',
    goal: '实现功能',
    actions: [],
    outcomes: [],
    decisions: [],
    changes: [],
    verifications: [],
    blockers: [],
    startedAt: '2026-07-16T01:00:00Z',
    endedAt: '2026-07-16T01:10:00Z',
    activeMinutes: 10,
    durationReliable: true,
    sessionIds: [partial.id],
    evidenceIds: [],
    confidence: 'confirmed',
    ...partial,
  };
}
