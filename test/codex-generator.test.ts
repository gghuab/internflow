import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStarterConfig } from '../src/core/config.js';
import type { ActivityBatch, RunContext } from '../src/core/contracts/index.js';
import {
  CodexGenerator,
  containsLevelOneOrTwoHeading,
  devLogMarkdownIssue,
} from '../src/plugins/generators/codex.js';

const previousStateDir = process.env.INTERNFLOW_STATE_DIR;

function emptyDailyView() {
  return {
    items: [],
    longestWorkItemId: null,
    longestReason: '当天没有可汇报工作项',
    longestTiedIds: [],
    excludedUnreliableCount: 0,
    deepDiveCandidateIds: [],
    takeawayCandidateIds: [],
    presentationPlan: [],
    visualPlan: [],
    quality: { coverage: 'high' as const, reasons: [] },
  };
}

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.INTERNFLOW_STATE_DIR;
  else process.env.INTERNFLOW_STATE_DIR = previousStateDir;
  delete process.env.CAPTURE_ARGS;
  delete process.env.CAPTURE_INPUT;
  delete process.env.DRAFT_JSON;
  delete process.env.ATTEMPT_FILE;
});

describe('CodexGenerator', () => {
  it.each([
    ['ATX H1', '# Title'],
    ['ATX H2', '  ## Title'],
    ['Setext H1', 'Title\n==='],
    ['Setext H2', 'Title\n---'],
    ['HTML H1', '<h1>Title</h1>'],
    ['HTML H2', '<h2 class="title">Title</h2>'],
  ])('detects %s in record Markdown', (_label, markdown) => {
    expect(containsLevelOneOrTwoHeading(markdown)).toBe(true);
  });

  it('allows lower-level headings and standalone horizontal rules', () => {
    expect(containsLevelOneOrTwoHeading('### Detail\n\nContent\n\n---')).toBe(false);
  });

  it('rejects maintenance headings and untitled core code', () => {
    expect(devLogMarkdownIssue('### 问题索引与维护原则\n内容')).toBe(
      'contains a maintenance-only heading',
    );
    expect(devLogMarkdownIssue('#### 核心实现\n```ts\nconst value = true;\n```')).toBe(
      'contains core code without a meaningful level-five heading',
    );
    expect(devLogMarkdownIssue(
      '#### 核心实现\n##### 状态判断\n```ts\nconst value = true;\n```',
    )).toBeNull();
    expect(devLogMarkdownIssue(
      '#### 需求概览\n<table data-block-id="old"><tr><td>状态</td></tr></table>',
    )).toBe('contains stale remote block identifiers');
  });

  it('passes the prompt through stdin and the model through argv', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-generator-'));
    const executable = join(directory, 'fake-codex.sh');
    const argsPath = join(directory, 'args.txt');
    const inputPath = join(directory, 'input.txt');
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$@" > "$CAPTURE_ARGS"
cat > "$CAPTURE_INPUT"
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output-last-message' ]; then
    printf '# 2026-07-15\\n\\n## Today\\n\\nDone.\\n' > "$argument"
    break
  fi
  previous="$argument"
done
`);
    await chmod(executable, 0o755);
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    process.env.CAPTURE_ARGS = argsPath;
    process.env.CAPTURE_INPUT = inputPath;
    const config = createStarterConfig();
    const job = config.jobs['daily-report'];
    expect(job).toBeDefined();
    if (!job) return;
    const context: RunContext = {
      jobName: 'daily-report',
      job,
      date: '2026-07-15',
      timezone: 'Asia/Shanghai',
      dryRun: true,
      force: false,
      modelOverride: 'test-model',
    };
    const batch: ActivityBatch = {
      date: context.date,
      timezone: context.timezone,
      sourceCount: 1,
      filteredCount: 0,
      activities: [],
      dailyView: emptyDailyView(),
    };

    const result = await new CodexGenerator().generate(context, {
      type: 'codex', executable, model: null,
    }, batch);

    expect(result.kind).toBe('markdown');
    const args = await readFile(argsPath, 'utf8');
    const input = await readFile(inputPath, 'utf8');
    expect(args).toContain('--model\ntest-model');
    expect(args).not.toContain('WorkItem JSON');
    expect(input).toContain('WorkItem JSON');
  });

  it('validates a structured daily draft and renders Markdown locally', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-generator-daily-json-'));
    const executable = join(directory, 'fake-codex.sh');
    const argsPath = join(directory, 'args.txt');
    const draftPath = join(directory, 'draft.json');
    await writeFile(draftPath, `${JSON.stringify({
      headline: '今天主线是补齐接口字段并完成测试闭环',
      overview: '今天围绕接口字段实现推进，完成代码改动与测试验证，并形成可同步的结果说明，便于自己回看和 mentor 沟通。',
      today: [{
        workItemId: 'w1',
        relatedWorkItemIds: [],
        detailLevel: 'brief',
        title: '接口实现',
        background: '接口字段缺失导致下游无法消费完整数据。',
        progress: ['梳理字段契约并修改接口响应结构。'],
        keyDecision: '',
        result: '接口字段已落地，测试通过。',
        openQuestions: '',
        evidenceIds: ['e1'],
      }],
      deepDives: [],
      takeaways: [],
      diagrams: [],
      suggestions: [{
        workItemId: 'w1',
        priority: 'P1',
        text: '补充边界用例',
        completionCriteria: '异常字段路径均有测试覆盖。',
      }],
      agentCandidates: [],
    })}\n`, 'utf8');
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$@" > "$CAPTURE_ARGS"
cat >/dev/null
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output-last-message' ]; then
    cat "$DRAFT_JSON" > "$argument"
    break
  fi
  previous="$argument"
done
`);
    await chmod(executable, 0o755);
    process.env.DRAFT_JSON = draftPath;
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    process.env.CAPTURE_ARGS = argsPath;
    const config = createStarterConfig();
    const job = config.jobs['daily-report'];
    expect(job).toBeDefined();
    if (!job) return;
    const workItem = {
      id: 'w1', subjectKey: 'subject', repositoryKey: '/workspace', kind: 'feature' as const,
      status: 'completed' as const, title: '接口实现', goal: '实现接口字段', actions: ['修改 src/api.ts'],
      outcomes: ['测试通过'], decisions: [], changes: [], verifications: [], blockers: [],
      startedAt: '2026-07-16T01:00:00Z', endedAt: '2026-07-16T01:10:00Z', activeMinutes: 10,
      durationReliable: true, sessionIds: ['session'], evidenceIds: ['e1'], confidence: 'confirmed' as const,
    };
    const dailyView = {
      items: [workItem], longestWorkItemId: 'w1', longestReason: '可靠活跃时长', longestTiedIds: [],
      excludedUnreliableCount: 0, deepDiveCandidateIds: [], takeawayCandidateIds: [],
      presentationPlan: [{ workItemId: 'w1', detailLevel: 'brief' as const, reason: '轻量事项' }],
      visualPlan: [],
      quality: { coverage: 'high' as const, reasons: [] },
    };
    const result = await new CodexGenerator().generate({
      jobName: 'daily-report', job, date: '2026-07-16', timezone: config.timezone,
      dryRun: true, force: false,
    }, { type: 'codex', executable, model: null }, {
      date: '2026-07-16', timezone: config.timezone, sourceCount: 1, filteredCount: 0,
      activities: [], workItems: [workItem], dailyView,
    });
    expect(result.kind).toBe('markdown');
    if (result.kind === 'markdown') {
      expect(result.markdown).toContain('## 1. 今日工作');
      expect(result.markdown).toContain('接口字段已落地，测试通过');
      expect(result.markdown).not.toContain('```mermaid');
    }
    expect(await readFile(argsPath, 'utf8')).toContain('--output-schema');
  });

  it('does not publish a fallback daily report to Lark when Codex fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-generator-error-'));
    const executable = join(directory, 'fake-codex.sh');
    await writeFile(executable, '#!/bin/sh\ncat >/dev/null\nprintf "private prompt content" >&2\nexit 1\n');
    await chmod(executable, 0o755);
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    const config = createStarterConfig();
    const job = config.jobs['daily-report'];
    expect(job).toBeDefined();
    if (!job) return;
    const larkJob = {
      ...job,
      sinks: [
        ...job.sinks,
        {
          type: 'lark' as const,
          document: 'doc-token',
          mode: 'history-replace' as const,
          identity: 'user' as const,
          title: 'Codex 日报',
        },
      ],
    };
    const context: RunContext = {
      jobName: 'daily-report', job: larkJob, date: '2026-07-15', timezone: config.timezone,
      dryRun: false, force: false,
    };
    const batch: ActivityBatch = {
      date: context.date, timezone: context.timezone,
      sourceCount: 1, filteredCount: 0, activities: [], dailyView: emptyDailyView(),
    };

    await expect(new CodexGenerator().generate(context, {
      type: 'codex', executable, model: null,
    }, batch)).rejects.toThrow('已阻止回退稿写入飞书');
  });

  it('falls back when Codex exits successfully without writing the output file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-generator-empty-'));
    const executable = join(directory, 'fake-codex.sh');
    await writeFile(executable, '#!/bin/sh\ncat >/dev/null\nexit 0\n');
    await chmod(executable, 0o755);
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    const config = createStarterConfig();
    const job = config.jobs['daily-report'];
    expect(job).toBeDefined();
    if (!job) return;
    const context: RunContext = {
      jobName: 'daily-report', job, date: '2026-07-15', timezone: config.timezone,
      dryRun: true, force: false,
    };
    const batch: ActivityBatch = {
      date: context.date, timezone: context.timezone,
      sourceCount: 1, filteredCount: 0, activities: [], dailyView: emptyDailyView(),
    };

    const result = await new CodexGenerator().generate(context, {
      type: 'codex', executable, model: null,
    }, batch);

    expect(result.kind).toBe('markdown');
    if (result.kind !== 'markdown') return;
    expect(result.markdown).toContain('## 5. 下一步');
  });

  it('falls back when the configured daily-report executable does not exist', async () => {
    const config = createStarterConfig();
    const job = config.jobs['daily-report'];
    expect(job).toBeDefined();
    if (!job) return;
    const context: RunContext = {
      jobName: 'daily-report', job, date: '2026-07-15', timezone: config.timezone,
      dryRun: true, force: false,
    };
    const batch: ActivityBatch = {
      date: context.date, timezone: context.timezone,
      sourceCount: 1, filteredCount: 0, activities: [], dailyView: emptyDailyView(),
    };

    const result = await new CodexGenerator().generate(context, {
      type: 'codex', executable: '/definitely/missing/internflow-codex', model: null,
    }, batch);

    expect(result).toMatchObject({ kind: 'markdown' });
    if (result.kind === 'markdown') expect(result.markdown).toContain('## 5. 下一步');
  });

  it('uses gpt-5.6-sol for a daily report when no model is configured or overridden', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-generator-default-model-'));
    const executable = join(directory, 'fake-codex.sh');
    const argsPath = join(directory, 'args.txt');
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$@" > "$CAPTURE_ARGS"
cat >/dev/null
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output-last-message' ]; then
    printf '# 2026-07-15\\n\\n## 1. Today\\n\\nDone.\\n' > "$argument"
    break
  fi
  previous="$argument"
done
`);
    await chmod(executable, 0o755);
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    process.env.CAPTURE_ARGS = argsPath;
    const config = createStarterConfig();
    const job = config.jobs['daily-report'];
    expect(job).toBeDefined();
    if (!job) return;
    const context: RunContext = {
      jobName: 'daily-report', job, date: '2026-07-15', timezone: config.timezone,
      dryRun: true, force: false,
    };
    const batch: ActivityBatch = {
      date: context.date, timezone: context.timezone,
      sourceCount: 1, filteredCount: 0, activities: [], dailyView: emptyDailyView(),
    };

    await new CodexGenerator().generate(context, {
      type: 'codex', executable, model: null,
    }, batch);

    expect(await readFile(argsPath, 'utf8')).toContain('--model\ngpt-5.6-sol\n');
  });

  it('derives dev-log section and evidence from a locally resolved candidate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-generator-candidate-'));
    const executable = join(directory, 'fake-codex.sh');
    await writeFile(executable, `#!/bin/sh
cat >/dev/null
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output-last-message' ]; then
    printf '%s' '{"records":[{"candidateId":"candidate-1","targetRef":"h1","markdown":"##### 2026-07-16｜完成字段实现"}]}' > "$argument"
    break
  fi
  previous="$argument"
done
`);
    await chmod(executable, 0o755);
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    const config = createStarterConfig();
    const job = config.jobs['dev-log'];
    expect(job).toBeDefined();
    if (!job) return;
    const result = await new CodexGenerator().generate({
      jobName: 'dev-log', job, date: '2026-07-16', timezone: config.timezone,
      dryRun: true, force: true,
    }, { type: 'codex', executable, model: null }, {
      date: '2026-07-16', timezone: config.timezone, sourceCount: 1, filteredCount: 0, activities: [],
      resolvedDevLogCandidates: [{
        id: 'candidate-1', subjectKey: 'subject', section: 'requirement', operation: 'append',
        title: '接口字段实现', status: 'completed', facts: ['完成字段实现'], files: ['src/api.ts'], excerpts: [],
        verificationSummary: 'npm test：通过', evidenceIds: ['e1'], contentFingerprint: 'fingerprint',
        subjectHeading: 'REQ-001｜接口字段实现', allowedTargetRefs: ['h1'],
        writeTargets: [{
          ref: 'h1', section: 'requirement', operation: 'append', role: 'change-log',
          required: true, markdownPrefix: '##### 2026-07-16｜', bindSubject: true,
        }],
        routingAssessmentId: 'routing',
      }],
    }, { headings: [{ ref: 'h1', blockId: 'block', level: 3, text: '接口字段', section: 'requirement' }] });
    expect(result).toMatchObject({
      kind: 'records',
      records: [expect.objectContaining({
        section: 'requirement', evidenceIds: ['e1'], subjectKey: 'subject',
        subjectHeading: 'REQ-001｜接口字段实现', operation: 'append',
        contentFingerprint: 'fingerprint',
      })],
    });
  });

  it('retries a failed dev-log generation once and accepts the successful result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-generator-retry-'));
    const executable = join(directory, 'fake-codex.sh');
    const attemptFile = join(directory, 'attempts.txt');
    await writeFile(executable, `#!/bin/sh
attempt=0
if [ -f "$ATTEMPT_FILE" ]; then attempt=$(sed -n '1p' "$ATTEMPT_FILE"); fi
attempt=$((attempt + 1))
printf '%s' "$attempt" > "$ATTEMPT_FILE"
cat >/dev/null
if [ "$attempt" -eq 1 ]; then exit 1; fi
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output-last-message' ]; then
    printf '%s' '{"records":[{"candidateId":"candidate-1","targetRef":"h1","markdown":"##### 2026-07-16｜重试成功"}]}' > "$argument"
    break
  fi
  previous="$argument"
done
`);
    await chmod(executable, 0o755);
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    process.env.ATTEMPT_FILE = attemptFile;
    const config = createStarterConfig();
    const job = config.jobs['dev-log']!;

    const result = await new CodexGenerator().generate({
      jobName: 'dev-log', job, date: '2026-07-16', timezone: config.timezone,
      dryRun: true, force: true,
    }, { type: 'codex', executable, model: null }, {
      date: '2026-07-16', timezone: config.timezone, sourceCount: 1, filteredCount: 0, activities: [],
      resolvedDevLogCandidates: [{
        id: 'candidate-1', subjectKey: 'subject', section: 'requirement', operation: 'append',
        title: '接口字段实现', status: 'completed', facts: ['完成字段实现'], files: ['src/api.ts'],
        excerpts: [], verificationSummary: 'npm test：通过', evidenceIds: ['e1'],
        contentFingerprint: 'fingerprint', subjectHeading: 'REQ-001｜接口字段实现',
        allowedTargetRefs: ['h1'],
        writeTargets: [{
          ref: 'h1', section: 'requirement', operation: 'append', role: 'change-log',
          required: true, markdownPrefix: '##### 2026-07-16｜', bindSubject: true,
        }],
        routingAssessmentId: 'routing',
      }],
    }, {
      headings: [{ ref: 'h1', blockId: 'block', level: 3, text: '接口字段', section: 'requirement' }],
    });

    expect(result.kind).toBe('records');
    expect(await readFile(attemptFile, 'utf8')).toBe('2');
  });

  it('rejects a model response that omits a locally required write target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-generator-required-target-'));
    const executable = join(directory, 'fake-codex.sh');
    await writeFile(executable, `#!/bin/sh
cat >/dev/null
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output-last-message' ]; then
    printf '%s' '{"records":[{"candidateId":"candidate-1","targetRef":"changes","markdown":"##### 2026-07-16｜完成字段实现"}]}' > "$argument"
    break
  fi
  previous="$argument"
done
`);
    await chmod(executable, 0o755);
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    const config = createStarterConfig();
    const job = config.jobs['dev-log']!;

    await expect(new CodexGenerator().generate({
      jobName: 'dev-log', job, date: '2026-07-16', timezone: config.timezone,
      dryRun: true, force: true,
    }, { type: 'codex', executable, model: null }, {
      date: '2026-07-16', timezone: config.timezone, sourceCount: 1, filteredCount: 0, activities: [],
      resolvedDevLogCandidates: [{
        id: 'candidate-1', subjectKey: 'subject', section: 'requirement', operation: 'append',
        title: '接口字段实现', status: 'completed', facts: ['完成字段实现'], files: ['src/api.ts'],
        excerpts: [], verificationSummary: 'npm test：通过', evidenceIds: ['e1'],
        contentFingerprint: 'fingerprint', subjectHeading: 'REQ-001｜接口字段实现',
        allowedTargetRefs: ['changes', 'status'],
        writeTargets: [
          {
            ref: 'changes', section: 'requirement', operation: 'append', role: 'change-log',
            required: true, markdownPrefix: '##### 2026-07-16｜', bindSubject: true,
          },
          {
            ref: 'status', section: 'overview', operation: 'replace', role: 'overview-status',
            required: true, markdownPrefix: '### 1. 当前需求状态', bindSubject: false,
          },
        ],
        routingAssessmentId: 'routing',
      }],
    }, {
      headings: [
        { ref: 'changes', blockId: 'changes', level: 4, text: '变更记录', section: 'requirement' },
        { ref: 'status', blockId: 'status', level: 3, text: '1. 当前需求状态', section: 'overview' },
      ],
    })).rejects.toThrow('omitted required dev-log targets');
  });

  it('rejects an overview replacement that silently drops an existing requirement row', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-generator-overview-loss-'));
    const executable = join(directory, 'fake-codex.sh');
    await writeFile(executable, `#!/bin/sh
cat >/dev/null
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output-last-message' ]; then
    printf '%s' '{"records":[{"candidateId":"candidate-1","targetRef":"status","markdown":"### 1. 当前需求状态\\n| 编号 | 需求 |\\n| --- | --- |\\n| REQ-001 | 保留 |"}]}' > "$argument"
    break
  fi
  previous="$argument"
done
`);
    await chmod(executable, 0o755);
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    const config = createStarterConfig();
    const job = config.jobs['dev-log']!;
    const candidate = {
      id: 'candidate-1', subjectKey: 'subject', section: 'requirement' as const, operation: 'append' as const,
      title: '接口字段实现', status: 'completed' as const, facts: ['完成字段实现'], files: ['src/api.ts'],
      excerpts: [], verificationSummary: 'npm test：通过', evidenceIds: ['e1'],
      contentFingerprint: 'fingerprint', subjectHeading: 'REQ-001｜接口字段实现',
      allowedTargetRefs: ['status'],
      writeTargets: [{
        ref: 'status', section: 'overview' as const, operation: 'replace' as const, role: 'overview-status' as const,
        required: true, markdownPrefix: '### 1. 当前需求状态', bindSubject: false,
      }],
      routingAssessmentId: 'routing',
    };

    await expect(new CodexGenerator().generate({
      jobName: 'dev-log', job, date: '2026-07-16', timezone: config.timezone,
      dryRun: true, force: true,
    }, { type: 'codex', executable, model: null }, {
      date: '2026-07-16', timezone: config.timezone, sourceCount: 1, filteredCount: 0,
      activities: [], resolvedDevLogCandidates: [candidate],
    }, {
      markdown: '### 1. 当前需求状态\n| 编号 | 需求 |\n| --- | --- |\n| REQ-001 | A |\n| REQ-002 | B |',
      headings: [{ ref: 'status', blockId: 'status', level: 3, text: '1. 当前需求状态', section: 'overview' }],
    })).rejects.toThrow('drops existing overview rows: REQ-002');
  });

  it('restores unresolved overview todos that the model accidentally omits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-generator-overview-todos-'));
    const executable = join(directory, 'fake-codex.sh');
    await writeFile(executable, `#!/bin/sh
cat >/dev/null
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output-last-message' ]; then
    printf '%s' '{"records":[{"candidateId":"candidate-1","targetRef":"todos","markdown":"### 3. 待确认事项\\n- 继续确认 REQ-001 的发布状态。"}]}' > "$argument"
    break
  fi
  previous="$argument"
done
`);
    await chmod(executable, 0o755);
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    const config = createStarterConfig();
    const job = config.jobs['dev-log']!;
    const candidate = {
      id: 'candidate-1', subjectKey: 'subject', section: 'requirement' as const, operation: 'append' as const,
      title: '接口字段实现', status: 'completed' as const, facts: ['完成字段实现'], files: ['src/api.ts'],
      excerpts: [], verificationSummary: 'npm test：通过', evidenceIds: ['e1'],
      contentFingerprint: 'fingerprint', subjectHeading: 'REQ-001｜接口字段实现',
      allowedTargetRefs: ['todos'],
      writeTargets: [{
        ref: 'todos', section: 'overview' as const, operation: 'replace' as const, role: 'overview-todos' as const,
        required: true, markdownPrefix: '### 3. 待确认事项', bindSubject: false,
      }],
      routingAssessmentId: 'routing',
    };

    const result = await new CodexGenerator().generate({
      jobName: 'dev-log', job, date: '2026-07-16', timezone: config.timezone,
      dryRun: true, force: true,
    }, { type: 'codex', executable, model: null }, {
      date: '2026-07-16', timezone: config.timezone, sourceCount: 1, filteredCount: 0,
      activities: [], resolvedDevLogCandidates: [candidate],
    }, {
      markdown: '### 3. 待确认事项\n- 继续确认 REQ-001 的发布状态。\n- 确认 Aiden 是否作为 REQ-006 纳入档案。',
      headings: [{ ref: 'todos', blockId: 'todos', level: 3, text: '3. 待确认事项', section: 'overview' }],
    });

    expect(result.kind).toBe('records');
    if (result.kind !== 'records') return;
    expect(result.records[0]?.markdown).toContain('- 确认 Aiden 是否作为 REQ-006 纳入档案。');
  });
});
