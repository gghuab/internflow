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
import { devLogPrompt } from '../../reports/dev-log/index.js';
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
    markdown: z.string().min(1).max(20_000),
  })).max(12),
});

const candidateRecordsJsonSchema = {
  type: 'object', additionalProperties: false, required: ['records'],
  properties: {
    records: {
      type: 'array', maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        required: ['candidateId', 'targetRef', 'markdown'],
        properties: {
          candidateId: { type: 'string', minLength: 1 },
          targetRef: { type: 'string', minLength: 1 },
          markdown: { type: 'string', minLength: 1, maxLength: 20_000 },
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
    const executable = await resolveExecutable('codex', config.executable);
    if (!executable) {
      if (context.job.template === 'daily-report') {
        const fallback = buildFallbackDailyReport(batch);
        return { kind: 'markdown', markdown: fallback, rawMarkdown: fallback };
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
    await rm(outputPath, { force: true });

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

    let output: string;
    // Prompt 只走 stdin，避免会话和文档正文出现在进程参数列表中。
    try {
      await runCommand(executable, args, {
        cwd: runDir,
        input: prompt,
        timeoutMs: 15 * 60 * 1000,
        sensitiveOutput: true,
      });
      output = (await readFile(outputPath, 'utf8')).trim();
      if (!output) throw new Error('Codex did not write a report.');
    } catch (error) {
      if (context.job.template === 'dev-log') throw error;
      // 模型失败时仍由本地事实渲染器输出完整报告，不丢工作项。
      const fallback = isPeriodReport(context.job.template)
        ? buildFallbackPeriodReport(batch)
        : buildFallbackDailyReport(batch);
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
      } catch {
        const fallback = buildFallbackDailyReport(batch);
        return { kind: 'markdown', markdown: fallback, rawMarkdown: fallback };
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
  return records.map((record, index) => {
    const candidate = candidates.get(record.candidateId);
    if (!candidate || seen.has(record.candidateId)) {
      throw new Error(`Record ${index + 1} cites an unknown or repeated candidate id.`);
    }
    seen.add(record.candidateId);
    if (!candidate.allowedTargetRefs.includes(record.targetRef)) {
      throw new Error(`Record ${index + 1} targets a ref not allowed by candidate ${candidate.id}.`);
    }
    const heading = headings.get(record.targetRef);
    if (!heading?.section) {
      throw new Error(`Record ${index + 1} targets an unknown or unclassified heading ref.`);
    }
    if (containsLevelOneOrTwoHeading(record.markdown)) {
      throw new Error(`Record ${index + 1} may not add level-one or level-two headings.`);
    }
    return {
      section: heading.section,
      targetRef: record.targetRef,
      markdown: `${record.markdown.trim()}\n`,
      evidenceIds: candidate.evidenceIds,
      candidateId: candidate.id,
      subjectKey: candidate.subjectKey,
      contentFingerprint: candidate.contentFingerprint,
    };
  });
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
