import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { defaultConfigPath, expandHome } from './paths.js';

const daySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const jobIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    'Expected a stable job ID using 1-64 lowercase letters, numbers, dots, underscores, or hyphens',
  );

const scheduleSchema = z.strictObject({
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm'),
  days: z.array(daySchema).min(1),
});

const sourceSchema = z.strictObject({
  type: z.literal('codex'),
  sessionsDir: z.string().optional(),
  sessionIndex: z.string().optional(),
  includeAssistantMessages: z.boolean().optional(),
  includeToolOutput: z.boolean().optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

const generatorSchema = z.strictObject({
  type: z.literal('codex'),
  executable: z.string().optional(),
  model: z.string().nullable().default(null),
});

const markdownSinkSchema = z.strictObject({
  type: z.literal('markdown'),
  directory: z.string(),
  filename: z.string().default('{job}-{date}.md'),
});

const larkSinkSchema = z.strictObject({
  type: z.literal('lark'),
  document: z.string().min(1),
  executable: z.string().optional(),
  profile: z.string().optional(),
  mode: z.enum(['append', 'section-append']).default('append'),
});

const jobSchema = z.strictObject({
  enabled: z.boolean().default(true),
  template: z.enum(['daily-report', 'dev-log']),
  schedule: scheduleSchema,
  source: sourceSchema,
  generator: generatorSchema,
  sinks: z.array(z.discriminatedUnion('type', [markdownSinkSchema, larkSinkSchema])).min(1),
}).superRefine((job, context) => {
  const larkSinks = job.sinks.filter((sink) => sink.type === 'lark');
  if (job.template === 'dev-log' && job.enabled) {
    if (larkSinks.length !== 1 || larkSinks[0]?.mode !== 'section-append') {
      context.addIssue({
        code: 'custom',
        path: ['sinks'],
        message: 'An enabled dev-log job requires exactly one Lark section-append sink.',
      });
    }
  }
  if (job.template === 'daily-report' && larkSinks.some((sink) => sink.mode !== 'append')) {
    context.addIssue({
      code: 'custom',
      path: ['sinks'],
      message: 'A daily-report job only supports the non-destructive Lark append mode.',
    });
  }
});

export const internFlowConfigSchema = z.strictObject({
  version: z.literal(1),
  timezone: z.string().min(1).refine(isValidTimezone, 'Expected an IANA timezone').default('Asia/Shanghai'),
  jobs: z.record(jobIdSchema, jobSchema),
});

export type InternFlowConfig = z.infer<typeof internFlowConfigSchema>;
export type JobConfig = z.infer<typeof jobSchema>;
export type SourceConfig = z.infer<typeof sourceSchema>;
export type GeneratorConfig = z.infer<typeof generatorSchema>;
export type SinkConfig = z.infer<typeof markdownSinkSchema> | z.infer<typeof larkSinkSchema>;
export type ScheduleConfig = z.infer<typeof scheduleSchema>;
export type DayName = z.infer<typeof daySchema>;

export async function loadConfig(path = defaultConfigPath()): Promise<InternFlowConfig> {
  const resolved = expandHome(path);
  const source = await readFile(resolved, 'utf8');
  const result = internFlowConfigSchema.safeParse(parse(source));
  if (!result.success) {
    throw new Error(`Invalid config ${resolved}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export async function writeConfig(config: InternFlowConfig, path = defaultConfigPath()): Promise<void> {
  const resolved = expandHome(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, stringify(config, { indent: 2, lineWidth: 100 }), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export function createStarterConfig(): InternFlowConfig {
  return internFlowConfigSchema.parse({
    version: 1,
    timezone: 'Asia/Shanghai',
    jobs: {
      'daily-report': {
        enabled: true,
        template: 'daily-report',
        schedule: { time: '23:30', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
        source: { type: 'codex' },
        generator: { type: 'codex', model: null },
        sinks: [
          {
            type: 'markdown',
            directory: '~/.local/share/internflow/reports',
            filename: '{date}.md',
          },
        ],
      },
      'dev-log': {
        enabled: false,
        template: 'dev-log',
        schedule: { time: '23:45', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
        source: { type: 'codex' },
        generator: { type: 'codex', model: null },
        sinks: [
          {
            type: 'markdown',
            directory: '~/.local/share/internflow/dev-log',
            filename: '{date}.operations.json',
          },
        ],
      },
    },
  });
}
