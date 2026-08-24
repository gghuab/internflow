import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { GeneratorConfig } from '../../core/config.js';
import { stateDirectory } from '../../core/paths.js';
import { resolveExecutable, runCommand } from '../../core/process.js';
import type {
  ActivityBatch,
  GeneratorPlugin,
  OutputArtifact,
  RunContext,
  SinkSnapshot,
} from '../../core/contracts/index.js';
import {
  buildFallbackDailyReport,
  dailyDraftJsonSchema,
  dailyDraftSchema,
  dailyReportPrompt,
  renderDailyReport,
  validateDailyDraft,
} from '../../reports/daily/index.js';
import { devLogMarkdownSection, devLogPrompt } from '../../reports/dev-log/index.js';
import {
  buildFallbackPeriodReport,
  periodDraftJsonSchema,
  periodDraftSchema,
  periodReportPrompt,
  renderPeriodReport,
  validatePeriodDraft,
} from '../../reports/period/index.js';

const candidateRecordsResultSchema = z.strictObject({
  records: z.array(z.strictObject({
    candidateId: z.string().min(1),
    targetRef: z.string().min(1),
    markdown: z.string().min(1).max(50_000),
  })).max(48),
});

const candidateRecordsJsonSchema = {
  type: 'object', additionalProperties: false, required: ['records'],
  properties: {
    records: {
      type: 'array', maxItems: 48,
      items: {
        type: 'object', additionalProperties: false,
        required: ['candidateId', 'targetRef', 'markdown'],
        properties: {
          candidateId: { type: 'string', minLength: 1 },
          targetRef: { type: 'string', minLength: 1 },
          markdown: { type: 'string', minLength: 1, maxLength: 50_000 },
        },
      },
    },
  },
} as const;

export class CodexGenerator implements GeneratorPlugin {
  readonly name = 'codex' as const;

  async generate(
    context: RunContext,
    config: GeneratorConfig,
    batch: ActivityBatch,
    snapshot?: SinkSnapshot,
  ): Promise<OutputArtifact> {
    if (config.type !== 'codex') throw new Error('CodexGenerator received non-Codex config.');
    const executable = await resolveExecutable('codex', config.executable);
    if (!executable) {
      if (context.job.template === 'daily-report') {
        return dailyFallbackOrThrow(
          context,
          batch,
          new Error('Codex CLI was not found. Run `internflow doctor`.'),
        );
      }
      if (isPeriodReport(context.job.template)) {
        const fallback = buildFallbackPeriodReport(batch);
        return { kind: 'markdown', markdown: fallback, rawMarkdown: fallback };
      }
      throw new Error('Codex CLI was not found. Run `internflow doctor`.');
    }

    const runDir = join(stateDirectory(), 'runs', context.jobName, context.date);
    await mkdir(runDir, { recursive: true });
    const outputPath = join(
      runDir,
      context.job.template === 'dev-log' ? 'records.json' : 'report-draft.json',
    );
    const schemaPath = join(runDir, 'records.schema.json');
    const prompt = context.job.template === 'dev-log'
      ? devLogPrompt(batch, snapshot || {})
      : isPeriodReport(context.job.template)
        ? periodReportPrompt(batch)
        : dailyReportPrompt(batch);
    const args = [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--output-last-message',
      outputPath,
    ];
    const schema = context.job.template === 'dev-log'
      ? candidateRecordsJsonSchema
      : isPeriodReport(context.job.template)
        ? periodDraftJsonSchema
        : dailyDraftJsonSchema;
    await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
    args.push('--output-schema', schemaPath);
    const model = context.modelOverride
      || config.model
      || (context.job.template !== 'dev-log' ? 'gpt-5.6-sol' : null);
    if (model) args.push('--model', model);
    args.push('-');

    let output = '';
    // Prompt 只走 stdin，避免会话和文档正文出现在进程参数列表中。
    try {
      const maxAttempts = context.job.template === 'dev-log' ? 2 : 1;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        // 每次重试前清理旧结果，避免把半成品当成新输出。
        await rm(outputPath, { force: true });
        try {
          await runCommand(executable, args, {
            cwd: runDir,
            input: prompt,
            timeoutMs: 15 * 60 * 1000,
            sensitiveOutput: true,
          });
          output = (await readFile(outputPath, 'utf8')).trim();
          if (!output) throw new Error('Codex did not write a report.');
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
    } catch (error) {
      if (context.job.template === 'dev-log') throw error;
      if (context.job.template === 'daily-report') {
        return dailyFallbackOrThrow(context, batch, error);
      }
      // 模型失败时仍由本地事实渲染器输出完整报告，不丢工作项。
      const fallback = buildFallbackPeriodReport(batch);
      await writeFile(outputPath, fallback, { encoding: 'utf8', mode: 0o600 });
      return { kind: 'markdown', markdown: fallback, rawMarkdown: fallback };
    }

    if (context.job.template === 'daily-report') {
      if (!batch.dailyView) throw new Error('Daily report requires a WorkItem projection.');
      try {
        const parsed = dailyDraftSchema.safeParse(parseJson(output));
        if (!parsed.success) throw new Error(`Invalid Codex daily draft:\n${z.prettifyError(parsed.error)}`);
        const draft = validateDailyDraft(batch.dailyView, parsed.data);
        const markdown = renderDailyReport(batch, batch.dailyView, draft);
        return { kind: 'markdown', markdown, rawMarkdown: markdown };
      } catch (error) {
        return dailyFallbackOrThrow(context, batch, error);
      }
    }

    if (isPeriodReport(context.job.template)) {
      try {
        if (!batch.periodView) throw new Error('Period report requires a PeriodReportView.');
        const parsed = periodDraftSchema.safeParse(parseJson(output));
        if (!parsed.success) throw new Error(`Invalid Codex period draft:\n${z.prettifyError(parsed.error)}`);
        const draft = validatePeriodDraft(batch.periodView, parsed.data);
        const markdown = renderPeriodReport(batch, draft);
        return { kind: 'markdown', markdown, rawMarkdown: markdown };
      } catch {
        const fallback = buildFallbackPeriodReport(batch);
        return { kind: 'markdown', markdown: fallback, rawMarkdown: fallback };
      }
    }

    const value = parseJson(output);
    const result = candidateRecordsResultSchema.safeParse(value);
    if (!result.success) throw new Error(`Invalid Codex candidate records output:\n${z.prettifyError(result.error)}`);
    return {
      kind: 'records',
      records: validateCandidateRecords(result.data.records, batch, snapshot || {}),
    };
  }
}

function dailyFallbackOrThrow(
  context: RunContext,
  batch: ActivityBatch,
  cause: unknown,
): OutputArtifact {
  const writesToLark = context.job.sinks.some((sink) => sink.type === 'lark');
  // 正式同步不允许把对话拼接的回退稿冒充 AI 日报。
  if (!context.dryRun && writesToLark) {
    throw new Error(
      'Codex 日报生成失败，已阻止回退稿写入飞书。请恢复网络后重试。',
      { cause },
    );
  }
  const fallback = buildFallbackDailyReport(batch);
  return { kind: 'markdown', markdown: fallback, rawMarkdown: fallback };
}

function isPeriodReport(template: RunContext['job']['template']): boolean {
  return template === 'weekly-report' || template === 'monthly-report';
}

function validateCandidateRecords(
  records: z.infer<typeof candidateRecordsResultSchema>['records'],
  batch: ActivityBatch,
  snapshot: SinkSnapshot,
): Extract<OutputArtifact, { kind: 'records' }>['records'] {
  const candidates = new Map(
    (batch.resolvedDevLogCandidates || []).map((candidate) => [candidate.id, candidate]),
  );
  const headings = new Map((snapshot.headings || []).map((heading) => [heading.ref, heading]));
  const seen = new Set<string>();
  const planOrder = new Map(
    (batch.resolvedDevLogCandidates || []).flatMap((candidate) => (
      candidate.writeTargets.map((target) => `${candidate.id}:${target.ref}`)
    )).map((key, index) => [key, index]),
  );
  const mapped = records.map((record, index) => {
    const candidate = candidates.get(record.candidateId);
    const key = `${record.candidateId}:${record.targetRef}`;
    if (!candidate || seen.has(key)) {
      throw new Error(`Record ${index + 1} cites an unknown or repeated candidate target.`);
    }
    seen.add(key);
    const target = candidate.writeTargets.find((item) => item.ref === record.targetRef);
    if (!target || !candidate.allowedTargetRefs.includes(record.targetRef)) {
      throw new Error(`Record ${index + 1} targets a ref not allowed by candidate ${candidate.id}.`);
    }
    const heading = headings.get(record.targetRef);
    if (!heading || heading.section !== target.section) {
      throw new Error(`Record ${index + 1} targets an unknown or unclassified heading ref.`);
    }
    const relatedCandidates = target.section === 'overview'
      ? [...candidates.values()]
      : [...candidates.values()].filter((item) => item.subjectHeading === candidate.subjectHeading);
    const currentMarkdown = devLogMarkdownSection(snapshot, target.ref);
    const relatedFacts = relatedCandidates.flatMap((item) => [
      ...item.facts,
      ...(item.operation === 'create' ? [`${item.subjectHeading} 已确认纳入档案`] : []),
    ]);
    const markdown = target.role === 'overview-todos' && target.operation === 'replace'
      ? mergeUnresolvedOverviewTodos(record.markdown, currentMarkdown, relatedFacts)
      : record.markdown;
    if (containsLevelOneOrTwoHeading(markdown)) {
      throw new Error(`Record ${index + 1} may not add level-one or level-two headings.`);
    }
    const structureIssue = devLogMarkdownIssue(markdown);
    if (structureIssue) throw new Error(`Record ${index + 1} ${structureIssue}.`);
    assertPlannedMarkdown(markdown, target.markdownPrefix, target.operation, index);
    assertReplacementPreservesCurrent(
      markdown,
      target.role,
      target.operation,
      currentMarkdown,
      relatedFacts,
      index,
    );
    return {
      section: target.section,
      targetRef: record.targetRef,
      markdown: `${markdown.trim()}\n`,
      operation: target.operation,
      role: target.role,
      evidenceIds: [...new Set(relatedCandidates.flatMap((item) => item.evidenceIds))],
      candidateId: candidate.id,
      candidateIds: relatedCandidates.map((item) => item.id),
      ...(target.bindSubject ? {
        subjectKey: candidate.subjectKey,
        subjectHeading: candidate.subjectHeading,
        bindSubject: true,
        contentFingerprint: candidate.contentFingerprint,
      } : { bindSubject: false }),
    };
  });
  const missing = [...candidates.values()].flatMap((candidate) => (
    candidate.writeTargets
      .filter((target) => target.required && !seen.has(`${candidate.id}:${target.ref}`))
      .map((target) => `${candidate.id}:${target.role}`)
  ));
  if (missing.length) {
    throw new Error(`Codex omitted required dev-log targets: ${missing.join(', ')}.`);
  }
  const insertedHeadings = new Set<string>();
  for (const record of mapped.filter((item) => item.operation === 'append' || item.operation === 'create')) {
    const heading = record.markdown.match(/^(#{3,6})\s+(.+)$/m)?.[0].replace(/\s+/g, ' ').toLowerCase();
    if (!heading) continue;
    const key = `${record.targetRef}:${heading}`;
    if (insertedHeadings.has(key)) {
      throw new Error(`Codex generated duplicate inserted headings for target ${record.targetRef}.`);
    }
    insertedHeadings.add(key);
  }
  return mapped.sort((left, right) => {
    const leftOverview = left.section === 'overview' ? 1 : 0;
    const rightOverview = right.section === 'overview' ? 1 : 0;
    if (leftOverview !== rightOverview) return leftOverview - rightOverview;
    const leftKey = `${left.candidateId || ''}:${left.targetRef}`;
    const rightKey = `${right.candidateId || ''}:${right.targetRef}`;
    return (planOrder.get(leftKey) ?? Number.MAX_SAFE_INTEGER)
      - (planOrder.get(rightKey) ?? Number.MAX_SAFE_INTEGER);
  });
}

function mergeUnresolvedOverviewTodos(
  markdown: string,
  current: string,
  facts: string[],
): string {
  if (!current) return markdown;
  const oldTodos = current.match(/^\s*-\s+.+$/gm) || [];
  const newTodos = markdown.match(/^\s*-\s+.+$/gm) || [];
  const closureFacts = facts.filter((fact) => /已确认|已解决|已关闭|无需继续|已取消|已发布|已合入/.test(fact));
  const missing = oldTodos.filter((todo) => {
    const anchors = todoAnchors(todo);
    if (!anchors.length) {
      return !newTodos.some((item) => item.replace(/\s+/g, '') === todo.replace(/\s+/g, ''));
    }
    return anchors.some((anchor) => (
      !newTodos.some((item) => item.toLowerCase().includes(anchor))
      && !closureFacts.some((fact) => fact.toLowerCase().includes(anchor))
    ));
  });
  if (!missing.length) return markdown;
  return `${markdown.trimEnd()}\n${missing.join('\n')}`;
}

function assertReplacementPreservesCurrent(
  markdown: string,
  role: string,
  operation: string,
  current: string,
  facts: string[],
  index: number,
): void {
  if (operation !== 'replace' || !current) return;
  if (role === 'overview-status') {
    const oldIds = new Set(current.match(/\bREQ-\d+\b/g) || []);
    const newIds = new Set(markdown.match(/\bREQ-\d+\b/g) || []);
    const missing = [...oldIds].filter((id) => !newIds.has(id));
    if (missing.length) {
      throw new Error(`Record ${index + 1} drops existing overview rows: ${missing.join(', ')}.`);
    }
  }
  if (role === 'requirement-overview') {
    const labels = ['当前状态', '最近更新', '涉及仓库', '当前分支', '当前结论', '交付证据', '待处理事项'];
    const missing = labels.filter((label) => current.includes(label) && !markdown.includes(label));
    if (missing.length) {
      throw new Error(`Record ${index + 1} drops requirement overview fields: ${missing.join(', ')}.`);
    }
  }
  if (role === 'overview-todos') {
    const oldTodos = current.match(/^\s*-\s+.+$/gm) || [];
    const newTodos = markdown.match(/^\s*-\s+.+$/gm) || [];
    const closureFacts = facts.filter((fact) => /已确认|已解决|已关闭|无需继续|已取消|已发布|已合入/.test(fact));
    const missing = oldTodos.filter((todo) => {
      const anchors = todoAnchors(todo);
      if (!anchors.length) return newTodos.length < oldTodos.length;
      return anchors.some((anchor) => (
        !newTodos.some((item) => item.toLowerCase().includes(anchor))
        && !closureFacts.some((fact) => fact.toLowerCase().includes(anchor))
      ));
    });
    if (missing.length) {
      throw new Error(`Record ${index + 1} drops unresolved overview todos without closure evidence.`);
    }
  }
}

function todoAnchors(todo: string): string[] {
  const ids = todo.match(/\b(?:REQ|ISSUE)-\d+\b/gi) || [];
  const words = todo.match(/\b[A-Za-z][A-Za-z0-9_-]{2,}\b/g) || [];
  return [...new Set((ids.length ? ids : words).map((value) => value.toLowerCase()))];
}

function assertPlannedMarkdown(
  markdown: string,
  prefix: string,
  operation: 'create' | 'append' | 'replace',
  index: number,
): void {
  const normalized = markdown.replace(/\r\n?/g, '\n').trim();
  const actualLines = normalized.split('\n');
  const expectedLines = prefix.split('\n');
  for (const [lineIndex, expected] of expectedLines.entries()) {
    const actual = actualLines[lineIndex] || '';
    const openEnded = expected === '##### ' || expected.endsWith('｜');
    if (openEnded ? !actual.startsWith(expected) : actual !== expected) {
      throw new Error(`Record ${index + 1} does not start with its locally planned heading.`);
    }
  }
  if (operation !== 'replace' && operation !== 'create') return;
  const headings = [...normalized.matchAll(/^(#{3,6})\s+(.+)$/gm)];
  const firstLevel = headings[0]?.[1]?.length;
  if (!firstLevel) throw new Error(`Record ${index + 1} must start with a heading.`);
  if (headings.slice(1).some((heading) => (heading[1]?.length || 0) <= firstLevel)) {
    throw new Error(`Record ${index + 1} contains a sibling section outside its planned target.`);
  }
}

export function containsLevelOneOrTwoHeading(markdown: string): boolean {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const atxHeading = /^[ \t]{0,3}#{1,2}(?:[ \t]+|$)/m;
  const setextHeading = /(?:^|\n)[^\n]*\S[^\n]*\n[ \t]{0,3}(?:=+|-+)[ \t]*(?=\n|$)/;
  const htmlHeading = /<\/?h[12]\b/i;
  return atxHeading.test(normalized)
    || setextHeading.test(normalized)
    || htmlHeading.test(normalized);
}

export function devLogMarkdownIssue(markdown: string): string | null {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  if (/^#{3,6}\s+.*(?:问题索引与维护原则|常见问题类型|修复原则|记录规则|维护规则|后续增量|迁移自原文|状态纠正).*$/m.test(normalized)) {
    return 'contains a maintenance-only heading';
  }
  const prose = normalized.replace(/```[\s\S]*?```/g, '');
  if (/data-block-id\s*=|<[a-z][^>]*\sid\s*=/i.test(prose)) {
    return 'contains stale remote block identifiers';
  }
  const sections = [...normalized.matchAll(/^####\s+(.+)$/gm)];
  for (const [index, section] of sections.entries()) {
    if (section[1]?.trim() !== '核心实现') continue;
    const start = (section.index || 0) + section[0].length;
    const end = sections[index + 1]?.index ?? normalized.length;
    const body = normalized.slice(start, end);
    if (/```/.test(body) && !/^#####\s+\S/m.test(body)) {
      return 'contains core code without a meaningful level-five heading';
    }
  }
  return null;
}

function parseJson(output: string): unknown {
  const normalized = output
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new Error(`Codex returned invalid JSON: ${String(error)}`);
  }
}
