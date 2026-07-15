#!/usr/bin/env node

import { access, chmod } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  createStarterConfig,
  internFlowConfigSchema,
  loadConfig,
  writeConfig,
  type InternFlowConfig,
  type JobConfig,
} from './core/config.js';
import { defaultConfigPath, expandHome } from './core/paths.js';
import { resolveExecutable, runCommand } from './core/process.js';
import { PluginRegistry } from './core/registry.js';
import { runJob } from './core/runner.js';
import { assertLaunchdTimezone, LaunchdScheduler } from './plugins/schedulers/launchd.js';

const program = new Command();

program
  .name('internflow')
  .description('Turn local development activity into scheduled, structured work records.')
  .version('0.1.0')
  .option('-c, --config <path>', 'configuration file', defaultConfigPath());

program
  .command('init')
  .description('create a starter configuration')
  .option('--force', 'replace an existing configuration')
  .action(async (options: { force?: boolean }) => {
    const path = configPath();
    if (existsSync(path) && !options.force) {
      throw new Error(`Config already exists: ${path}. Use --force to replace it.`);
    }
    await writeConfig(createStarterConfig(), path);
    await chmod(path, 0o600);
    console.log(`Created ${path}`);
    console.log('Next: edit the jobs, then run `internflow doctor`.');
  });

const job = program.command('job').description('manage jobs');

job
  .command('list')
  .description('list configured jobs')
  .action(async () => {
    const config = await loadCurrentConfig();
    for (const [name, value] of Object.entries(config.jobs)) {
      console.log(`${value.enabled ? 'enabled ' : 'disabled'}  ${name.padEnd(24)} ${value.template.padEnd(14)} ${formatSchedule(value)}`);
    }
  });

job
  .command('show <name>')
  .description('show one job as JSON')
  .action(async (name: string) => {
    const config = await loadCurrentConfig();
    const value = config.jobs[name];
    if (!value) throw new Error(`Unknown job: ${name}`);
    console.log(JSON.stringify(value, null, 2));
  });

job
  .command('add <template>')
  .description('add a daily-report or dev-log job')
  .option('--name <name>', 'job name')
  .option('--time <HH:mm>', 'scheduled time')
  .option('--document <url>', 'Lark document URL')
  .option('--model <model>', 'Codex model')
  .action(async (
    template: string,
    options: { name?: string; time?: string; document?: string; model?: string },
  ) => {
    if (!['daily-report', 'dev-log'].includes(template)) {
      throw new Error(`Unknown template: ${template}`);
    }
    if (template === 'dev-log' && !options.document) {
      throw new Error('dev-log requires --document <Lark URL>.');
    }
    const config = await loadCurrentConfig();
    const name = options.name || template;
    if (config.jobs[name]) throw new Error(`Job already exists: ${name}`);
    config.jobs[name] = createJob(template as JobConfig['template'], options);
    const validated = internFlowConfigSchema.parse(config);
    await writeConfig(validated, configPath());
    console.log(`Added job ${name}.`);
  });

program
  .command('run <job>')
  .description('run one job')
  .option('--date <YYYY-MM-DD>', 'target local date')
  .option('--dry-run', 'generate previews without writing remote sinks')
  .option('--force', 'run a disabled job or bypass idempotency')
  .option('--model <model>', 'override the configured model for this run')
  .option('--scheduled', 'mark a scheduler-triggered run')
  .action(async (
    jobName: string,
    options: { date?: string; dryRun?: boolean; force?: boolean; model?: string },
  ) => {
    const config = await loadCurrentConfig();
    const date = options.date || localDate(new Date(), config.timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
    const result = await runJob(config, jobName, {
      date,
      dryRun: Boolean(options.dryRun),
      force: Boolean(options.force),
      ...(options.model ? { model: options.model } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('auth <provider>')
  .description('authenticate a connector without storing its credentials in InternFlow')
  .option('--profile <name>', 'connector profile')
  .option('--status', 'only check current authentication')
  .action(async (provider: string, options: { profile?: string; status?: boolean }) => {
    if (provider !== 'lark') throw new Error(`Unsupported auth provider: ${provider}`);
    const executable = await resolveExecutable('lark-cli');
    if (!executable) throw new Error('lark-cli was not found.');
    const profile = options.profile ? ['--profile', options.profile] : [];
    const args = options.status
      ? [...profile, 'auth', 'status', '--verify']
      : [...profile, 'auth', 'login', '--scope', 'docx:document:readonly docx:document:write_only'];
    await runCommand(executable, args, { inheritStdio: true, timeoutMs: 5 * 60_000 });
  });

program
  .command('doctor')
  .description('check configuration, generators, sources, and sinks')
  .option('--online', 'verify remote authentication and connectivity')
  .action(async (options: { online?: boolean }) => {
    const checks = await doctor(options.online);
    for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.message}`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  });

const schedule = program.command('schedule').description('manage scheduled jobs');

schedule
  .command('install <job>')
  .description('install a macOS launchd schedule')
  .action(async (jobName: string) => {
    const config = await loadCurrentConfig();
    const value = config.jobs[jobName];
    if (!value) throw new Error(`Unknown job: ${jobName}`);
    const scheduler = new LaunchdScheduler();
    const result = await scheduler.install({
      jobName,
      job: value,
      cliPath: process.argv[1] || '',
      configPath: configPath(),
      timezone: config.timezone,
    });
    console.log(JSON.stringify(result, null, 2));
  });

schedule
  .command('status <job>')
  .description('show a macOS launchd schedule')
  .action(async (jobName: string) => {
    console.log(JSON.stringify(await new LaunchdScheduler().status(jobName), null, 2));
  });

schedule
  .command('remove <job>')
  .description('remove a macOS launchd schedule')
  .action(async (jobName: string) => {
    console.log(JSON.stringify(await new LaunchdScheduler().remove(jobName), null, 2));
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function configPath(): string {
  return expandHome(program.opts<{ config: string }>().config);
}

async function loadCurrentConfig(): Promise<InternFlowConfig> {
  return loadConfig(configPath());
}

function createJob(
  template: JobConfig['template'],
  options: { time?: string; document?: string; model?: string },
): JobConfig {
  const markdown = {
    type: 'markdown' as const,
    directory: `~/.local/share/internflow/${template}`,
    filename: template === 'daily-report' ? '{date}.md' : '{date}.operations.json',
  };
  const sinks: JobConfig['sinks'] = [markdown];
  if (options.document) {
    sinks.push({
      type: 'lark',
      document: options.document,
      mode: template === 'dev-log' ? 'section-append' : 'append',
    });
  }
  return {
    enabled: true,
    template,
    schedule: {
      time: options.time || (template === 'daily-report' ? '23:30' : '23:45'),
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    },
    source: { type: 'codex' },
    generator: { type: 'codex', model: options.model || null },
    sinks,
  };
}

async function doctor(online = false): Promise<Array<{ ok: boolean; message: string }>> {
  const checks: Array<{ ok: boolean; message: string }> = [];
  let config: InternFlowConfig;
  try {
    config = await loadCurrentConfig();
    checks.push({ ok: true, message: `Config valid: ${configPath()}` });
  } catch (error) {
    return [{ ok: false, message: String(error) }];
  }

  try {
    assertLaunchdTimezone(config.timezone);
    checks.push({ ok: true, message: `Scheduler timezone: ${config.timezone}` });
  } catch (error) {
    checks.push({ ok: false, message: `Scheduler timezone: ${errorMessage(error)}` });
  }

  const checkedGenerators = new Set<string>();
  for (const [jobName, value] of Object.entries(config.jobs)) {
    const configured = value.generator.executable || '';
    if (checkedGenerators.has(configured)) continue;
    checkedGenerators.add(configured);
    const codex = await resolveExecutable('codex', value.generator.executable);
    checks.push({
      ok: Boolean(codex),
      message: codex
        ? `${jobName}: Codex CLI: ${codex}`
        : `${jobName}: configured Codex CLI was not found${configured ? `: ${configured}` : '.'}`,
    });
    if (!codex) continue;
    try {
      await runCommand(codex, ['login', 'status'], { timeoutMs: 30_000 });
      checks.push({ ok: true, message: `${jobName}: Codex authentication ready.` });
    } catch {
      checks.push({ ok: false, message: `${jobName}: Codex authentication check failed.` });
    }
  }

  const checkedSources = new Set<string>();
  for (const [jobName, value] of Object.entries(config.jobs)) {
    const sessionsDir = expandHome(value.source.sessionsDir || join(homedir(), '.codex', 'sessions'));
    if (checkedSources.has(sessionsDir)) continue;
    checkedSources.add(sessionsDir);
    checks.push({
      ok: await canRead(sessionsDir),
      message: `${jobName}: Codex sessions: ${sessionsDir}`,
    });
  }

  const registry = new PluginRegistry();
  for (const [jobName, value] of Object.entries(config.jobs)) {
    for (const sinkConfig of value.sinks) {
      const sink = registry.sink(sinkConfig.type);
      const result = await sink.doctor(sinkConfig);
      checks.push({ ...result, message: `${jobName}: ${result.message}` });
      if (online && sinkConfig.type === 'lark') {
        const executable = await resolveExecutable('lark-cli', sinkConfig.executable);
        if (!executable) continue;
        try {
          const profile = sinkConfig.profile ? ['--profile', sinkConfig.profile] : [];
          await runCommand(executable, [...profile, 'auth', 'status', '--verify'], { timeoutMs: 30_000 });
          checks.push({ ok: true, message: `${jobName}: Lark authentication verified.` });
        } catch {
          checks.push({ ok: false, message: `${jobName}: Lark authentication verification failed.` });
          continue;
        }
        try {
          const profile = sinkConfig.profile ? ['--profile', sinkConfig.profile] : [];
          const result = await runCommand(executable, [
            ...profile,
            'docs',
            '+fetch',
            '--api-version',
            'v2',
            '--doc',
            sinkConfig.document,
            '--scope',
            'outline',
            '--detail',
            'with-ids',
            '--doc-format',
            'xml',
            '--as',
            'user',
            '--format',
            'json',
          ], { timeoutMs: 3 * 60_000, sensitiveOutput: true });
          if (!isSuccessfulLarkFetch(result.stdout)) throw new Error('Lark document fetch failed.');
          checks.push({ ok: true, message: `${jobName}: Lark target document is readable.` });
        } catch {
          checks.push({ ok: false, message: `${jobName}: Lark target document is not readable.` });
        }
      }
    }
  }
  return checks;
}

function isSuccessfulLarkFetch(output: string): boolean {
  try {
    const response = JSON.parse(output) as {
      ok?: boolean;
      data?: { document?: { content?: unknown; revision_id?: unknown } };
    };
    return response.ok === true
      && typeof response.data?.document?.content === 'string'
      && typeof response.data.document.revision_id === 'number';
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSchedule(job: JobConfig): string {
  return `${job.schedule.days.join(',')} ${job.schedule.time}`;
}

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

async function canRead(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
