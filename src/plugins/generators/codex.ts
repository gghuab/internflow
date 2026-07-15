import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
} from '../../core/types.js';
import { dailyReportPrompt } from '../../templates/daily-report.js';
import { devLogPrompt } from '../../templates/dev-log.js';

const recordsResultSchema = z.strictObject({
  records: z.array(z.strictObject({
    section: z.enum(['requirement', 'bugfix', 'insight']),
    targetRef: z.string().min(1),
    markdown: z.string().min(1).max(20_000),
  })).max(12),
});

const recordsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['records'],
  properties: {
    records: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'targetRef', 'markdown'],
        properties: {
          section: { type: 'string', enum: ['requirement', 'bugfix', 'insight'] },
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
    if (!executable) throw new Error('Codex CLI was not found. Run `internflow doctor`.');

    const runDir = join(stateDirectory(), 'runs', context.jobName, context.date);
    await mkdir(runDir, { recursive: true });
    const outputPath = join(runDir, context.job.template === 'dev-log' ? 'records.json' : 'report.md');
    const schemaPath = join(runDir, 'records.schema.json');
    const prompt = context.job.template === 'dev-log'
      ? devLogPrompt(batch, snapshot || {})
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
    if (context.job.template === 'dev-log') {
      await writeFile(schemaPath, `${JSON.stringify(recordsJsonSchema, null, 2)}\n`, 'utf8');
      args.push('--output-schema', schemaPath);
    }
    const model = context.modelOverride || config.model;
    if (model) args.push('--model', model);
    args.push('-');

    // Prompt 只走 stdin，避免会话和文档正文出现在进程参数列表中。
    await runCommand(executable, args, {
      cwd: runDir,
      input: prompt,
      timeoutMs: 15 * 60 * 1000,
      sensitiveOutput: true,
    });

    const output = (await readFile(outputPath, 'utf8')).trim();
    if (context.job.template === 'daily-report') {
      if (!output.startsWith(`# ${context.date}`)) {
        throw new Error(`Codex output must start with "# ${context.date}".`);
      }
      return { kind: 'markdown', markdown: `${output}\n` };
    }

    const value = parseJson(output);
    const result = recordsResultSchema.safeParse(value);
    if (!result.success) throw new Error(`Invalid Codex records output:\n${z.prettifyError(result.error)}`);
    return {
      kind: 'records',
      records: validateRecordTargets(result.data.records, snapshot || {}),
    };
  }
}

function validateRecordTargets(
  records: z.infer<typeof recordsResultSchema>['records'],
  snapshot: SinkSnapshot,
): z.infer<typeof recordsResultSchema>['records'] {
  const headings = new Map((snapshot.headings || []).map((heading) => [heading.ref, heading]));
  return records.map((record, index) => {
    const heading = headings.get(record.targetRef);
    if (!heading || heading.section !== record.section) {
      throw new Error(`Record ${index + 1} targets an unknown or mismatched heading ref.`);
    }
    if (containsLevelOneOrTwoHeading(record.markdown)) {
      throw new Error(`Record ${index + 1} may not add level-one or level-two headings.`);
    }
    return { ...record, markdown: `${record.markdown.trim()}\n` };
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
