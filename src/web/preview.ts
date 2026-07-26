import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createStarterConfig,
  loadConfig,
  type InternFlowConfig,
  type JobConfig,
} from '../core/config.js';
import { defaultConfigPath, expandHome } from '../core/paths.js';
import { runJob } from '../core/runtime/runner.js';
import { CodexSource } from '../sessions/codex/index.js';
import type { Activity, ActivityBatch, RunContext } from '../core/contracts/index.js';
import type { SinkConfig } from '../core/config.js';
import { projectWorkday } from '../workflows/workday/index.js';

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  gitBranch: string;
  startedAt: string;
  endedAt: string;
  activeMinutes: number | null;
  userMessageCount: number;
  commandCount: number;
  changedFileCount: number;
}

export interface DailyReportPreviewResult {
  ok: boolean;
  date: string;
  timezone: string;
  sourceCount: number;
  activityCount: number;
  filteredCount: number;
  activities: SessionSummary[];
  markdown: string | null;
  skipped: boolean;
  reason?: string;
  error?: string;
  generatedAt: string;
}

export interface DailyReportStatus {
  ok: boolean;
  date: string;
  timezone: string;
  sessionsDir: string;
  sessionsDirExists: boolean;
  sourceCount: number;
  activityCount: number;
  filteredCount: number;
  activities: SessionSummary[];
  error?: string;
}

export interface DevLogRecordView {
  section: 'requirement' | 'bugfix' | 'insight';
  sectionLabel: string;
  targetHeading: string;
  markdown: string;
  evidenceCount: number;
}

export interface DevLogPreviewResult {
  ok: boolean;
  date: string;
  timezone: string;
  sourceCount: number;
  activityCount: number;
  /** 拉到真实飞书 outline 为 true；未配置 lark section-append sink 时用虚拟三章节，为 false。 */
  usedLarkOutline: boolean;
  records: DevLogRecordView[];
  skipped: boolean;
  reason?: string;
  error?: string;
  generatedAt: string;
}

const DEV_LOG_SECTION_LABELS: Record<DevLogRecordView['section'], string> = {
  requirement: '一、需求开发档案',
  bugfix: '二、问题定位与修复记录',
  insight: '三、工程方法与知识沉淀',
};

function localDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

async function loadOrStarterConfig(configPath?: string): Promise<InternFlowConfig> {
  const path = expandHome(configPath || defaultConfigPath());
  if (!existsSync(path)) return createStarterConfig();
  return loadConfig(path);
}

function resolveDailyReportJob(config: InternFlowConfig): { jobName: string; job: JobConfig } {
  const preferred = config.jobs['daily-report'];
  if (preferred) {
    return {
      jobName: 'daily-report',
      job: {
        ...preferred,
        enabled: true,
        template: 'daily-report',
        // Web preview only uses Codex source/generator; sinks are not applied.
        sinks: preferred.sinks.filter((sink) => sink.type === 'markdown').length
          ? preferred.sinks.filter((sink) => sink.type === 'markdown')
          : [{
              type: 'markdown',
              directory: '~/.local/share/internflow/reports',
              filename: '{date}.md',
              archive: true,
            }],
      },
    };
  }

  const starter = createStarterConfig().jobs['daily-report'];
  if (!starter) throw new Error('Starter daily-report job is missing.');
  return { jobName: 'daily-report', job: starter };
}

/**
 * 需求开发记录预览用的 dev-log job。
 * - 保留配置里的 lark section-append sink（若有），让 runJob 拉真实飞书 outline（dry-run 只读不写）。
 * - 没配 lark sink 时降级为纯 markdown，dev-log 策略会自动用虚拟三章节占位。
 * - 始终启用（enabled），因为预览是显式手动触发的 dry-run + force。
 */
function resolveDevLogJob(
  config: InternFlowConfig,
): { jobName: string; job: JobConfig; hasLarkOutline: boolean } {
  const preferred = config.jobs['dev-log'];
  if (!preferred) {
    throw new Error('配置里没有 dev-log job。请先运行 `internflow job add dev-log` 或在 config.yaml 中添加。');
  }
  const larkSection = preferred.sinks.find(
    (sink): sink is Extract<SinkConfig, { type: 'lark' }> =>
      sink.type === 'lark' && sink.mode === 'section-append',
  );
  const markdownSinks = preferred.sinks.filter((sink) => sink.type === 'markdown');
  const sinks = markdownSinks.length
    ? markdownSinks
    : [{
        type: 'markdown' as const,
        directory: '~/.local/share/internflow/dev-log',
        filename: '{date}.operations.json',
        archive: false,
      }];
  return {
    jobName: 'dev-log',
    job: {
      ...preferred,
      enabled: true,
      template: 'dev-log',
      // markdown sink 写本地 operations 快照；lark section-append（若有）仅用于 inspect 拉 outline。
      sinks: larkSection ? [...sinks, larkSection] : sinks,
    },
    hasLarkOutline: Boolean(larkSection),
  };
}

function summarize(activity: Activity): SessionSummary {
  return {
    id: activity.id,
    title: activity.title,
    cwd: activity.cwd,
    gitBranch: activity.gitBranch,
    startedAt: activity.startedAt,
    endedAt: activity.endedAt,
    activeMinutes: activity.activeMinutes,
    userMessageCount: activity.userMessages.length,
    commandCount: activity.commands.length,
    changedFileCount: activity.changedFiles.length,
  };
}

async function collectTodayBatch(
  options: {
    date?: string;
    configPath?: string;
  },
  resolveJob: (config: InternFlowConfig) => { jobName: string; job: JobConfig } = resolveDailyReportJob,
): Promise<{
  config: InternFlowConfig;
  jobName: string;
  job: JobConfig;
  date: string;
  context: RunContext;
  batch: ActivityBatch;
  sessionsDir: string;
}> {
  const config = await loadOrStarterConfig(options.configPath);
  const { jobName, job } = resolveJob(config);
  const date = options.date || localDate(new Date(), config.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date: ${date}`);
  }

  const context: RunContext = {
    jobName,
    job,
    date,
    timezone: config.timezone,
    dryRun: true,
    force: true,
  };

  const sessionsDir = expandHome(job.source.sessionsDir || join(homedir(), '.codex', 'sessions'));
  const source = new CodexSource();
  const captured = await source.collect(context, job.source);
  const batch = projectWorkday(captured, context, job.source);
  return { config, jobName, job, date, context, batch, sessionsDir };
}

export async function getDailyReportStatus(options: {
  date?: string;
  configPath?: string;
} = {}): Promise<DailyReportStatus> {
  try {
    const { config, date, batch, sessionsDir } = await collectTodayBatch(options);
    return {
      ok: true,
      date,
      timezone: config.timezone,
      sessionsDir,
      sessionsDirExists: existsSync(sessionsDir),
      sourceCount: batch.sourceCount,
      activityCount: batch.activities.length,
      filteredCount: batch.filteredCount,
      activities: batch.activities.map(summarize),
    };
  } catch (error) {
    const timezone = 'Asia/Shanghai';
    const date = options.date || localDate(new Date(), timezone);
    return {
      ok: false,
      date,
      timezone,
      sessionsDir: join(homedir(), '.codex', 'sessions'),
      sessionsDirExists: false,
      sourceCount: 0,
      activityCount: 0,
      filteredCount: 0,
      activities: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Preferred web-trial model when Codex default is a local/sol path that often fails in CLI. */
export const WEB_DEFAULT_MODEL = process.env.INTERNFLOW_MODEL || 'gpt-5.6-sol';

export async function generateDailyReportPreview(options: {
  date?: string;
  configPath?: string;
  model?: string;
} = {}): Promise<DailyReportPreviewResult> {
  const generatedAt = new Date().toISOString();
  let partial: {
    date: string;
    timezone: string;
    sourceCount: number;
    activityCount: number;
    filteredCount: number;
    activities: SessionSummary[];
  } | null = null;

  try {
    const { config, jobName, job, date, batch } = await collectTodayBatch(options);
    const activities = batch.activities.map(summarize);
    partial = {
      date,
      timezone: config.timezone,
      sourceCount: batch.sourceCount,
      activityCount: batch.activities.length,
      filteredCount: batch.filteredCount,
      activities,
    };

    // Prefer explicit request model, then job config, then a stable web default.
    // Many local Codex configs pin a proxy model that fails under `codex exec`.
    const model = options.model
      || process.env.INTERNFLOW_MODEL
      || job.generator.model
      || WEB_DEFAULT_MODEL;

    if (!batch.activities.length) {
      return {
        ok: true,
        date,
        timezone: config.timezone,
        sourceCount: batch.sourceCount,
        activityCount: 0,
        filteredCount: batch.filteredCount,
        activities,
        markdown: null,
        skipped: true,
        reason: batch.sourceCount
          ? '已找到会话，但都被过滤了（非开发向）。换一天或放宽 source include/exclude。'
          : '今天还没有 Codex 会话。先用 Codex 做点开发工作，再回来生成。',
        generatedAt,
      };
    }

    const runtimeConfig: InternFlowConfig = {
      ...config,
      jobs: {
        ...config.jobs,
        [jobName]: {
          ...job,
          generator: { ...job.generator, model },
        },
      },
    };
    // Web 与 CLI 共用 Runtime，避免预览绕过恢复、策略校验和审计产物。
    const result = await runJob(runtimeConfig, jobName, {
      date,
      dryRun: true,
      force: true,
      model,
    });
    const outputPath = result.outputs.find((output) => typeof output.path === 'string')?.path;
    if (typeof outputPath !== 'string') throw new Error('Daily report preview did not produce a Markdown path.');
    const markdown = await readFile(outputPath, 'utf8');

    return {
      ok: true,
      date,
      timezone: config.timezone,
      sourceCount: batch.sourceCount,
      activityCount: batch.activities.length,
      filteredCount: batch.filteredCount,
      activities,
      markdown,
      skipped: false,
      generatedAt,
    };
  } catch (error) {
    const timezone = partial?.timezone || 'Asia/Shanghai';
    const date = partial?.date || options.date || localDate(new Date(), timezone);
    const message = error instanceof Error ? error.message : String(error);
    const hint = /failed \(\d+\)/i.test(message)
      ? '\n提示：本机 Codex 默认模型可能不可用。页面可改用 gpt-5.6-sol，或设置 INTERNFLOW_MODEL。'
      : '';
    return {
      ok: false,
      date,
      timezone,
      sourceCount: partial?.sourceCount ?? 0,
      activityCount: partial?.activityCount ?? 0,
      filteredCount: partial?.filteredCount ?? 0,
      activities: partial?.activities ?? [],
      markdown: null,
      skipped: true,
      error: `${message}${hint}`,
      generatedAt,
    };
  }
}

export async function generateDevLogPreview(options: {
  date?: string;
  configPath?: string;
  model?: string;
} = {}): Promise<DevLogPreviewResult> {
  const generatedAt = new Date().toISOString();
  let partial: { date: string; timezone: string; sourceCount: number; activityCount: number } | null = null;

  try {
    const { config, jobName, job, date, batch } = await collectTodayBatch(options, resolveDevLogJob);
    const usedLarkOutline = job.sinks.some(
      (sink) => sink.type === 'lark' && sink.mode === 'section-append',
    );
    partial = {
      date,
      timezone: config.timezone,
      sourceCount: batch.sourceCount,
      activityCount: batch.activities.length,
    };

    const candidateCount = batch.devLogCandidates?.length ?? 0;
    if (!candidateCount) {
      return {
        ok: true,
        date,
        timezone: config.timezone,
        sourceCount: batch.sourceCount,
        activityCount: batch.activities.length,
        usedLarkOutline,
        records: [],
        skipped: true,
        reason: batch.sourceCount
          ? '今天有 Codex 会话，但没有具备可追溯证据的需求/BugFix/沉淀增量。'
          : '今天还没有 Codex 会话。先用 Codex 做点开发工作，再回来生成。',
        generatedAt,
      };
    }

    const model = options.model
      || process.env.INTERNFLOW_MODEL
      || job.generator.model
      || WEB_DEFAULT_MODEL;
    const runtimeConfig: InternFlowConfig = {
      ...config,
      jobs: {
        ...config.jobs,
        [jobName]: { ...job, generator: { ...job.generator, model } },
      },
    };
    // 复用 CLI/定时任务同一条 Runtime：ledger 过滤已同步项、拉飞书 outline（dry-run 只读）、生成 records。
    const result = await runJob(runtimeConfig, jobName, { date, dryRun: true, force: true, model });
    const records = await readDevLogOperations(result.operationsPath);

    if (!records.length) {
      return {
        ok: true,
        date,
        timezone: config.timezone,
        sourceCount: batch.sourceCount,
        activityCount: batch.activities.length,
        usedLarkOutline,
        records: [],
        skipped: true,
        reason: result.reason === 'ai_proposed_no_append_operations'
          ? '待补充的候选都已同步过，或模型判断无需新增。'
          : '没有需要补充到需求开发记录的新增量。',
        generatedAt,
      };
    }

    return {
      ok: true,
      date,
      timezone: config.timezone,
      sourceCount: batch.sourceCount,
      activityCount: batch.activities.length,
      usedLarkOutline,
      records,
      skipped: false,
      generatedAt,
    };
  } catch (error) {
    const timezone = partial?.timezone || 'Asia/Shanghai';
    const date = partial?.date || options.date || localDate(new Date(), timezone);
    const message = error instanceof Error ? error.message : String(error);
    const hint = /lark|larkparser|飞书|outline|login|auth/i.test(message)
      ? '\n提示：拉取飞书 outline 需要 lark-cli 已登录且联网。可先运行 `internflow auth lark`，或移除 dev-log 的 lark sink 用虚拟章节预览。'
      : /failed \(\d+\)/i.test(message)
        ? '\n提示：本机 Codex 默认模型可能不可用。页面可改用 gpt-5.6-sol，或设置 INTERNFLOW_MODEL。'
        : '';
    return {
      ok: false,
      date,
      timezone,
      sourceCount: partial?.sourceCount ?? 0,
      activityCount: partial?.activityCount ?? 0,
      usedLarkOutline: false,
      records: [],
      skipped: true,
      error: `${message}${hint}`,
      generatedAt,
    };
  }
}

interface PersistedDevLogOperation {
  section?: string;
  targetHeading?: string;
  markdown?: string;
  evidenceIds?: string[];
}

async function readDevLogOperations(operationsPath?: string): Promise<DevLogRecordView[]> {
  if (!operationsPath || !existsSync(operationsPath)) return [];
  const parsed = JSON.parse(await readFile(operationsPath, 'utf8')) as {
    operations?: PersistedDevLogOperation[];
  };
  const operations = Array.isArray(parsed.operations) ? parsed.operations : [];
  return operations
    .filter((operation): operation is PersistedDevLogOperation & { section: DevLogRecordView['section'] } =>
      operation.section === 'requirement'
      || operation.section === 'bugfix'
      || operation.section === 'insight')
    .map((operation) => ({
      section: operation.section,
      sectionLabel: DEV_LOG_SECTION_LABELS[operation.section],
      targetHeading: operation.targetHeading || '',
      markdown: (operation.markdown || '').trim(),
      evidenceCount: operation.evidenceIds?.length ?? 0,
    }));
}

export async function readLatestPreviewFile(jobName: string, date: string): Promise<string | null> {
  const path = join(
    expandHome('~/.local/state/internflow/runs'),
    jobName,
    date,
    'report.md',
  );
  if (!existsSync(path)) return null;
  return readFile(path, 'utf8');
}
