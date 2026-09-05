import { describe, expect, it } from 'vitest';
import { manualValidationFacts, projectDailyWorkItems } from '../src/reports/daily/view.js';
import type { WorkItem, WorkItemKind } from '../src/work-items/types.js';
import { dailyDraftSchema } from '../src/reports/daily/schema.js';
import { fallbackDailyDraft, renderDailyReport, validateDailyDraft } from '../src/reports/daily/render.js';
import { workItemDailyInput } from '../src/reports/daily/input.js';
import { compactFact } from '../src/work-items/assembly/text.js';

describe('daily work view', () => {
  it('keeps decision detail instead of a Markdown-only conclusion heading', () => {
    expect(compactFact('**结论**\n真正的根因是缓存没有失效。'))
      .toBe('结论：真正的根因是缓存没有失效。');
  });

  it('keeps development, research and tooling while excluding report maintenance', () => {
    const view = projectDailyWorkItems([
      item({ id: 'feature', kind: 'feature', title: '接口字段实现' }),
      item({ id: 'research', kind: 'research', title: 'TypeScript 编译机制分析' }),
      item({ id: 'tooling', kind: 'tooling', title: '构建工具升级' }),
      item({ id: 'meta', kind: 'docs', title: '日报格式维护' }),
    ], { type: 'codex' });
    expect(view.items.map((value) => value.id)).toEqual(['feature', 'research', 'tooling']);
  });

  it('keeps configured company sources while excluding personal repositories', () => {
    const view = projectDailyWorkItems([
      item({
        id: 'company-code',
        repositoryKey: 'ssh://developer@code.byted.org/team/product.git',
        title: '实现公司业务需求',
      }),
      item({
        id: 'company-doc',
        goal: '更新 https://bytedance.larkoffice.com/docx/work-document 技术方案',
        title: '整理公司技术方案',
      }),
      item({
        id: 'personal-resume',
        repositoryKey: 'https://github.com/example/vibe-resume',
        title: '制作个人求职简历',
      }),
    ], {
      type: 'codex',
      // 公司日报采用来源白名单，不能依赖“简历”等容易漏判的关键词黑名单。
      include: ['code[-.]byted[-.]org', 'bytedance[.]larkoffice[.]com'],
    });

    expect(view.items.map((value) => value.id)).toEqual(['company-code', 'company-doc']);
  });

  it('selects a reliable longest item and reports near ties', () => {
    const unique = projectDailyWorkItems([
      item({ id: 'long', activeMinutes: 20 }), item({ id: 'short', activeMinutes: 5 }),
    ], { type: 'codex' });
    expect(unique.longestWorkItemId).toBe('long');

    const tied = projectDailyWorkItems([
      item({ id: 'a', activeMinutes: 20 }), item({ id: 'b', activeMinutes: 19 }),
    ], { type: 'codex' });
    expect(tied.longestWorkItemId).toBeNull();
    expect(tied.longestTiedIds).toEqual(['a', 'b']);
  });

  it('renders a narrative daily report with a worthwhile model diagram', () => {
    const workItem = item({
      id: 'w1', evidenceIds: ['e1', 'e-change', 'e-verify'], outcomes: ['接口测试通过'],
      actions: ['梳理字段契约', '修改响应结构', '补齐测试', '验证下游消费'],
      decisions: ['采用结构化响应'],
      changes: [{
        files: ['src/api.ts', '/Users/example/Library/LaunchAgents/example.plist'],
        summary: '修改接口与本机任务配置', excerpts: [], evidenceIds: ['e-change'],
      }],
      verifications: [{
        command: 'npm test', normalizedCommand: 'npm test', outcome: 'passed', exitCode: 0,
        timestamp: '2026-07-16T01:09:00Z', evidenceIds: ['e-verify'],
      }],
    });
    const view = projectDailyWorkItems([workItem], { type: 'codex' });
    const draft = dailyDraftSchema.parse({
      headline: '今天主线是补齐接口字段并完成测试闭环',
      overview: '今天围绕接口字段实现推进，完成代码改动与测试验证，并形成可同步的结果说明，便于自己回看和 mentor 沟通。',
      today: [{
        workItemId: 'w1',
        relatedWorkItemIds: [],
        detailLevel: 'full',
        title: '功能实现',
        background: '接口字段缺失导致下游无法消费完整数据。',
        progress: [
          '先梳理字段契约，再确认下游所需字段。',
          '采用结构化响应并修改接口实现。',
          '补齐测试，确认结构化响应可以稳定返回。',
        ],
        keyDecision: '采用结构化响应，把字段约束前移到类型和测试。',
        result: '接口字段已落地，测试通过。',
        openQuestions: '',
        evidenceIds: ['e1'],
      }],
      deepDives: [{
        workItemId: 'w1',
        title: '结构化响应降低字段遗漏风险',
        conclusion: '统一响应契约可以把字段遗漏提前暴露在类型和测试阶段。',
        mechanism: '通过统一响应结构，把字段约束前移到类型和测试。',
        evidence: '新增字段路径已由测试覆盖。',
        boundary: '只改运行时对象而不更新类型定义时，该约束无法生效。',
        evidenceIds: ['e1'],
      }],
      takeaways: [],
      diagrams: [{
        title: '接口字段落地流程',
        mermaid: 'flowchart LR\n  A[梳理契约] --> B[改响应结构]\n  B --> C[补测试]',
        workItemId: 'w1',
        assessmentId: view.visualPlan.find((item) => item.workItemId === 'w1')!.assessmentId,
      }],
      suggestions: [{
        workItemId: 'w1',
        priority: 'P1',
        text: '补充边界用例',
        completionCriteria: '异常字段和缺失字段路径均有测试覆盖。',
      }],
      agentCandidates: [],
    });
    const markdown = renderDailyReport({
      date: '2026-07-16', timezone: 'Asia/Shanghai', sourceCount: 1, filteredCount: 0,
      activities: [], dailyView: view, workItems: [workItem], workEvidence: [
        fact('e1', 'request', '实现接口字段'),
        fact('e-change', 'change', '修改 src/api.ts'),
        fact('e-verify', 'verification', 'npm test（通过）'),
      ],
    }, view, validateDailyDraft(view, draft));

    expect(markdown).toContain('## 1. 今日工作');
    expect(markdown).toContain('## 2. 重点任务');
    expect(markdown).toContain('## 3. 技术沉淀');
    expect(markdown).toContain('## 4. 方法总结');
    expect(markdown).toContain('## 5. 下一步');
    expect(markdown).toContain('今天主线是补齐接口字段并完成测试闭环');
    expect(markdown).toContain('接口字段缺失导致下游无法消费完整数据');
    expect(markdown).toContain('- **进展与闭环**：已形成可复核产出；已记录通过验证');
    expect(markdown).toContain('- **推进与取舍**');
    expect(markdown).toContain('  - 先梳理字段契约，再确认下游所需字段。');
    expect(markdown).toContain('  - 改动范围：项目：api（1 个文件）；本机配置：LaunchAgents（1 个文件）');
    expect(markdown).not.toContain('/Users/example');
    expect(markdown).toContain('  - 自动化检查：执行了测试，1 项通过');
    expect(markdown).not.toContain('npm test（通过）');
    expect(markdown).toContain('```mermaid');
    expect(markdown).toContain('接口字段落地流程');
    expect(markdown).not.toContain('<p><br/></p>');
    expect(markdown).toContain('1. **P1｜补充边界用例**');
    expect(markdown).toContain('完成标准：异常字段和缺失字段路径均有测试覆盖。');
    expect(markdown.indexOf('- 目标日期：2026-07-16')).toBeLessThan(markdown.indexOf('> 今天主线'));
    expect(markdown).not.toContain('数据审计（点击展开）');
    expect(() => validateDailyDraft(view, {
      ...draft, today: [{ ...draft.today[0]!, evidenceIds: ['invented'] }],
    })).toThrow(/outside work item/);
    expect(() => validateDailyDraft(view, { ...draft, today: [] }))
      .toThrow(/omitted reportable work items/);
  });

  it('rejects unsafe diagrams and does not force a diagram into a simple fallback', () => {
    const workItem = item({ id: 'w1' });
    const view = projectDailyWorkItems([workItem], { type: 'codex' });
    expect(() => validateDailyDraft(view, {
      ...fallbackDailyDraft(view),
      diagrams: [{
        title: 'bad',
        mermaid: 'flowchart LR\n  click A "javascript:alert(1)"',
        workItemId: null,
        assessmentId: 'not-approved',
      }],
    })).toThrow(/unsupported mermaid/);

    const markdown = renderDailyReport({
      date: '2026-07-16', timezone: 'Asia/Shanghai', sourceCount: 1, filteredCount: 0,
      activities: [], dailyView: view, workItems: [workItem],
    }, view, fallbackDailyDraft(view));
    expect(markdown).toContain('## 1. 今日工作');
    expect(markdown).not.toContain('```mermaid');
    expect(markdown).toContain('功能实现');
  });

  it('builds inline visuals only from structured progress', () => {
    const workItem = item({
      id: 'inline', title: '调整发布配置', goal: '完成发布版本调整',
      actions: [
        '梳理发布条件',
        '修改 apps/interest-mini-app/config/ci.json',
        'node -e "JSON.parse(require(\'fs\').readFileSync(\'config/ci.json\'))"',
      ],
      outcomes: ['apps/interest-mini-app/config/ci.json 已更新'],
      changes: [{
        files: ['apps/interest-mini-app/config/ci.json'], summary: '调整发布版本', excerpts: [], evidenceIds: ['evidence'],
      }],
    });
    const view = projectDailyWorkItems([workItem], { type: 'codex' });
    expect(view.visualPlan.find((entry) => entry.workItemId === 'inline')?.mode).toBe('inline');

    const fallback = fallbackDailyDraft(view);
    const fallbackMarkdown = renderDailyReport({
      date: '2026-07-16', timezone: 'Asia/Shanghai', sourceCount: 1, filteredCount: 0,
      activities: [], dailyView: view, workItems: [workItem],
    }, view, fallback);
    expect(fallbackMarkdown).not.toContain('简要图示');

    const markdown = renderDailyReport({
      date: '2026-07-16', timezone: 'Asia/Shanghai', sourceCount: 1, filteredCount: 0,
      activities: [], dailyView: view, workItems: [workItem],
    }, view, {
      ...fallback,
      today: [{
        ...fallback.today[0]!,
        progress: ['核对发布条件', '更新版本配置', '完成配置校验'],
      }],
    });

    expect(markdown).toContain('- **简要图示**：核对发布条件 → 更新版本配置 → 完成配置校验');
    expect(markdown).not.toContain('简要图示**：修改 apps/');
    expect(markdown).not.toContain('简要图示**：node -e');
  });

  it('keeps three distinct valuable diagrams and uses no semantic count cap', () => {
    const complex = item({
      id: 'complex', repositoryKey: '/repo/a', actions: ['梳理缓存', '调整路由', '整理分页', '补充并发保护'],
      decisions: ['采用共享路由', '保留会话优先级'],
      changes: [{ files: ['src/cache/a.ts', 'src/stream/b.ts'], summary: '跨模块修改', excerpts: [], evidenceIds: ['evidence'] }],
    });
    const branch = item({
      id: 'branch', repositoryKey: '/repo/b', actions: ['读取活动', '判断审核类型', '清空展示字段'],
      decisions: ['审核前处理', '写回保持不变'],
    });
    const state = item({
      id: 'state', repositoryKey: '/repo/d', goal: '整理发布状态机与状态转换',
      actions: ['读取当前状态', '判断转换事件', '写入目标状态', '校验生命周期'],
      decisions: ['非法转换保持原状态'],
      changes: [{ files: ['src/state/machine.ts', 'src/release/lifecycle.ts'], summary: '状态流转修改', excerpts: [], evidenceIds: ['evidence'] }],
    });
    const simple = item({
      id: 'simple', repositoryKey: '/repo/c', kind: 'research', actions: ['查看参数'], decisions: ['未发现字段'],
    });
    const view = projectDailyWorkItems([complex, branch, state, simple], { type: 'codex' });
    const base = fallbackDailyDraft(view);
    const plan = (id: string) => view.visualPlan.find((item) => item.workItemId === id)!;
    const draft = validateDailyDraft(view, {
      ...base,
      diagrams: [
        { title: '缓存链路', mermaid: 'flowchart LR\n A --> B\n B --> C\n C --> D', workItemId: 'complex', assessmentId: plan('complex').assessmentId },
        { title: '审核分支', mermaid: 'flowchart LR\n A --> B\n B --> C', workItemId: 'branch', assessmentId: plan('branch').assessmentId },
        { title: '发布状态', mermaid: 'stateDiagram-v2\n Ready --> Publishing\n Publishing --> Done', workItemId: 'state', assessmentId: plan('state').assessmentId },
      ],
    });

    expect(draft.diagrams.map((diagram) => diagram.title)).toEqual(['缓存链路', '审核分支', '发布状态']);
    expect(view.visualPlan.find((item) => item.workItemId === 'simple')?.mode).not.toBe('flowchart');
  });

  it('compresses adjacent brief work items into the other-items table', () => {
    const first = item({ id: 'w1', title: '第一项工作' });
    const second = item({ id: 'w2', title: '第二项工作' });
    const view = projectDailyWorkItems([first, second], { type: 'codex' });

    const markdown = renderDailyReport({
      date: '2026-07-16', timezone: 'Asia/Shanghai', sourceCount: 2, filteredCount: 0,
      activities: [], dailyView: view, workItems: [first, second],
    }, view, fallbackDailyDraft(view));

    expect(markdown).toContain('### 其他事项');
    expect(markdown).toContain('| 第一项工作 | 形成可复核的交付结果 |');
    expect(markdown).toContain('| 第二项工作 | 形成可复核的交付结果 |');
    expect(markdown).not.toContain('#### 第一项工作');
    expect(markdown).not.toContain('#### 第二项工作');
  });

  it('lets one Today section cover multiple work items without losing evidence', () => {
    const frontend = item({
      id: 'frontend', title: '调整打卡页面', evidenceIds: ['frontend-evidence'],
      changes: [{ files: ['apps/web/src/check-in/page.tsx'], summary: '调整页面', excerpts: [], evidenceIds: ['frontend-evidence'] }],
    });
    const backend = item({
      id: 'backend', title: '调整打卡审核', repositoryKey: '/backend', evidenceIds: ['backend-evidence'],
      changes: [{ files: ['service/check_in/get.go'], summary: '调整审核', excerpts: [], evidenceIds: ['backend-evidence'] }],
    });
    const view = projectDailyWorkItems([frontend, backend], { type: 'codex' });
    const fallback = fallbackDailyDraft(view);
    const draft = validateDailyDraft(view, {
      ...fallback,
      today: [{
        ...fallback.today[0]!,
        relatedWorkItemIds: ['backend'],
        title: '推进打卡融合需求',
        evidenceIds: ['frontend-evidence', 'backend-evidence'],
      }],
    });

    const markdown = renderDailyReport({
      date: '2026-07-17', timezone: 'Asia/Shanghai', sourceCount: 2, filteredCount: 0,
      activities: [], dailyView: view, workItems: [frontend, backend],
    }, view, draft);

    expect(draft.today).toHaveLength(1);
    expect(markdown).toContain('#### 推进打卡融合需求');
    expect(markdown).toContain('合并 2 项关联工作');
    expect(markdown).toContain('web：check-in（1 个文件）');
    expect(markdown).toContain('项目：service/check_in（1 个文件）');
  });

  it('projects deterministic full and brief levels and passes every plan to the model input', () => {
    const full = item({
      id: 'full',
      title: '实现展示分级',
      changes: [{
        files: ['src/ui/presentation.ts'], summary: '增加展示分级', excerpts: [], evidenceIds: ['evidence'],
      }],
    });
    const brief = item({
      id: 'brief',
      title: '确认参数含义',
      goal: '确认一个参数的含义',
      activeMinutes: 4,
      commits: ['baseline123'],
    });
    const view = projectDailyWorkItems([full, brief], { type: 'codex' });

    expect(view.presentationPlan).toEqual([
      { workItemId: 'full', detailLevel: 'full', reason: '存在代码或配置改动' },
      { workItemId: 'brief', detailLevel: 'brief', reason: '轻量事项，压缩展示以保留信息密度' },
    ]);
    const input = workItemDailyInput({
      date: '2026-07-16', timezone: 'Asia/Shanghai', sourceCount: 2, filteredCount: 0,
      activities: [], dailyView: view, workItems: [full, brief],
    });
    expect(input?.presentationPlan).toEqual(view.presentationPlan);
    expect(input?.deepDiveCandidateIds).toEqual(view.deepDiveCandidateIds);
    expect(input?.takeawayCandidateIds).toEqual(view.takeawayCandidateIds);
    expect(input?.items.find((entry) => entry.id === 'brief')?.commits).toBeUndefined();

    const draft = fallbackDailyDraft(view);
    expect(draft.today.map((entry) => [entry.workItemId, entry.detailLevel])).toEqual([
      ['full', 'full'],
      ['brief', 'brief'],
    ]);
    expect(validateDailyDraft(view, draft).today.flatMap((entry) => (
      [entry.workItemId, ...entry.relatedWorkItemIds]
    ))).toEqual(['full', 'brief']);
    const markdown = renderDailyReport({
      date: '2026-07-16', timezone: 'Asia/Shanghai', sourceCount: 2, filteredCount: 0,
      activities: [], dailyView: view, workItems: [full, brief],
    }, view, draft);
    expect(markdown).toContain('### 主要任务');
    expect(markdown).toContain('#### 实现展示分级');
    expect(markdown).toContain('### 其他事项');
    expect(markdown).toContain('| 确认参数含义 |');
    expect(markdown).toContain('- **进展与闭环**');
    expect(markdown).toContain('- **验证与证据**');
    expect(markdown).toContain('- **风险与未闭环**');
    expect(markdown).not.toContain('状态与投入');
    expect(markdown).not.toContain('验证情况');
  });

  it('renders partial coverage reasons exactly once', () => {
    const workItem = item({ id: 'partial', title: '确认截断数据' });
    const projected = projectDailyWorkItems([workItem], { type: 'codex' });
    const view = {
      ...projected,
      quality: { coverage: 'partial' as const, reasons: ['上下文截断导致部分细节缺失'] },
    };
    const markdown = renderDailyReport({
      date: '2026-07-16', timezone: 'Asia/Shanghai', sourceCount: 1, filteredCount: 0,
      activities: [], dailyView: view, workItems: [workItem],
    }, view, fallbackDailyDraft(view));

    expect(markdown.match(/数据完整度/g)).toHaveLength(1);
    expect(markdown.match(/上下文截断导致部分细节缺失/g)).toHaveLength(1);
  });

  it('separates delivery progress from a failed quality check', () => {
    const workItem = item({
      id: 'failed-check',
      title: '提交接口改动',
      status: 'completed',
      commits: ['1234567890abcdef'],
      outcomes: ['已提交接口改动'],
      changes: [{
        files: ['src/api.ts'], summary: '修改接口', excerpts: [], evidenceIds: ['evidence'],
      }],
      verifications: [{
        command: 'npm run typecheck', normalizedCommand: 'npm run typecheck', outcome: 'failed',
        exitCode: 2, timestamp: '2026-07-16T01:09:00Z', evidenceIds: ['evidence'],
      }],
    });
    const view = projectDailyWorkItems([workItem], { type: 'codex' });
    const markdown = renderDailyReport({
      date: '2026-07-16', timezone: 'Asia/Shanghai', sourceCount: 1, filteredCount: 0,
      activities: [], dailyView: view, workItems: [workItem],
    }, view, fallbackDailyDraft(view));

    expect(markdown).toContain('已交付；验证失败，待确认是本次改动还是存量问题');
    expect(markdown).toContain('自动化检查：执行了类型检查，1 项失败');
    expect(markdown).toContain('交付证据：Commit 1234567890');
    expect(markdown).not.toContain('验证已通过');
  });

  it('keeps manual validation visible when no shell verification exists', () => {
    const workItem = item({
      id: 'manual-qa',
      title: '验证图标方向',
      decisions: ['三人盲测形成严格多数'],
      outcomes: [
        '已完成真机预览和截图复核',
        'direction-blind-validation.json 为 ok: true',
        '我先结合截图判断实验设计风险',
        '后续会重新做三人盲测',
      ],
    });
    const view = projectDailyWorkItems([workItem], { type: 'codex' });
    expect(view.deepDiveCandidateIds).toContain('manual-qa');
    expect(view.takeawayCandidateIds).toContain('manual-qa');
    expect(manualValidationFacts(workItem)).toEqual([
      '已完成真机预览和截图复核',
      'direction-blind-validation.json 为 ok: true',
      '三人盲测形成严格多数',
    ]);
    const markdown = renderDailyReport({
      date: '2026-07-16', timezone: 'Asia/Shanghai', sourceCount: 1, filteredCount: 0,
      activities: [], dailyView: view, workItems: [workItem],
    }, view, fallbackDailyDraft(view));

    expect(markdown).toContain('已记录运行态或人工验证');
    expect(markdown).toContain('运行态 / 人工验证：已完成真机预览和截图复核');
    expect(markdown).toContain('三人盲测形成严格多数');
    expect(markdown).not.toContain('未记录独立验证命令');
  });

  it('removes a method summary when overlapping candidates reuse a technical work item', () => {
    const workItem = item({
      id: 'overlap',
      kind: 'research',
      actions: ['确认现象', '对比实现', '验证结论'],
      decisions: ['采用结构化契约'],
      verifications: [{
        command: 'npm test', normalizedCommand: 'npm test', outcome: 'passed', exitCode: 0,
        timestamp: '2026-07-16T01:09:00Z', evidenceIds: ['evidence'],
      }],
    });
    const view = projectDailyWorkItems([workItem], { type: 'codex' });
    expect(view.deepDiveCandidateIds).toContain('overlap');
    expect(view.takeawayCandidateIds).toContain('overlap');
    const fallback = fallbackDailyDraft(view);
    const normalized = validateDailyDraft(view, {
      ...fallback,
      deepDives: [{
        workItemId: 'overlap',
        title: '结构化契约',
        conclusion: '结构化契约可以降低遗漏。',
        mechanism: '字段约束会在解析阶段生效。',
        evidence: '测试已经覆盖主路径。',
        boundary: '动态字段仍需额外校验。',
        evidenceIds: ['evidence'],
      }],
      takeaways: [{
        workItemId: 'overlap',
        method: '先定义契约',
        applicability: '跨模块字段传递。',
        defaultAction: '先定义字段再实现。',
        completionCriteria: '类型和测试同时通过。',
        avoid: '避免只修改运行时对象。',
        evidenceIds: ['evidence'],
      }],
    });
    expect(normalized.deepDives).toHaveLength(1);
    expect(normalized.takeaways).toEqual([]);
  });

  it('drops optional summaries outside their local candidate allowlists', () => {
    const takeawayOnly = item({
      id: 'takeaway-only',
      actions: ['核对现状', '形成复用方法'],
      decisions: ['以后默认先核对事实'],
    });
    const projected = projectDailyWorkItems([takeawayOnly], { type: 'codex' });
    const view = {
      ...projected,
      deepDiveCandidateIds: [],
      takeawayCandidateIds: ['takeaway-only'],
    };
    const fallback = fallbackDailyDraft(view);
    const normalized = validateDailyDraft(view, {
      ...fallback,
      deepDives: [{
        workItemId: 'takeaway-only',
        title: '错误栏目',
        conclusion: '不应进入技术沉淀。',
        mechanism: '模型没有遵守候选列表。',
        evidence: '本地白名单可以识别。',
        boundary: '只过滤可选总结。',
        evidenceIds: takeawayOnly.evidenceIds,
      }],
      takeaways: [{
        workItemId: 'not-a-work-item',
        method: '错误方法',
        applicability: '无',
        defaultAction: '无',
        completionCriteria: '无',
        avoid: '无',
        evidenceIds: [],
      }],
    });

    expect(normalized.deepDives).toEqual([]);
    expect(normalized.takeaways).toEqual([]);
  });

  it('filters conversation fragments from progress-based inline visuals', () => {
    const workItem = item({
      id: 'dialogue',
      title: '梳理目标架构',
      actions: ['核对仓库实现', '区分当前状态', '整理目标架构', '完成架构验证'],
      changes: [{
        files: ['docs/architecture.md'], summary: '更新架构文档', excerpts: [], evidenceIds: ['evidence'],
      }],
    });
    const view = projectDailyWorkItems([workItem], { type: 'codex' });
    expect(view.visualPlan.find((entry) => entry.workItemId === 'dialogue')?.mode).toBe('inline');
    const fallback = fallbackDailyDraft(view);
    const markdown = renderDailyReport({
      date: '2026-07-16', timezone: 'Asia/Shanghai', sourceCount: 1, filteredCount: 0,
      activities: [], dailyView: view, workItems: [workItem],
    }, view, {
      ...fallback,
      today: [{
        ...fallback.today[0]!,
        progress: [
          '你说得对',
          '先给结论：',
          '对，这是当前仓库里的真实文件',
          '核对仓库实现',
          '区分当前状态',
          '完成架构验证',
        ],
      }],
    });

    expect(markdown).toContain('简要图示**：核对仓库实现 → 区分当前状态 → 完成架构验证');
    expect(markdown).not.toContain('简要图示**：你说得对');
    expect(markdown).not.toContain('简要图示**：先给结论');
  });

  it('selects a substantial focus task without claiming unreliable duration', () => {
    const workItem = item({
      id: 'unreliable',
      title: '修复构建链路',
      activeMinutes: null,
      durationReliable: false,
      changes: [{
        files: ['src/build.ts'], summary: '修复构建链路', excerpts: [], evidenceIds: ['evidence'],
      }],
    });
    const view = projectDailyWorkItems([workItem], { type: 'codex' });
    expect(view.longestWorkItemId).toBeNull();
    const markdown = renderDailyReport({
      date: '2026-07-16', timezone: 'Asia/Shanghai', sourceCount: 1, filteredCount: 0,
      activities: [], dailyView: view, workItems: [workItem],
    }, view, fallbackDailyDraft(view));

    expect(markdown).toContain('| 任务 | 修复构建链路 |');
    expect(markdown).not.toContain('累计约');
  });
});

function item(overrides: Partial<WorkItem> & { kind?: WorkItemKind } = {}): WorkItem {
  return {
    id: 'item', subjectKey: 'subject', repositoryKey: '/workspace', kind: 'feature', status: 'completed',
    title: '功能实现', goal: '实现功能', actions: [], outcomes: [], decisions: [], changes: [],
    verifications: [], blockers: [], startedAt: '2026-07-16T01:00:00Z', endedAt: '2026-07-16T01:10:00Z',
    activeMinutes: 10, durationReliable: true, sessionIds: ['session'], evidenceIds: ['evidence'],
    confidence: 'confirmed', ...overrides,
  };
}

function fact(id: string, kind: 'request' | 'change' | 'verification', summary: string) {
  return {
    id, workItemKey: '/workspace|main|session', kind, status: 'confirmed' as const,
    timestamp: '2026-07-16T01:00:00Z', workspace: '/workspace', files: [], summary,
    sourceEventIds: [`event-${id}`], confidence: 'confirmed' as const,
  };
}
