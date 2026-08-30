import { describe, expect, it } from 'vitest';
import { assembleWorkItems, subjectKeyFor } from '../src/work-items/index.js';
import type { Activity, WorkEvidence } from '../src/core/contracts/index.js';

describe('work item subject identity', () => {
  it('keeps the same subject across sessions for the same repository branch and topic', () => {
    const left = subjectKeyFor({
      repositoryKey: 'repo', branch: 'feat/api', files: ['src/api.ts'], goal: '新增用户接口字段',
    });
    const right = subjectKeyFor({
      repositoryKey: 'repo', branch: 'feat/api', files: ['src/api.ts'], goal: '继续完善用户接口字段',
    });
    expect(left).toBe(right);
  });

  it('does not collapse unrelated requests merely because they use the same feature branch', () => {
    const implementation = subjectKeyFor({
      repositoryKey: 'repo',
      branch: 'feat/launch-activity-refactor',
      files: ['src/launch-activity-v2/services/infra-service.ts'],
      goal: '总结三个 service 的职责',
    });
    const plan = subjectKeyFor({
      repositoryKey: 'repo',
      branch: 'feat/launch-activity-refactor',
      files: ['src/launch-activity/plan.md'],
      goal: '审查 plan.md 并修改',
    });
    expect(implementation).not.toBe(plan);
  });

  it('does not merge different file scopes on the default branch', () => {
    const payment = subjectKeyFor({
      repositoryKey: 'repo', branch: 'main', files: ['src/pay.ts'], goal: '修复支付',
    });
    const profile = subjectKeyFor({
      repositoryKey: 'repo', branch: 'main', files: ['src/profile.ts'], goal: '修复资料页',
    });
    expect(payment).not.toBe(profile);
  });

  it('keeps the same business subject across temporary worktree roots', () => {
    const left = subjectKeyFor({
      repositoryKey: 'repo', branch: 'feat/payment',
      files: ['/tmp/worktree-a/apps/client/src/features/payment/confirm.ts'], goal: '新增支付确认',
    });
    const right = subjectKeyFor({
      repositoryKey: 'repo', branch: 'feat/payment',
      files: ['/private/tmp/worktree-b/apps/client/src/features/payment/result.ts'], goal: '完善支付确认',
    });
    expect(left).toBe(right);
  });
});

describe('work item assembler', () => {
  it('merges one feature branch into one requirement and summarizes it with a stable title', () => {
    const branch = 'feat/launch-activity-refactor';
    const first = activity('a', '重构活动创建页并从主分支创建重构分支');
    const second = activity('b', '总结那三个 service 每个 service 承载的内容');
    first.gitBranch = branch;
    second.gitBranch = branch;
    first.title = '分支重构';
    second.title = '总结那三个 service 每个 service 承载的内容';

    const items = assembleWorkItems({
      activities: [first, second],
      evidence: [
        evidence({
          id: 'entry-change',
          root: 'a',
          kind: 'change',
          summary: '修改活动创建页 V2 入口',
          files: ['src/features/launch-activity/entry.tsx'],
          branch,
        }),
        evidence({
          id: 'plan-change',
          root: 'b',
          kind: 'change',
          summary: '更新活动创建页服务职责',
          files: ['src/features/launch-activity/plan.md'],
          branch,
        }),
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: '活动创建页重构',
      sessionIds: ['a', 'b'],
    });
    expect(items[0]?.title).not.toBe(first.title);
    expect(items[0]?.title).not.toBe(second.title);
  });

  it('merges cross-session work and closes a failed verification after a pass', () => {
    const items = assembleWorkItems({
      activities: [activity('a', '新增用户接口字段'), activity('b', '继续完善用户接口字段')],
      evidence: [
        evidence({ id: 'request-a', root: 'a', kind: 'request', summary: '新增用户接口字段' }),
        evidence({ id: 'change-a', root: 'a', kind: 'change', summary: '新增 src/api.ts 字段', files: ['src/api.ts'] }),
        evidence({ id: 'request-b', root: 'b', kind: 'request', summary: '继续完善用户接口字段' }),
        evidence({ id: 'change-b', root: 'b', kind: 'change', summary: '修改 src/api.ts', files: ['src/api.ts'] }),
        evidence({ id: 'test-fail', root: 'b', kind: 'error', summary: 'npm test 失败', verification: { command: 'npm test', exitCode: 1, outcome: 'failed' } }),
        evidence({ id: 'test-pass', root: 'b', kind: 'verification', summary: 'npm test 通过', timestamp: '2026-07-16T01:06:00Z', verification: { command: 'npm test', exitCode: 0, outcome: 'passed' } }),
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'feature', status: 'completed', blockers: [], sessionIds: ['a', 'b'],
    });
  });

  it('marks a final failed verification as blocked', () => {
    const [item] = assembleWorkItems({
      activities: [activity('a', '修复接口异常')],
      evidence: [
        evidence({ id: 'request', root: 'a', kind: 'request', summary: '修复接口异常' }),
        evidence({ id: 'change', root: 'a', kind: 'change', summary: '修改 src/api.ts', files: ['src/api.ts'] }),
        evidence({ id: 'test-fail', root: 'a', kind: 'error', summary: 'npm test 失败', verification: { command: 'npm test', exitCode: 1, outcome: 'failed' } }),
      ],
    });
    expect(item).toMatchObject({ kind: 'bugfix', status: 'blocked' });
    expect(item?.blockers[0]).toContain('npm test');
  });

  it('does not let a final branch cleanup request hide material product development', () => {
    const branch = 'feat-hexiao';
    const work = activity('a', '删除三个本地分支');
    work.gitBranch = branch;
    const [item] = assembleWorkItems({
      activities: [work],
      evidence: [
        evidence({
          id: 'change', root: 'a', kind: 'change',
          summary: '修改活动核销页面交互', files: ['apps/interest-h5/src/pages/write-off/index.tsx'], branch,
        }),
        evidence({
          id: 'delivery', root: 'a', kind: 'delivery',
          summary: '提交并推送 feat-hexiao', branch,
        }),
      ],
    });

    // 分支清理只是交付尾声，真实产品代码改动仍应进入需求开发记录。
    expect(item).toMatchObject({ kind: 'feature', branch });
  });

  it('splits a new feature and its later regression fix inside the same branch and session', () => {
    const branch = 'feat/write-off';
    const work = activity('a', '新增核销结果状态展示');
    work.gitBranch = branch;
    const items = assembleWorkItems({
      activities: [work],
      evidence: [
        evidence({ id: 'feature-request', root: 'a', turn: 'turn-1', kind: 'request', summary: '新增核销结果状态展示', branch }),
        evidence({
          id: 'feature-change', root: 'a', turn: 'turn-1', kind: 'change', summary: '实现核销结果状态展示', branch,
          files: ['src/domain/write-off/result.ts'],
        }),
        evidence({ id: 'bug-request', root: 'a', turn: 'turn-2', kind: 'request', summary: '修复核销结果页空白回归', branch }),
        evidence({
          id: 'bug-change', root: 'a', turn: 'turn-2', kind: 'change', summary: '修复核销结果页空白回归', branch,
          files: ['src/domain/write-off/result.ts'],
        }),
      ],
    });

    expect(items.map((item) => item.kind).sort()).toEqual(['bugfix', 'feature']);
    expect(items.map((item) => item.title)).not.toContain('write-off功能开发');
  });

  it('does not use generated dependency files as the business title', () => {
    const [item] = assembleWorkItems({
      activities: [activity('a', '新增活动绑定群弹窗')],
      evidence: [
        evidence({ id: 'request', root: 'a', kind: 'request', summary: '新增活动绑定群弹窗' }),
        evidence({
          id: 'change', root: 'a', kind: 'change', summary: '修改弹窗与 incut 任务文件',
          files: ['src/features/group-association/modal.tsx', 'node_modules/.incut/task.json'],
        }),
      ],
    });
    expect(item?.title).toBe('活动绑定群弹窗新增');
    expect(item?.changes[0]?.files).toContain('node_modules/.incut/task.json');
    expect(item?.subjectKey).toBeDefined();
  });

  it('treats generated diff cleanup as an operation even when it touches an app file', () => {
    const [item] = assembleWorkItems({
      activities: [activity('a', '怎么让 git diff 只保留两行生成结果')],
      evidence: [
        evidence({ id: 'request', root: 'a', kind: 'request', summary: '怎么让 git diff 只保留两行生成结果' }),
        evidence({
          id: 'change', root: 'a', kind: 'change', summary: '重新生成接口文件',
          files: ['apps/client/src/api/generated.ts'],
        }),
      ],
    });
    expect(item?.kind).toBe('operations');
  });

  it('treats neutral changes on a fix branch as bug work', () => {
    const [item] = assembleWorkItems({
      activities: [activity('a', '调整核销页底部间距')],
      evidence: [
        evidence({ id: 'request', root: 'a', kind: 'request', summary: '调整核销页底部间距', branch: 'fix/write-off' }),
        evidence({ id: 'change', root: 'a', kind: 'change', summary: '修改核销页样式', files: ['src/pages/write-off/index.tsx'], branch: 'fix/write-off' }),
      ],
    });
    expect(item?.kind).toBe('bugfix');
  });

  it('keeps explicit new development on a fix branch as a feature', () => {
    const [item] = assembleWorkItems({
      activities: [activity('a', '新增核销二维码下载')],
      evidence: [
        evidence({ id: 'request', root: 'a', kind: 'request', summary: '新增核销二维码下载', branch: 'fix/write-off' }),
        evidence({ id: 'change', root: 'a', kind: 'change', summary: '实现二维码下载', files: ['src/pages/write-off/download.ts'], branch: 'fix/write-off' }),
      ],
    });
    expect(item?.kind).toBe('feature');
  });

  it('treats removal of a failed adaptation as bug follow-up work', () => {
    const [item] = assembleWorkItems({
      activities: [activity('a', '删除之前为了滑动模板做的适配代码')],
      evidence: [
        evidence({ id: 'request', root: 'a', kind: 'request', summary: '删除之前为了滑动模板做的适配代码', branch: 'feat/poster' }),
        evidence({ id: 'change', root: 'a', kind: 'change', summary: '删除模板适配逻辑', files: ['src/features/poster/swiper.ts'], branch: 'feat/poster' }),
      ],
    });
    expect(item?.kind).toBe('bugfix');
  });

  it('does not block a completed change on an unrelated file-scoped failure', () => {
    const [item] = assembleWorkItems({
      activities: [activity('a', '实现用户接口字段')],
      evidence: [
        evidence({ id: 'request', root: 'a', kind: 'request', summary: '实现用户接口字段' }),
        evidence({ id: 'change', root: 'a', kind: 'change', summary: '修改 src/api.ts', files: ['src/api.ts'] }),
        evidence({
          id: 'lint-fail', root: 'a', kind: 'error', summary: '旧文件 lint 失败', files: ['src/legacy.ts'],
          verification: { command: 'eslint src/legacy.ts', exitCode: 1, outcome: 'failed' },
        }),
      ],
    });
    expect(item).toMatchObject({ kind: 'feature', status: 'completed', blockers: [] });
  });

  it('does not double-count overlapping sessions in one work item', () => {
    const left = activity('a', '新增用户接口字段');
    const right = activity('b', '继续完善用户接口字段');
    left.startedAt = '2026-07-16T01:00:00Z';
    left.endedAt = '2026-07-16T01:10:00Z';
    left.durationMinutes = 10;
    right.startedAt = '2026-07-16T01:05:00Z';
    right.endedAt = '2026-07-16T01:15:00Z';
    right.durationMinutes = 10;

    const [item] = assembleWorkItems({
      activities: [left, right],
      evidence: [
        evidence({ id: 'request-a', root: 'a', kind: 'request', summary: '新增用户接口字段' }),
        evidence({ id: 'request-b', root: 'b', kind: 'request', summary: '继续完善用户接口字段' }),
      ],
    });

    expect(item?.activeMinutes).toBe(15);
  });
});

function activity(id: string, goal: string): Activity {
  return {
    file: `/tmp/${id}.jsonl`, id, rootSessionId: id, title: '会话标题', cwd: '/workspace/app',
    gitBranch: 'feat/api', gitSha: '', startedAt: `2026-07-16T01:0${id === 'a' ? 0 : 2}:00Z`,
    endedAt: `2026-07-16T01:0${id === 'a' ? 2 : 8}:00Z`, originalStartedAt: '', originalEndedAt: '',
    activeMinutes: 5, durationMinutes: 5, observedSpanMinutes: 5, durationReliable: true,
    hadReplayBurst: false, durationReason: '可靠', targetDateActivityCount: 2, firstUserMessage: goal,
    userMessages: [goal], assistantMessages: ['已完成实现并测试通过'], changedFiles: ['src/api.ts'],
    commands: [], commandCount: 0, errors: [],
  };
}

function evidence(overrides: {
  id: string;
  root: string;
  kind: WorkEvidence['kind'];
  summary: string;
  files?: string[];
  timestamp?: string;
  verification?: WorkEvidence['verification'];
  branch?: string;
  turn?: string;
}): WorkEvidence {
  const branch = overrides.branch || 'feat/api';
  return {
    id: overrides.id,
    workItemKey: `/workspace/app|${branch}|${overrides.root}${overrides.turn ? `|turn:${overrides.turn}` : ''}`,
    rootSessionId: overrides.root,
    ...(overrides.turn ? { turnId: overrides.turn } : {}),
    kind: overrides.kind,
    status: 'confirmed', timestamp: overrides.timestamp || '2026-07-16T01:01:00Z', workspace: '/workspace/app',
    branch, files: overrides.files || [], summary: overrides.summary,
    sourceEventIds: [`event-${overrides.id}`], confidence: 'confirmed',
    ...(overrides.verification ? { verification: overrides.verification } : {}),
  };
}
