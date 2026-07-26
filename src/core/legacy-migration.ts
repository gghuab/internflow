import { existsSync } from 'node:fs';
import { chmod, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import {
  internFlowConfigSchema,
  writeConfig,
  type InternFlowConfig,
} from './config.js';
import { defaultConfigPath, expandHome } from './paths.js';

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const documentSchema = z.string().trim().min(1, 'Expected a non-empty Lark document URL or token');

const legacyDailySchema = z.object({
  feishuDoc: documentSchema,
});

const legacyDevSchema = z.object({
  feishuDoc: documentSchema,
  generator: z.object({
    provider: z.preprocess(
      (value) => value || 'codex',
      z.literal('codex', { error: 'Only the codex generator can be migrated' }),
    ),
    model: z.preprocess(
      (value) => value || null,
      z.string().trim().min(1).nullable(),
    ),
  }).optional(),
  skipDates: z.array(localDateSchema).default([]),
});

export interface LegacyMigrationOptions {
  dailyConfigPath?: string;
  devConfigPath?: string;
  targetPath?: string;
  apply?: boolean;
  force?: boolean;
}

export interface LegacyMigrationResult {
  config: InternFlowConfig;
  targetPath: string;
  applied: boolean;
}

export function defaultLegacyConfigPaths(): { daily: string; dev: string } {
  const root = join(homedir(), '.codex', 'daily-report');
  return {
    daily: join(root, 'config.json'),
    dev: join(root, 'dev-doc-sync', 'config.json'),
  };
}

export async function migrateLegacyConfig(
  options: LegacyMigrationOptions = {},
): Promise<LegacyMigrationResult> {
  if (options.force && !options.apply) {
    throw new Error('--force is only valid together with --apply.');
  }

  const defaults = defaultLegacyConfigPaths();
  const dailyPath = expandHome(options.dailyConfigPath || defaults.daily);
  const devPath = expandHome(options.devConfigPath || defaults.dev);
  const targetPath = expandHome(options.targetPath || defaultConfigPath());
  const config = await createConfigFromLegacy(dailyPath, devPath);

  // 默认路径只做预览。迁移不会调用 scheduler，因此不会触碰现有 launchd 任务。
  if (!options.apply) return { config, targetPath, applied: false };
  if (existsSync(targetPath) && !options.force) {
    throw new Error(`Config already exists: ${targetPath}. Use --apply --force to replace it.`);
  }

  await writeConfig(config, targetPath);
  await chmod(targetPath, 0o600);
  return { config, targetPath, applied: true };
}

export function formatLegacyMigrationPreview(config: InternFlowConfig): string {
  const preview = structuredClone(config);
  for (const job of Object.values(preview.jobs)) {
    for (const sink of job.sinks) {
      if (sink.type === 'lark') sink.document = '<redacted legacy Lark document>';
    }
  }
  return stringify(preview, { indent: 2, lineWidth: 100 });
}

async function createConfigFromLegacy(
  dailyPath: string,
  devPath: string,
): Promise<InternFlowConfig> {
  const daily = await readLegacyJson(dailyPath, 'daily report', legacyDailySchema);
  const dev = await readLegacyJson(devPath, 'dev document sync', legacyDevSchema);
  const devModel = dev.generator?.model ?? null;

  return internFlowConfigSchema.parse({
    version: 1,
    timezone: 'Asia/Shanghai',
    artifacts: {
      dailyDirectory: '~/.codex/daily-report',
      devLogDirectory: '~/.codex/daily-report/dev-doc-sync',
    },
    jobs: {
      'daily-report': {
        enabled: true,
        template: 'daily-report',
        schedule: { time: '23:30', days: ['mon', 'tue', 'wed', 'thu', 'fri'], dateOffsetDays: 0 },
        skipDates: [],
        source: { type: 'codex' },
        generator: { type: 'codex', model: 'gpt-5.6-sol' },
        sinks: [
          {
            type: 'markdown',
            // 沿用旧报告目录，history-replace 才能保留旧脚本已经生成的全部日报。
            directory: '~/.codex/daily-report/reports',
            filename: '{date}.md',
            archive: true,
          },
          {
            type: 'lark',
            document: daily.feishuDoc,
            identity: 'user',
            mode: 'history-replace',
            title: 'Codex 日报',
          },
        ],
      },
      'dev-log': {
        enabled: true,
        template: 'dev-log',
        schedule: { time: '23:45', days: ['mon', 'tue', 'wed', 'thu', 'fri'], dateOffsetDays: 0 },
        skipDates: dev.skipDates,
        source: { type: 'codex' },
        generator: { type: 'codex', model: devModel },
        sinks: [
          {
            type: 'lark',
            document: dev.feishuDoc,
            identity: 'user',
            reader: 'larkparser',
            mode: 'section-append',
          },
        ],
      },
    },
  });
}

async function readLegacyJson<T>(
  path: string,
  label: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`Legacy ${label} config not found: ${path}`);
    }
    throw new Error(`Could not read legacy ${label} config: ${path}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`Legacy ${label} config is not valid JSON: ${path}`);
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid legacy ${label} config (${path}): ${issues}`);
  }
  return result.data;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
