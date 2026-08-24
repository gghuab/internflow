import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config.js';
import {
  formatLegacyMigrationPreview,
  migrateLegacyConfig,
} from '../src/core/legacy-migration.js';

describe('legacy configuration migration', () => {
  it('maps both legacy jobs without writing by default', async () => {
    const fixture = await legacyFixture({
      dev: {
        generator: { provider: 'codex', model: 'gpt-5.4' },
        skipDates: ['2026-07-18', '2026-07-19'],
      },
    });

    const result = await migrateLegacyConfig(fixture.options);

    expect(result.applied).toBe(false);
    await expect(readFile(fixture.target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.config.jobs['daily-report']).toEqual(expect.objectContaining({
      enabled: true,
      generator: { type: 'codex', model: 'gpt-5.6-sol' },
      source: { type: 'codex' },
      schedule: { time: '23:30', days: ['mon', 'tue', 'wed', 'thu', 'fri'], dateOffsetDays: 0 },
    }));
    expect(result.config.artifacts).toEqual({
      dailyDirectory: '~/.codex/daily-report',
      devLogDirectory: '~/.codex/daily-report/dev-doc-sync',
    });
    expect(result.config.jobs['daily-report']?.sinks).toEqual([
      {
        type: 'markdown',
        directory: '~/.codex/daily-report/reports',
        filename: '{date}.md',
        archive: true,
      },
      {
        type: 'lark',
        document: fixture.dailyDocument,
        identity: 'user',
        reader: 'lark-cli',
        mode: 'history-replace',
        title: 'Codex 日报',
      },
    ]);
    expect(result.config.jobs['dev-log']).toEqual(expect.objectContaining({
      enabled: true,
      generator: { type: 'codex', model: 'gpt-5.4' },
      skipDates: ['2026-07-18', '2026-07-19'],
    }));
    expect(result.config.jobs['dev-log']?.sinks).toEqual([expect.objectContaining({
      type: 'lark',
      document: fixture.devDocument,
      identity: 'user',
      reader: 'larkparser',
      mode: 'section-append',
    })]);
  });

  it('redacts document tokens and ignores unrelated legacy fields in previews', async () => {
    const fixture = await legacyFixture({
      daily: { apiKey: 'must-not-appear' },
      dev: { accessToken: 'also-must-not-appear' },
    });
    const result = await migrateLegacyConfig(fixture.options);

    const preview = formatLegacyMigrationPreview(result.config);

    expect(preview).toContain('<redacted legacy Lark document>');
    expect(preview).not.toContain(fixture.dailyDocument);
    expect(preview).not.toContain(fixture.devDocument);
    expect(preview).not.toContain('must-not-appear');
    expect(preview).not.toContain('also-must-not-appear');
  });

  it('writes mode 0600 only with --apply and refuses an implicit replacement', async () => {
    const fixture = await legacyFixture();

    const applied = await migrateLegacyConfig({ ...fixture.options, apply: true });

    expect(applied.applied).toBe(true);
    expect((await stat(fixture.target)).mode & 0o777).toBe(0o600);
    expect((await loadConfig(fixture.target)).jobs['daily-report']?.generator.model).toBe('gpt-5.6-sol');
    const original = await readFile(fixture.target, 'utf8');
    await expect(migrateLegacyConfig({ ...fixture.options, apply: true })).rejects.toThrow(
      'Use --apply --force to replace it',
    );
    expect(await readFile(fixture.target, 'utf8')).toBe(original);
  });

  it('preserves the legacy default Codex model and rejects unsafe flags', async () => {
    const fixture = await legacyFixture({ dev: { generator: { provider: 'codex', model: null } } });

    const result = await migrateLegacyConfig(fixture.options);

    expect(result.config.jobs['dev-log']?.generator.model).toBeNull();
    await expect(migrateLegacyConfig({ ...fixture.options, force: true })).rejects.toThrow(
      '--force is only valid together with --apply',
    );
  });
});

async function legacyFixture(overrides: {
  daily?: Record<string, unknown>;
  dev?: Record<string, unknown>;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'internflow-legacy-'));
  const dailyPath = join(directory, 'daily', 'config.json');
  const devPath = join(directory, 'daily', 'dev-doc-sync', 'config.json');
  const target = join(directory, 'internflow', 'config.yaml');
  const dailyDocument = 'https://example.larkoffice.com/wiki/daily-document-token';
  const devDocument = 'https://example.larkoffice.com/docx/dev-document-token';
  await mkdir(join(directory, 'daily', 'dev-doc-sync'), { recursive: true });
  await writeFile(dailyPath, JSON.stringify({
    feishuDoc: dailyDocument,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides.daily,
  }));
  await writeFile(devPath, JSON.stringify({
    feishuDoc: devDocument,
    title: '需求开发记录',
    generator: { provider: 'codex', model: null },
    skipDates: [],
    ...overrides.dev,
  }));
  return {
    target,
    dailyDocument,
    devDocument,
    options: {
      dailyConfigPath: dailyPath,
      devConfigPath: devPath,
      targetPath: target,
    },
  };
}
