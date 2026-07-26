import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SinkConfig } from '../../core/config.js';
import { expandHome, stateDirectory } from '../../core/paths.js';
import type { OutputArtifact, RunContext, SinkPlugin } from '../../core/contracts/index.js';

type MarkdownConfig = Extract<SinkConfig, { type: 'markdown' }>;

export class MarkdownSink implements SinkPlugin {
  readonly name = 'markdown' as const;

  async apply(
    context: RunContext,
    config: SinkConfig,
    artifact: OutputArtifact,
  ): Promise<Record<string, unknown>> {
    const markdownConfig = asMarkdownConfig(config);
    const directory = context.dryRun
      ? join(stateDirectory(), 'runs', context.jobName, context.date, 'preview')
      : expandHome(markdownConfig.directory);
    const filename = markdownConfig.filename
      .replaceAll('{job}', context.jobName)
      .replaceAll('{date}', context.date);
    const path = join(directory, filename);
    const content = artifact.kind === 'markdown'
      ? artifact.markdown
      : `${JSON.stringify({ records: artifact.records }, null, 2)}\n`;

    await mkdir(directory, { recursive: true });
    await atomicWrite(path, content);

    if (context.dryRun || !markdownConfig.archive || artifact.kind !== 'markdown') {
      return { sink: this.name, path, preview: context.dryRun };
    }

    const root = dirname(directory);
    const latestPath = join(root, 'latest.md');
    const combinedPath = join(root, 'combined.md');
    await atomicWrite(latestPath, content);
    await atomicWrite(combinedPath, await combinedReports(directory));
    return {
      sink: this.name,
      path,
      latestPath,
      combinedPath,
      preview: false,
    };
  }

  async doctor(config: SinkConfig): Promise<{ ok: boolean; message: string }> {
    const markdownConfig = asMarkdownConfig(config);
    return { ok: true, message: `Markdown output: ${expandHome(markdownConfig.directory)}` };
  }
}

export async function combinedReports(
  directory: string,
  override?: { date: string; markdown: string },
): Promise<string> {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .filter((name) => name !== `${override?.date}.md`);
  if (override) names.push(`${override.date}.md`);
  names.sort().reverse();
  const reports = await Promise.all(
    names.map(async (name) => (
      override && name === `${override.date}.md`
        ? override.markdown.trim()
        : (await readFile(join(directory, name), 'utf8')).trim()
    )),
  );
  const content = reports.filter(Boolean).join('\n\n---\n\n');
  return content ? `${content}\n` : '';
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function asMarkdownConfig(config: SinkConfig): MarkdownConfig {
  if (config.type !== 'markdown') throw new Error('MarkdownSink received non-markdown config.');
  return config;
}
