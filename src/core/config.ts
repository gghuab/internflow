import { chmod, readFile, writeFile, mkdir } from 'node:fs/promises';
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
  dateOffsetDays: z.number().int().min(-1).max(0).default(0),
  runOn: z.enum(['scheduled-day', 'last-workday']).optional(),
});

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const artifactsSchema = z.strictObject({
  dailyDirectory: z.string().min(1).optional(),
  devLogDirectory: z.string().min(1).optional(),
});

const webSchema = z.strictObject({
  // Web token 是唯一允许落入配置的凭证；配置文件必须保持 0600。
  authToken: z.string()
    .min(32, 'Expected a Web token with at least 32 characters')
    .regex(/^[\x21-\x7e]+$/, 'Expected a printable ASCII Web token without spaces')
    .optional(),
});

const sourceSchema = z.strictObject({
  type: z.literal('codex'),
  // 旧配置中的 precise 仍可读取，但运行时已经只有一条精准采集管线。
  captureMode: z.literal('precise').optional(),
  dayEndTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm').optional(),
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
  archive: z.boolean().default(false),
});

const larkSinkSchema = z.strictObject({
  type: z.literal('lark'),
  document: z.string().min(1),
  executable: z.string().optional(),
  reader: z.enum(['lark-cli', 'larkparser']).default('lark-cli'),
  parserExecutable: z.string().optional(),
  profile: z.string().optional(),
  identity: z.enum(['user', 'bot']).default('user'),
  mode: z.enum(['append', 'section-append', 'history-replace']).default('append'),
  title: z.string().optional(),
});

const jobSchema = z.strictObject({
  enabled: z.boolean().default(true),
  template: z.enum(['daily-report', 'weekly-report', 'monthly-report', 'dev-log']),
  schedule: scheduleSchema,
  skipDates: z.array(localDateSchema).default([]),
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
  if (
    ['daily-report', 'weekly-report', 'monthly-report'].includes(job.template)
    && larkSinks.some((sink) => !['append', 'history-replace'].includes(sink.mode))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['sinks'],
      message: 'A report job only supports append or history-replace Lark mode.',
    });
  }
});

export const internFlowConfigSchema = z.strictObject({
  version: z.literal(1),
  timezone: z.string().min(1).refine(isValidTimezone, 'Expected an IANA timezone').default('Asia/Shanghai'),
  artifacts: artifactsSchema.optional(),
  web: webSchema.optional(),
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
  // writeFile 的 mode 不会收紧已存在文件的权限。
  await chmod(resolved, 0o600);
}

export function createStarterConfig(): InternFlowConfig {
  return internFlowConfigSchema.parse({
    version: 1,
    timezone: 'Asia/Shanghai',
    jobs: {
      'daily-report': {
        enabled: true,
        template: 'daily-report',
        schedule: { time: '23:30', days: ['mon', 'tue', 'wed', 'thu', 'fri'], dateOffsetDays: 0 },
        skipDates: [],
        source: { type: 'codex', dayEndTime: '23:30' },
        generator: { type: 'codex', model: 'gpt-5.6-sol' },
        sinks: [
          {
            type: 'markdown',
            directory: '~/.local/share/internflow/reports',
            filename: '{date}.md',
            archive: true,
          },
        ],
      },
      'dev-log': {
        enabled: false,
        template: 'dev-log',
        schedule: { time: '23:45', days: ['mon', 'tue', 'wed', 'thu', 'fri'], dateOffsetDays: 0 },
        skipDates: [],
        source: { type: 'codex', dayEndTime: '23:30' },
        generator: { type: 'codex', model: null },
        sinks: [
          {
            type: 'markdown',
            directory: '~/.local/share/internflow/dev-log',
            filename: '{date}.operations.json',
            archive: false,
          },
        ],
      },
    },
  });
}
