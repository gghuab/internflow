import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SinkConfig } from '../../core/config.js';
import { expandHome, stateDirectory } from '../../core/paths.js';
import type { OutputArtifact, RunContext, SinkPlugin } from '../../core/types.js';

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
    await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
    return { sink: this.name, path, preview: context.dryRun };
  }

  async doctor(config: SinkConfig): Promise<{ ok: boolean; message: string }> {
    const markdownConfig = asMarkdownConfig(config);
    return { ok: true, message: `Markdown output: ${expandHome(markdownConfig.directory)}` };
  }
}

function asMarkdownConfig(config: SinkConfig): MarkdownConfig {
  if (config.type !== 'markdown') throw new Error('MarkdownSink received non-markdown config.');
  return config;
}

