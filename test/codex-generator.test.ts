import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStarterConfig } from '../src/core/config.js';
import type { ActivityBatch, RunContext } from '../src/core/types.js';
import {
  CodexGenerator,
  containsLevelOneOrTwoHeading,
} from '../src/plugins/generators/codex.js';

const previousStateDir = process.env.INTERNFLOW_STATE_DIR;

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.INTERNFLOW_STATE_DIR;
  else process.env.INTERNFLOW_STATE_DIR = previousStateDir;
  delete process.env.CAPTURE_ARGS;
  delete process.env.CAPTURE_INPUT;
});

describe('CodexGenerator', () => {
  it.each([
    ['ATX H1', '# Title'],
    ['ATX H2', '  ## Title'],
    ['Setext H1', 'Title\n==='],
    ['Setext H2', 'Title\n---'],
    ['HTML H1', '<h1>Title</h1>'],
    ['HTML H2', '<h2 class="title">Title</h2>'],
  ])('detects %s in record Markdown', (_label, markdown) => {
    expect(containsLevelOneOrTwoHeading(markdown)).toBe(true);
  });

  it('allows lower-level headings and standalone horizontal rules', () => {
    expect(containsLevelOneOrTwoHeading('### Detail\n\nContent\n\n---')).toBe(false);
  });

  it('passes the prompt through stdin and the model through argv', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-generator-'));
    const executable = join(directory, 'fake-codex.sh');
    const argsPath = join(directory, 'args.txt');
    const inputPath = join(directory, 'input.txt');
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$@" > "$CAPTURE_ARGS"
cat > "$CAPTURE_INPUT"
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output-last-message' ]; then
    printf '# 2026-07-15\\n\\n## Today\\n\\nDone.\\n' > "$argument"
    break
  fi
  previous="$argument"
done
`);
    await chmod(executable, 0o755);
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    process.env.CAPTURE_ARGS = argsPath;
    process.env.CAPTURE_INPUT = inputPath;
    const config = createStarterConfig();
    const job = config.jobs['daily-report'];
    expect(job).toBeDefined();
    if (!job) return;
    const context: RunContext = {
      jobName: 'daily-report',
      job,
      date: '2026-07-15',
      timezone: 'Asia/Shanghai',
      dryRun: true,
      force: false,
      modelOverride: 'test-model',
    };
    const batch: ActivityBatch = {
      date: context.date,
      timezone: context.timezone,
      sourceCount: 1,
      filteredCount: 0,
      activities: [],
    };

    const result = await new CodexGenerator().generate(context, {
      type: 'codex', executable, model: null,
    }, batch);

    expect(result.kind).toBe('markdown');
    const args = await readFile(argsPath, 'utf8');
    const input = await readFile(inputPath, 'utf8');
    expect(args).toContain('--model\ntest-model');
    expect(args).not.toContain('开发活动 JSON');
    expect(input).toContain('开发活动 JSON');
  });

  it('does not include sensitive model output in command errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-generator-error-'));
    const executable = join(directory, 'fake-codex.sh');
    await writeFile(executable, '#!/bin/sh\ncat >/dev/null\nprintf "private prompt content" >&2\nexit 1\n');
    await chmod(executable, 0o755);
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    const config = createStarterConfig();
    const job = config.jobs['daily-report'];
    expect(job).toBeDefined();
    if (!job) return;
    const context: RunContext = {
      jobName: 'daily-report', job, date: '2026-07-15', timezone: config.timezone,
      dryRun: true, force: false,
    };
    const batch: ActivityBatch = {
      date: context.date, timezone: context.timezone,
      sourceCount: 1, filteredCount: 0, activities: [],
    };

    await expect(new CodexGenerator().generate(context, {
      type: 'codex', executable, model: null,
    }, batch)).rejects.not.toThrow('private prompt content');
  });
});
