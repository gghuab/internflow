import { describe, expect, it } from 'vitest';
import { projectDevLogCandidates } from '../src/reports/dev-log/candidates.js';
import type { WorkItem } from '../src/work-items/types.js';
import {
  DEV_LOG_APPEND_THRESHOLD,
  DEV_LOG_CREATE_THRESHOLD,
  devLogMarkdownSection,
  resolveDevLogCandidates,
  scoreDevLogTargets,
} from '../src/reports/dev-log/document-index.js';
import { devLogPrompt } from '../src/reports/dev-log/prompt.js';

describe('dev log candidate projection', () => {
  it('keeps durable development while excluding research and report tooling', () => {
    const result = projectDevLogCandidates([
      item({ id: 'feature', kind: 'feature', changes: [change()] }),
      item({ id: 'research', kind: 'research', changes: [] }),
      item({ id: 'meta', kind: 'tooling', title: '日报脚本维护', changes: [change()] }),
      item({ id: 'meta-file', kind: 'bugfix', changes: [{ ...change(), files: ['src/reports/daily/prompt.ts'] }] }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ section: 'requirement', title: '功能实现', status: 'completed' });
    expect(result[0]?.title).toBe('功能实现');
  });

  it('uses the final verification outcome and does not turn an intermediate failure into a bug', () => {
    const result = projectDevLogCandidates([item({
      kind: 'feature', changes: [change()], blockers: [],
      verifications: [{
        command: 'npm test', normalizedCommand: 'npm test', outcome: 'passed', exitCode: 0,
        timestamp: '2026-07-16T01:00:00Z', evidenceIds: ['failed', 'passed'],
      }],
    })]);
    expect(result[0]).toMatchObject({ section: 'requirement', verificationSummary: 'npm test：通过' });
  });

  it('requires a verified change before persisting a refactor', () => {
    expect(projectDevLogCandidates([item({ kind: 'refactor', changes: [change()] })])).toEqual([]);
  });

  it('keeps personal tooling in the daily report instead of treating it as a requirement', () => {
    const assessments = [];
    const result = projectDevLogCandidates([item({
      id: 'grok2api', kind: 'feature', title: 'grok2api 本机配置',
      goal: '配置本机 grok2api 与模型接入', changes: [change()],
    })], { type: 'codex' }, assessments);

    expect(result).toEqual([]);
    expect(assessments).toEqual([
      expect.objectContaining({ policyId: 'devlog.admission', outcome: 'exclude' }),
    ]);
  });

  it('binds candidates to a matching document heading', () => {
    const [candidate] = projectDevLogCandidates([item({ kind: 'feature', changes: [change()] })]);
    expect(candidate).toBeDefined();
    if (!candidate) return;
    const assessments = [];
    const [resolved] = resolveDevLogCandidates([candidate], {
      markdown: '### 功能实现\n实现功能，修改 src/app.ts。\n#### 迭代日志\n##### 2026-07-15｜功能实现',
      headings: [
        { ref: 'h-root', blockId: 'root', level: 2, text: '需求开发记录', section: 'requirement' },
        { ref: 'h-feature', blockId: 'feature', level: 3, text: '功能实现', section: 'requirement' },
      ],
    }, { subject: 'feature' }, assessments);
    expect(resolved).toMatchObject({ operation: 'append' });
    expect(resolved?.allowedTargetRefs).toEqual(['h-feature']);
    expect(assessments).toContainEqual(expect.objectContaining({
      id: resolved?.routingAssessmentId, policyId: 'devlog.routing', outcome: 'append', confidence: 'high',
    }));
  });

  it('routes a matched requirement update to its change log', () => {
    const [candidate] = projectDevLogCandidates([item({
      kind: 'feature',
      title: '群聊打卡排行榜 Lynx 化',
      actions: ['整理排行榜模块'],
      changes: [{ ...change(), files: ['src/pages/check-in/rank-list/index.tsx'] }],
    })]);
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const assessments = [];
    const [resolved] = resolveDevLogCandidates([candidate], {
      markdown: `### REQ-004｜群聊打卡排行榜 / 我的作品页 Lynx 化
排行榜模块包含 rank-list，负责 RankContent 和页面整理。
#### 变更记录
##### 2026-07-15｜排行榜模块推进`,
      headings: [
        { ref: 'h-root', blockId: 'root', level: 2, text: '二、需求开发记录', section: 'requirement' },
        { ref: 'h-task', blockId: 'task', level: 3, text: 'REQ-004｜群聊打卡排行榜 / 我的作品页 Lynx 化', section: 'requirement' },
        { ref: 'h-background', blockId: 'background', level: 4, text: '背景与范围', section: 'requirement' },
        { ref: 'h-changes', blockId: 'changes', level: 4, text: '变更记录', section: 'requirement' },
        { ref: 'h-next', blockId: 'next', level: 3, text: 'REQ-005｜其他需求', section: 'requirement' },
      ],
    }, {}, assessments);

    expect(resolved).toMatchObject({ operation: 'append' });
    expect(resolved?.allowedTargetRefs).toContain('h-changes');
    expect(assessments).toContainEqual(expect.objectContaining({ id: resolved?.routingAssessmentId, outcome: 'append' }));
  });

  it('keeps a strongly matched requirement fix inside the requirement instead of creating an ISSUE', () => {
    const [candidate] = projectDevLogCandidates([item({
      kind: 'bugfix',
      title: '群聊打卡排行榜 Lynx 化',
      goal: '修复群聊打卡排行榜的筛选提示',
      actions: ['调整 RankContent 的自定义时间筛选提示'],
      changes: [{
        ...change(),
        files: ['apps/interest-chat-group-activity/src/pages/check-in/rank-list/components/RankContent/index.tsx'],
      }],
    })]);
    expect(candidate?.section).toBe('bugfix');
    if (!candidate) return;

    const [resolved] = resolveDevLogCandidates([candidate], {
      markdown: `### REQ-002｜保险业务改造
保险页面与投保接口。
### REQ-004｜群聊打卡排行榜 Lynx 化
群聊打卡排行榜的筛选提示由 RankContent 负责。
apps/interest-chat-group-activity/src/pages/check-in/rank-list/components/RankContent/index.tsx
#### 需求概览
当前持续修复。
#### 变更记录`,
      headings: [
        { ref: 'requirements', blockId: 'requirements', level: 2, text: '二、需求开发记录', section: 'requirement' },
        { ref: 'insurance', blockId: 'insurance', level: 3, text: 'REQ-002｜保险业务改造', section: 'requirement' },
        { ref: 'rank', blockId: 'rank', level: 3, text: 'REQ-004｜群聊打卡排行榜 Lynx 化', section: 'requirement' },
        { ref: 'rank-overview', blockId: 'rank-overview', level: 4, text: '需求概览', section: 'requirement' },
        { ref: 'rank-changes', blockId: 'rank-changes', level: 4, text: '变更记录', section: 'requirement' },
        { ref: 'issues', blockId: 'issues', level: 2, text: '三、问题与修复记录', section: 'bugfix' },
      ],
    }, {}, [], '2026-07-26');

    expect(resolved).toMatchObject({
      section: 'requirement',
      operation: 'append',
      subjectHeading: 'REQ-004｜群聊打卡排行榜 Lynx 化',
    });
    expect(resolved?.writeTargets).toContainEqual(expect.objectContaining({
      ref: 'rank-changes',
      role: 'change-log',
      operation: 'append',
    }));
    expect(resolved?.writeTargets.some((target) => target.role === 'issue')).toBe(false);
  });

  it('still creates an ISSUE when a bug fix has no confident requirement match', () => {
    const [candidate] = projectDevLogCandidates([item({
      kind: 'bugfix',
      title: '登录回调崩溃修复',
      goal: '修复独立登录回调崩溃',
      changes: [{ ...change(), files: ['src/auth/login-callback.ts'] }],
    })]);
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const [resolved] = resolveDevLogCandidates([candidate], {
      markdown: '### REQ-001｜保险业务改造\n投保页面开发。',
      headings: [
        { ref: 'requirements', blockId: 'requirements', level: 2, text: '二、需求开发记录', section: 'requirement' },
        { ref: 'insurance', blockId: 'insurance', level: 3, text: 'REQ-001｜保险业务改造', section: 'requirement' },
        { ref: 'issues', blockId: 'issues', level: 2, text: '三、问题与修复记录', section: 'bugfix' },
      ],
    }, {}, [], '2026-07-26');

    expect(resolved).toMatchObject({
      section: 'bugfix',
      operation: 'create',
      subjectHeading: 'ISSUE-001｜登录回调崩溃修复',
    });
  });

  it('plans current-fact replacements, history append, and overview refresh locally', () => {
    const [candidate] = projectDevLogCandidates([item({
      kind: 'feature',
      title: '群聊打卡排行榜 Lynx 化',
      changes: [{
        ...change(),
        files: ['src/pages/check-in/rank-list/index.tsx'],
        excerpts: [{
          file: 'src/pages/check-in/rank-list/index.tsx',
          language: 'tsx',
          content: 'export function RankList() { return <View />; }',
          sha256: 'excerpt-sha',
          sourceEventId: 'change',
          truncated: false,
        }],
      }],
      verifications: [{
        command: 'npm test',
        normalizedCommand: 'npm test',
        outcome: 'passed',
        exitCode: 0,
        timestamp: '2026-07-26T02:00:00Z',
        evidenceIds: ['verification'],
      }],
    })]);
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const [resolved] = resolveDevLogCandidates([candidate], {
      markdown: '### REQ-004｜群聊打卡排行榜 Lynx 化\n#### 需求概览\n旧状态\n#### 背景与范围\n旧背景\n#### 方案与职责边界\n旧方案\n#### 核心实现\n#### 验证与交付\n旧验证\n#### 变更记录\n#### 复盘与沉淀\n旧复盘',
      headings: [
        { ref: 'overview', blockId: 'overview', level: 2, text: '一、开发总览', section: 'overview' },
        { ref: 'status', blockId: 'status', level: 3, text: '1. 当前需求状态', section: 'overview' },
        { ref: 'recent', blockId: 'recent', level: 3, text: '2. 最近更新｜2026-07-24', section: 'overview' },
        { ref: 'todos', blockId: 'todos', level: 3, text: '3. 待确认事项', section: 'overview' },
        { ref: 'requirements', blockId: 'requirements', level: 2, text: '二、需求开发记录', section: 'requirement' },
        { ref: 'task', blockId: 'task', level: 3, text: 'REQ-004｜群聊打卡排行榜 Lynx 化', section: 'requirement' },
        { ref: 'task-overview', blockId: 'task-overview', level: 4, text: '需求概览', section: 'requirement' },
        { ref: 'background', blockId: 'background', level: 4, text: '背景与范围', section: 'requirement' },
        { ref: 'design', blockId: 'design', level: 4, text: '方案与职责边界', section: 'requirement' },
        { ref: 'implementation', blockId: 'implementation', level: 4, text: '核心实现', section: 'requirement' },
        { ref: 'verification', blockId: 'verification', level: 4, text: '验证与交付', section: 'requirement' },
        { ref: 'changes', blockId: 'changes', level: 4, text: '变更记录', section: 'requirement' },
        { ref: 'retrospective', blockId: 'retrospective', level: 4, text: '复盘与沉淀', section: 'requirement' },
        { ref: 'issues', blockId: 'issues', level: 2, text: '三、问题与修复记录', section: 'bugfix' },
        { ref: 'insights', blockId: 'insights', level: 2, text: '四、工程经验沉淀', section: 'insight' },
      ],
    }, { [candidate.subjectKey]: { headingText: 'REQ-004｜群聊打卡排行榜 Lynx 化' } }, [], '2026-07-26');

    expect(resolved?.subjectHeading).toBe('REQ-004｜群聊打卡排行榜 Lynx 化');
    expect(resolved?.writeTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: 'task-overview', operation: 'replace', role: 'requirement-overview', required: true }),
      expect.objectContaining({ ref: 'implementation', operation: 'append', role: 'implementation', required: true, markdownPrefix: '##### ' }),
      expect.objectContaining({ ref: 'verification', operation: 'replace', role: 'verification', required: true }),
      expect.objectContaining({ ref: 'changes', operation: 'append', role: 'change-log', required: true, bindSubject: true }),
      expect.objectContaining({ ref: 'status', operation: 'replace', role: 'overview-status', required: true }),
      expect.objectContaining({ ref: 'recent', operation: 'replace', role: 'overview-recent', markdownPrefix: '### 2. 最近更新｜2026-07-26' }),
      expect.objectContaining({ ref: 'todos', operation: 'replace', role: 'overview-todos', required: true }),
    ]));
    expect(resolved?.writeTargets.some((target) => (
      target.role === 'background' || target.role === 'design' || target.role === 'retrospective'
    ))).toBe(false);
  });

  it('only plans an optional current section when the daily facts contain matching evidence', () => {
    const [candidate] = projectDevLogCandidates([item({
      kind: 'feature',
      title: '排行榜状态拆分',
      decisions: ['采用状态机方案，明确页面状态与列表状态的职责边界'],
      changes: [{ ...change(), files: ['src/pages/check-in/rank-list/index.tsx'] }],
    })]);
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const [resolved] = resolveDevLogCandidates([candidate], {
      markdown: '### REQ-004｜排行榜状态拆分\n#### 需求概览\n当前开发中\n#### 方案与职责边界\n旧方案\n#### 变更记录',
      headings: [
        { ref: 'requirements', blockId: 'requirements', level: 2, text: '二、需求开发记录', section: 'requirement' },
        { ref: 'task', blockId: 'task', level: 3, text: 'REQ-004｜排行榜状态拆分', section: 'requirement' },
        { ref: 'task-overview', blockId: 'task-overview', level: 4, text: '需求概览', section: 'requirement' },
        { ref: 'design', blockId: 'design', level: 4, text: '方案与职责边界', section: 'requirement' },
        { ref: 'changes', blockId: 'changes', level: 4, text: '变更记录', section: 'requirement' },
      ],
    }, { [candidate.subjectKey]: { headingText: 'REQ-004｜排行榜状态拆分' } }, [], '2026-07-26');

    expect(resolved?.writeTargets).toContainEqual(expect.objectContaining({
      ref: 'design',
      role: 'design',
      operation: 'replace',
      required: false,
    }));
  });

  it('extracts the matching repeated subsection instead of the first same-name heading', () => {
    const snapshot = {
      markdown: '### REQ-001｜A\n#### 需求概览\nA 当前事实\n### REQ-002｜B\n#### 需求概览\nB 当前事实',
      headings: [
        { ref: 'a', blockId: 'a', level: 3, text: 'REQ-001｜A', section: 'requirement' as const },
        { ref: 'a-overview', blockId: 'a-overview', level: 4, text: '需求概览', section: 'requirement' as const },
        { ref: 'b', blockId: 'b', level: 3, text: 'REQ-002｜B', section: 'requirement' as const },
        { ref: 'b-overview', blockId: 'b-overview', level: 4, text: '需求概览', section: 'requirement' as const },
      ],
    };

    expect(devLogMarkdownSection(snapshot, 'b-overview')).toBe('#### 需求概览\nB 当前事实');
    expect(devLogMarkdownSection({
      markdown: '### ISSUE-007｜模板显示 `not found`\n问题正文',
      headings: [{
        ref: 'issue', blockId: 'issue', level: 3,
        text: 'ISSUE-007｜模板显示 not found', section: 'bugfix',
      }],
    }, 'issue')).toBe('### ISSUE-007｜模板显示 `not found`\n问题正文');
  });

  it('allocates new REQ numbers locally and never scores another document section', () => {
    const candidates = projectDevLogCandidates([
      item({
        id: 'payment',
        subjectKey: 'payment',
        kind: 'feature',
        title: '全新支付确认',
        goal: '实现支付确认',
        changes: [{ ...change(), files: ['src/payment/confirm.ts'] }],
      }),
      item({
        id: 'refund',
        subjectKey: 'refund',
        kind: 'feature',
        title: '全新退款申请',
        goal: '实现退款申请',
        changes: [{ ...change(), files: ['src/refund/apply.ts'] }],
      }),
    ]);
    const snapshot = {
      markdown: '### REQ-005｜已有需求\n### ISSUE-009｜支付确认失败',
      headings: [
        { ref: 'requirements', blockId: 'requirements', level: 2, text: '二、需求开发记录', section: 'requirement' as const },
        { ref: 'old', blockId: 'old', level: 3, text: 'REQ-005｜已有需求', section: 'requirement' as const },
        { ref: 'issues', blockId: 'issues', level: 2, text: '三、问题与修复记录', section: 'bugfix' as const },
        { ref: 'payment-issue', blockId: 'payment-issue', level: 3, text: 'ISSUE-009｜支付确认失败', section: 'bugfix' as const },
        { ref: 'insights', blockId: 'insights', level: 2, text: '四、工程经验沉淀', section: 'insight' as const },
      ],
    };

    expect(scoreDevLogTargets(candidates[0]!, snapshot).map((target) => target.targetRef)).toEqual(['old']);
    const resolved = resolveDevLogCandidates(candidates, snapshot, {}, [], '2026-07-26');
    expect(resolved.map((candidate) => candidate.subjectHeading)).toEqual([
      'REQ-006｜全新支付确认',
      'REQ-007｜全新退款申请',
    ]);
    expect(resolved.map((candidate) => candidate.writeTargets[0]?.markdownPrefix)).toEqual([
      '### REQ-006｜全新支付确认',
      '### REQ-007｜全新退款申请',
    ]);
  });

  it('creates an unmatched requirement at the section root instead of the last child heading', () => {
    const [candidate] = projectDevLogCandidates([item({
      kind: 'feature', title: '全新支付需求', actions: ['实现支付确认'],
      changes: [{ ...change(), files: ['src/payment/confirm.ts'] }],
    })]);
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const assessments = [];
    const [resolved] = resolveDevLogCandidates([candidate], {
      headings: [
        { ref: 'h-root', blockId: 'root', level: 2, text: '一、需求开发档案', section: 'requirement' },
        { ref: 'h-old', blockId: 'old', level: 3, text: '历史排行榜需求', section: 'requirement' },
        { ref: 'h-old-log', blockId: 'old-log', level: 4, text: '迭代日志', section: 'requirement' },
      ],
    }, {}, assessments);

    expect(resolved).toMatchObject({ operation: 'create' });
    expect(resolved?.allowedTargetRefs).toEqual(['h-root']);
    expect(assessments).toContainEqual(expect.objectContaining({
      id: resolved?.routingAssessmentId, outcome: 'create', confidence: 'low', score: expect.any(Object),
    }));
  });

  it('scores five explainable indicators with the configured 35/25/20/10/10 weights', () => {
    const [base] = projectDevLogCandidates([item({
      kind: 'feature',
      title: '打卡贴纸与日历海报样式调整',
      goal: '调整打卡贴纸与日历海报样式',
      branch: 'codex/checkin-tag-style',
      commits: ['8c459885'],
      startedAt: '2026-07-16T01:00:00Z',
      actions: ['调整 CheckInSticker 与 CalendarPoster'],
      changes: [{
        ...change(),
        files: [
          'apps/interest-mini-app/src/materials/check-in/CheckInSticker/index.tsx',
          'apps/interest-mini-app/src/materials/check-in/CalendarPoster/utils.ts',
        ],
      }],
    })]);
    expect(base).toBeDefined();
    if (!base) return;
    const snapshot = {
      markdown: `## 一、需求开发档案
### 2. 趣玩小程序升级为可颂活动（融合需求）
融合范围包含打卡贴纸与日历海报样式，代码位于 apps/interest-mini-app/src/materials/check-in/CheckInSticker/index.tsx 和 CalendarPoster/utils.ts。
#### 2.7 迭代日志
##### 2026-07-15｜打卡贴纸与日历海报样式调整
branch: codex/checkin-tag-style
commit: 8c459885
### 4. 群聊打卡排行榜 / 我的作品页 Lynx 化
排行榜位于 apps/interest-chat-group-activity/src/pages/check-in/rank-list。
#### 4.8 迭代日志`,
      headings: [
        { ref: 'root', blockId: 'root', level: 2, text: '一、需求开发档案', section: 'requirement' as const },
        { ref: 'fusion', blockId: 'fusion', level: 3, text: '2. 趣玩小程序升级为可颂活动（融合需求）', section: 'requirement' as const },
        { ref: 'fusion-log', blockId: 'fusion-log', level: 4, text: '2.7 迭代日志', section: 'requirement' as const },
        { ref: 'lynx', blockId: 'lynx', level: 3, text: '4. 群聊打卡排行榜 / 我的作品页 Lynx 化', section: 'requirement' as const },
        { ref: 'lynx-log', blockId: 'lynx-log', level: 4, text: '4.8 迭代日志', section: 'requirement' as const },
      ],
    };
    const [best] = scoreDevLogTargets(base, snapshot);
    expect(best?.targetRef).toBe('fusion-log');
    expect(best?.score).toBeGreaterThanOrEqual(DEV_LOG_APPEND_THRESHOLD);
    expect(best?.score).toBeCloseTo(
      best!.indicators.businessGoal * 0.35
      + best!.indicators.codeScope * 0.25
      + best!.indicators.history * 0.2
      + best!.indicators.deliveryReference * 0.1
      + best!.indicators.timeContinuity * 0.1,
      2,
    );

    const unrelated = { ...base, title: '新增支付退款流程', facts: ['新增支付确认和退款申请流程'], files: ['src/payment/refund.ts'] };
    const unrelatedScores = scoreDevLogTargets(unrelated, snapshot);
    const [created] = resolveDevLogCandidates([unrelated], snapshot);
    expect(unrelatedScores[0]?.score).toBeLessThanOrEqual(DEV_LOG_CREATE_THRESHOLD);
    expect(created).toMatchObject({ operation: 'create', allowedTargetRefs: ['root'] });
  });

  it('requires dated iteration entries, annotated core code, and rendered diagrams in the prompt', () => {
    const prompt = devLogPrompt({
      date: '2026-07-17', timezone: 'Asia/Shanghai', sourceCount: 1, filteredCount: 0, activities: [],
      resolvedDevLogCandidates: [{
        id: 'candidate', subjectKey: 'subject', section: 'requirement', operation: 'append',
        title: '接口字段实现', status: 'completed', facts: ['完成字段实现'], files: ['src/api.ts'],
        excerpts: [], verificationSummary: 'npm test：通过', evidenceIds: ['e1'],
        contentFingerprint: 'fingerprint', subjectHeading: 'REQ-001｜接口字段实现',
        allowedTargetRefs: ['h-log'],
        writeTargets: [{
          ref: 'h-log', section: 'requirement', operation: 'append', role: 'change-log',
          required: true, markdownPrefix: '##### 2026-07-17｜', bindSubject: true,
        }],
        routingAssessmentId: 'routing',
      }],
    }, {
      markdown: '# 需求开发记录',
      headings: [{ ref: 'h-log', blockId: 'log', level: 4, text: '迭代日志', section: 'requirement' }],
    });

    expect(prompt).toContain('"markdownPrefix": "##### 2026-07-17｜"');
    expect(prompt).toContain('每个 required=true 的 writeTarget 必须输出');
    expect(prompt).toContain('每个真实实现模块必须使用有意义的五级标题');
    expect(prompt).toContain('不得生成空章节');
    expect(prompt).toContain('文档注释，非源码');
    expect(prompt).toContain('Mermaid');
    expect(prompt).toContain('不能因为标题中出现“修复”就自动归到 bugfix');
  });
});

function change() {
  return { files: ['src/app.ts'], summary: '修改 src/app.ts', excerpts: [], evidenceIds: ['change'] };
}

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'item', subjectKey: 'subject', repositoryKey: '/workspace', kind: 'feature', status: 'completed',
    title: '功能实现', goal: '实现功能', actions: ['修改 src/app.ts'], outcomes: [], decisions: [],
    changes: [], verifications: [], blockers: [], startedAt: '2026-07-16T01:00:00Z',
    endedAt: '2026-07-16T01:10:00Z', activeMinutes: 10, durationReliable: true,
    sessionIds: ['session'], evidenceIds: ['request', 'change'], confidence: 'confirmed', ...overrides,
  };
}
