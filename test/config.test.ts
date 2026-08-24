import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createStarterConfig,
  internFlowConfigSchema,
  loadConfig,
  writeConfig,
} from '../src/core/config.js';

describe('configuration', () => {
  it('round-trips the starter config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-config-'));
    const path = join(directory, 'config.yaml');
    const config = createStarterConfig();

    await writeConfig(config, path);

    expect(await loadConfig(path)).toEqual(config);
    expect(await readFile(path, 'utf8')).toContain('daily-report:');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('pins the starter daily report to the proven model and archive layout', () => {
    const dailyReport = createStarterConfig().jobs['daily-report'];

    expect(dailyReport?.generator.model).toBe('gpt-5.6-sol');
    expect(dailyReport?.source.type).toBe('codex');
    expect(dailyReport?.schedule).toMatchObject({ time: '23:30', dateOffsetDays: 0 });
    expect(dailyReport?.source.dayEndTime).toBe('23:30');
    expect(dailyReport?.sinks).toContainEqual(expect.objectContaining({
      type: 'markdown',
      filename: '{date}.md',
      archive: true,
    }));
  });

  it('accepts only the precise capture mode', () => {
    const config = createStarterConfig();
    const invalid = structuredClone(config) as unknown as {
      jobs: Record<string, { source: { captureMode: string } }>;
    };
    invalid.jobs['daily-report']!.source.captureMode = 'legacy';
    expect(internFlowConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it('accepts weekly and last-workday monthly report jobs', () => {
    const daily = createStarterConfig().jobs['daily-report']!;
    const result = internFlowConfigSchema.safeParse({
      version: 1,
      timezone: 'Asia/Shanghai',
      jobs: {
        weekly: { ...daily, template: 'weekly-report', schedule: { time: '23:40', days: ['fri'] } },
        monthly: {
          ...daily,
          template: 'monthly-report',
          schedule: {
            time: '23:50', days: ['mon', 'tue', 'wed', 'thu', 'fri'], runOn: 'last-workday',
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('requires an enabled dev-log to have one section-append Lark sink', () => {
    const config = createStarterConfig();
    const devLog = config.jobs['dev-log'];
    expect(devLog).toBeDefined();
    if (!devLog) return;
    devLog.enabled = true;

    const result = internFlowConfigSchema.safeParse(config);

    expect(result.success).toBe(false);
  });

  it('rejects an invalid IANA timezone', () => {
    const config = createStarterConfig();
    config.timezone = 'Shanghai local time';

    expect(internFlowConfigSchema.safeParse(config).success).toBe(false);
  });

  it.each([
    'Daily Report',
    '../daily-report',
    '-daily-report',
    `a${'b'.repeat(64)}`,
  ])('rejects an unsafe or unstable job ID: %s', (jobId) => {
    const config = createStarterConfig();
    config.jobs = { [jobId]: config.jobs['daily-report']! };

    expect(internFlowConfigSchema.safeParse(config).success).toBe(false);
  });
});
