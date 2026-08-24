import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactStore, StateStore } from '../src/core/persistence/index.js';
import { createJobStrategy } from '../src/core/runtime/job-strategies/index.js';

describe('runtime job strategies', () => {
  it('keeps artifact contracts inside each strategy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-strategy-'));
    const options = {
      artifacts: new ArtifactStore({ rootDirectory: join(directory, 'artifacts') }),
      state: new StateStore(join(directory, 'state.json')),
      date: '2026-07-16',
      dryRun: true,
      generatorType: 'codex',
      generatorModel: null,
    };
    const daily = createJobStrategy('daily-report', options);
    const devLog = createJobStrategy('dev-log', options);
    const weekly = createJobStrategy('weekly-report', options);
    const monthly = createJobStrategy('monthly-report', options);

    expect(() => daily.assertArtifact({ kind: 'records', records: [] }))
      .toThrow('non-Markdown');
    expect(() => devLog.assertArtifact({ kind: 'markdown', markdown: '# report' }))
      .toThrow('non-record');
    expect(() => daily.assertArtifact({ kind: 'markdown', markdown: '# report' })).not.toThrow();
    expect(() => devLog.assertArtifact({ kind: 'records', records: [] })).not.toThrow();
    expect(() => weekly.assertArtifact({ kind: 'records', records: [] })).toThrow('non-Markdown');
    expect(() => monthly.assertArtifact({ kind: 'markdown', markdown: '# report' })).not.toThrow();
  });

  it('keeps template branches and report dependencies out of the common runtime contracts', async () => {
    const runner = await readFile(new URL('../src/core/runtime/runner.ts', import.meta.url), 'utf8');
    const activity = await readFile(new URL('../src/core/contracts/activity.ts', import.meta.url), 'utf8');
    const webPreview = await readFile(new URL('../src/web/preview.ts', import.meta.url), 'utf8');
    expect(runner).not.toMatch(/job\.template\s*===/);
    expect(runner).not.toMatch(/template\s*===\s*['"](?:daily-report|dev-log)/);
    expect(activity).not.toMatch(/\.\.\/\.\.\/(?:reports|work-items)\//);
    expect(webPreview).toMatch(/runJob\(/);
    expect(webPreview).not.toMatch(/\.generator\.generate\(/);
  });
});
