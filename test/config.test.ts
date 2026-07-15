import { mkdtemp, readFile } from 'node:fs/promises';
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
