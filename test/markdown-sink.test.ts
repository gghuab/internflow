import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { internFlowConfigSchema } from '../src/core/config.js';
import type { RunContext } from '../src/core/contracts/index.js';
import { MarkdownSink } from '../src/plugins/sinks/markdown.js';

describe('MarkdownSink daily report archive', () => {
  it('writes the dated report plus latest.md and newest-first combined.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-markdown-archive-'));
    const reports = join(root, 'reports');
    await mkdir(reports);
    await writeFile(join(reports, '2026-07-13.md'), '# 2026-07-13\n\n旧日报 13\n');
    await writeFile(join(reports, '2026-07-14.md'), '# 2026-07-14\n\n旧日报 14\n');
    await writeFile(join(reports, 'notes.md'), '# 不应进入历史汇总\n');

    const config = internFlowConfigSchema.parse({
      version: 1,
      timezone: 'Asia/Shanghai',
      jobs: {
        'daily-report': {
          enabled: true,
          template: 'daily-report',
          schedule: { time: '23:30', days: ['wed'] },
          source: { type: 'codex' },
          generator: { type: 'codex', model: 'gpt-5.6-sol' },
          sinks: [{
            type: 'markdown',
            directory: reports,
            filename: '{date}.md',
            archive: true,
          }],
        },
      },
    });
    const job = config.jobs['daily-report'];
    expect(job).toBeDefined();
    if (!job) return;
    const context: RunContext = {
      jobName: 'daily-report', job, date: '2026-07-15', timezone: config.timezone,
      dryRun: false, force: false,
    };
    const sinkConfig = job.sinks[0];
    expect(sinkConfig).toBeDefined();
    if (!sinkConfig) return;
    const markdown = '# 2026-07-15\n\n今天日报\n';

    const result = await new MarkdownSink().apply(
      context,
      sinkConfig,
      { kind: 'markdown', markdown },
    );

    expect(await readFile(join(reports, '2026-07-15.md'), 'utf8')).toBe(markdown);
    expect(await readFile(join(root, 'latest.md'), 'utf8')).toBe(markdown);
    expect(await readFile(join(root, 'combined.md'), 'utf8')).toBe(
      '# 2026-07-15\n\n今天日报\n\n---\n\n'
      + '# 2026-07-14\n\n旧日报 14\n\n---\n\n'
      + '# 2026-07-13\n\n旧日报 13\n',
    );
    expect(result).toMatchObject({
      sink: 'markdown',
      path: join(reports, '2026-07-15.md'),
      latestPath: join(root, 'latest.md'),
      combinedPath: join(root, 'combined.md'),
      preview: false,
    });
  });
});
