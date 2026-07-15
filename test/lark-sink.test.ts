import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { internFlowConfigSchema } from '../src/core/config.js';
import type { RunContext } from '../src/core/types.js';
import {
  assertHeadingsUnchanged,
  LarkSink,
  lastBlockId,
  parseOutline,
} from '../src/plugins/sinks/lark.js';

afterEach(() => {
  delete process.env.CAPTURE_LOG;
  delete process.env.CAPTURE_INPUT;
});

describe('Lark structured append helpers', () => {
  const outline = '<fragment><h1 id="root">需求开发记录</h1><h2 id="req">一、需求开发记录</h2><h3 id="task">1. Task</h3><h2 id="bug">二、联调问题与 Bug Fix 汇总</h2><h3 id="issue">1. Issue</h3><h2 id="insight">三、个人沉淀</h2></fragment>';

  it('maps opaque refs to real headings and sections', () => {
    const headings = parseOutline(outline);

    expect(headings.map(({ ref, blockId, section }) => ({ ref, blockId, section }))).toEqual([
      { ref: 'h1', blockId: 'root', section: null },
      { ref: 'h2', blockId: 'req', section: 'requirement' },
      { ref: 'h3', blockId: 'task', section: 'requirement' },
      { ref: 'h4', blockId: 'bug', section: 'bugfix' },
      { ref: 'h5', blockId: 'issue', section: 'bugfix' },
      { ref: 'h6', blockId: 'insight', section: 'insight' },
    ]);
  });

  it('finds the last existing block in a section', () => {
    expect(lastBlockId('<fragment><h3 id="task">Task</h3><p id="body">Old</p></fragment>', 'task'))
      .toBe('body');
  });

  it('rejects headings that were renamed or moved to another section', () => {
    const inspected = parseOutline(outline);
    const renamed = parseOutline(outline.replace('1. Task', '1. Renamed task'));
    const moved = parseOutline(
      '<fragment><h1 id="root">需求开发记录</h1><h2 id="req">一、需求开发记录</h2>'
      + '<h2 id="bug">二、联调问题与 Bug Fix 汇总</h2><h3 id="task">1. Task</h3>'
      + '<h3 id="issue">1. Issue</h3><h2 id="insight">三、个人沉淀</h2></fragment>',
    );

    expect(() => assertHeadingsUnchanged(inspected, renamed)).toThrow('changed during generation');
    expect(() => assertHeadingsUnchanged(inspected, moved)).toThrow('changed during generation');
  });

  it('uses the inspected revision and appends after the section end', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-lark-'));
    const executable = join(directory, 'fake-lark.sh');
    const logPath = join(directory, 'args.log');
    const inputPath = join(directory, 'input.md');
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' '---' "$@" >> "$CAPTURE_LOG"
case " $* " in
  *" --scope full "*)
    printf '%s\\n' '{"ok":true,"data":{"document":{"content":"# Doc","revision_id":7}}}'
    ;;
  *" --scope outline "*)
    printf '%s\\n' '{"ok":true,"data":{"document":{"content":"<fragment><h1 id=\\"root\\">Doc</h1><h2 id=\\"req\\">一、需求开发记录</h2><h3 id=\\"task\\">1. Task</h3></fragment>","revision_id":7}}}'
    ;;
  *" --scope section "*)
    printf '%s\\n' '{"ok":true,"data":{"document":{"content":"<fragment><h3 id=\\"task\\">1. Task</h3><p id=\\"body\\">Old</p></fragment>","revision_id":7}}}'
    ;;
  *" +update "*)
    cat > "$CAPTURE_INPUT"
    printf '%s\\n' '{"ok":true,"data":{"result":"success","document":{"revision_id":8}}}'
    ;;
esac
`);
    await chmod(executable, 0o755);
    process.env.CAPTURE_LOG = logPath;
    process.env.CAPTURE_INPUT = inputPath;
    const config = internFlowConfigSchema.parse({
      version: 1,
      timezone: 'Asia/Shanghai',
      jobs: {
        'dev-log': {
          enabled: true,
          template: 'dev-log',
          schedule: { time: '23:45', days: ['mon'] },
          source: { type: 'codex' },
          generator: { type: 'codex', model: null },
          sinks: [{ type: 'lark', document: 'doc-token', executable, mode: 'section-append' }],
        },
      },
    });
    const job = config.jobs['dev-log'];
    expect(job).toBeDefined();
    if (!job) return;
    const context: RunContext = {
      jobName: 'dev-log', job, date: '2026-07-15', timezone: config.timezone,
      dryRun: false, force: false,
    };
    const sink = new LarkSink();
    const sinkConfig = job.sinks[0];
    expect(sinkConfig).toBeDefined();
    if (!sinkConfig) return;
    const snapshot = await sink.inspect(context, sinkConfig);

    const result = await sink.apply(context, sinkConfig, {
      kind: 'records',
      records: [{ section: 'requirement', targetRef: 'h3', markdown: 'New content\n' }],
    }, snapshot);

    const args = await readFile(logPath, 'utf8');
    expect(args.match(/--scope\noutline/g)).toHaveLength(2);
    expect(args).toContain('block_insert_after');
    expect(args).toContain('--block-id\nbody');
    expect(args).toContain('--revision-id\n7');
    expect(await readFile(inputPath, 'utf8')).toBe('New content\n');
    expect(result).toMatchObject({ sink: 'lark', mode: 'section-append' });
  });
});
