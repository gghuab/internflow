import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DayName, JobConfig } from '../../core/config.js';
import { stateDirectory } from '../../core/paths.js';
import { runCommand } from '../../core/process.js';

const LAUNCHD_WEEKDAY: Record<DayName, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export interface LaunchdInstallOptions {
  jobName: string;
  job: JobConfig;
  cliPath: string;
  configPath: string;
  timezone: string;
}

export class LaunchdScheduler {
  async install(options: LaunchdInstallOptions): Promise<{ label: string; plist: string }> {
    if (process.platform !== 'darwin') throw new Error('launchd is only available on macOS.');
    assertLaunchdTimezone(options.timezone);
    const label = labelForJob(options.jobName);
    const plistPath = plistForLabel(label);
    const logDir = join(stateDirectory(), 'logs');
    await mkdir(dirname(plistPath), { recursive: true });
    await mkdir(logDir, { recursive: true });
    for (const path of [join(logDir, `${options.jobName}.out.log`), join(logDir, `${options.jobName}.err.log`)]) {
      if (!existsSync(path)) await writeFile(path, '', { mode: 0o600 });
    }

    const content = generateLaunchdPlist({ ...options, label, logDir });
    const temporary = `${plistPath}.${process.pid}.tmp`;
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await runCommand('/usr/bin/plutil', ['-lint', temporary]);
    await rename(temporary, plistPath);
    await chmod(plistPath, 0o600);

    await this.bootout(label);
    await runCommand('/bin/launchctl', ['bootstrap', `gui/${process.getuid?.()}`, plistPath]);
    await runCommand('/bin/launchctl', ['enable', `gui/${process.getuid?.()}/${label}`]);
    return { label, plist: plistPath };
  }

  async remove(jobName: string): Promise<{ label: string; removed: boolean }> {
    const label = labelForJob(jobName);
    await this.bootout(label);
    const path = plistForLabel(label);
    const removed = existsSync(path);
    if (removed) await rm(path);
    return { label, removed };
  }

  async status(jobName: string): Promise<{ label: string; installed: boolean; detail?: string }> {
    const label = labelForJob(jobName);
    try {
      const result = await runCommand('/bin/launchctl', ['print', `gui/${process.getuid?.()}/${label}`]);
      const state = result.stdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim();
      return { label, installed: true, ...(state ? { detail: state } : {}) };
    } catch {
      return { label, installed: false };
    }
  }

  private async bootout(label: string): Promise<void> {
    try {
      await runCommand('/bin/launchctl', ['bootout', `gui/${process.getuid?.()}/${label}`]);
    } catch {
      // 未安装时 bootout 会失败，可安全忽略。
    }
  }
}

export function generateLaunchdPlist(
  options: LaunchdInstallOptions & { label?: string; logDir?: string },
): string {
  const label = options.label || labelForJob(options.jobName);
  const logDir = options.logDir || join(stateDirectory(), 'logs');
  const [hour, minute] = options.job.schedule.time.split(':').map(Number);
  const triggerOffset = -(options.job.schedule.dateOffsetDays ?? 0);
  const intervals = options.job.schedule.days.map((day) => `    <dict>
      <key>Weekday</key><integer>${LAUNCHD_WEEKDAY[shiftDay(day, triggerOffset)]}</integer>
      <key>Hour</key><integer>${hour}</integer>
      <key>Minute</key><integer>${minute}</integer>
    </dict>`).join('\n');
  const cliPath = resolve(options.cliPath);
  const workingDirectory = dirname(cliPath);
  const commonPath = [
    dirname(process.execPath),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.local', 'node-v24', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
  ].join(':');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(cliPath)}</string>
    <string>--config</string>
    <string>${xmlEscape(resolve(options.configPath))}</string>
    <string>run</string>
    <string>${xmlEscape(options.jobName)}</string>
    <string>--scheduled</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(commonPath)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xmlEscape(workingDirectory)}</string>
  <key>StartCalendarInterval</key>
  <array>
${intervals}
  </array>
  <key>StandardOutPath</key><string>${xmlEscape(join(logDir, `${options.jobName}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(logDir, `${options.jobName}.err.log`))}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`;
}

function shiftDay(day: DayName, offset: number): DayName {
  const days: DayName[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const index = days.indexOf(day);
  return days[(index + offset + days.length) % days.length] || day;
}

export function labelForJob(jobName: string): string {
  const safe = jobName.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '');
  if (!safe) throw new Error(`Invalid job name for launchd: ${jobName}`);
  const hash = createHash('sha256').update(jobName, 'utf8').digest('hex').slice(0, 8);
  return `dev.internflow.job.${safe}-${hash}`;
}

export function assertLaunchdTimezone(
  configuredTimezone: string,
  systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): void {
  const configured = canonicalTimezone(configuredTimezone);
  const system = canonicalTimezone(systemTimezone);
  if (configured === system) return;

  throw new Error(
    `Cannot install launchd schedule: config timezone "${configuredTimezone}" does not match `
      + `the macOS system timezone "${systemTimezone}". launchd uses the system timezone; `
      + `set config timezone to "${systemTimezone}" or change the macOS timezone first.`,
  );
}

function canonicalTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`Invalid timezone for launchd schedule: "${timezone}".`);
  }
}

function plistForLabel(label: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
