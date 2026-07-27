import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { internFlowConfigSchema } from '../src/core/config.js';
import type { RunContext } from '../src/core/contracts/index.js';
import {
  LarkSink,
  parseOutline,
  prepareLarkMarkdown,
  topLevelBlockIds,
} from '../src/plugins/sinks/lark.js';

afterEach(() => {
  delete process.env.CAPTURE_LOG;
  delete process.env.CAPTURE_INPUT;
});

describe('dev-log Lark synchronization', () => {
  it('recognizes the four-part archive and ignores nested block ids', () => {
    const headings = parseOutline(
      '<fragment><h2 id="overview">一、开发总览</h2>'
      + '<h2 id="req">二、需求开发记录</h2><h3 id="task">REQ-001｜Task</h3>'
      + '<h2 id="bug">三、问题与修复记录</h2><h3 id="issue">ISSUE-001｜Issue</h3>'
      + '<h2 id="insight">四、工程经验沉淀</h2></fragment>',
    );

    expect(headings.map(({ blockId, section }) => ({ blockId, section }))).toEqual([
      { blockId: 'overview', section: 'overview' },
      { blockId: 'req', section: 'requirement' },
      { blockId: 'task', section: 'requirement' },
      { blockId: 'bug', section: 'bugfix' },
      { blockId: 'issue', section: 'bugfix' },
      { blockId: 'insight', section: 'insight' },
    ]);
    expect(topLevelBlockIds(
      '<fragment><h4 id="heading">需求概览</h4>'
      + '<table id="table"><tr><td><p id="nested">Old</p></td></tr></table></fragment>',
    )).toEqual(['heading', 'table']);
  });

  it('removes blank Lark blocks around headings and code fences', () => {
    expect(prepareLarkMarkdown([
      '#### 核心实现',
      '',
      '实现说明',
      '',
      '```ts',
      'const completed = true;',
      '```',
      '',
      '##### 验证结果',
      '',
      '- npm test：通过',
    ].join('\n'))).toBe([
      '#### 核心实现',
      '实现说明',
      '```ts',
      'const completed = true;',
      '```',
      '##### 验证结果',
      '- npm test：通过',
    ].join('\n'));
  });

  it('inserts a replacement before deleting the old top-level blocks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-dev-log-lark-'));
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
    printf '%s\\n' '{"ok":true,"data":{"document":{"content":"<fragment><h2 id=\\"req\\">二、需求开发记录</h2><h3 id=\\"task\\">REQ-004｜任务</h3><h4 id=\\"overview\\">需求概览</h4></fragment>","revision_id":7}}}'
    ;;
  *" --scope section "*)
    printf '%s\\n' '{"ok":true,"data":{"document":{"content":"<fragment><h4 id=\\"overview\\">需求概览</h4><table id=\\"table\\"><tr><td><p id=\\"nested\\">Old</p></td></tr></table></fragment>","revision_id":7}}}'
    ;;
  *" --command block_insert_after "*)
    cat >> "$CAPTURE_INPUT"
    printf '%s\\n' '{"ok":true,"data":{"result":"success","document":{"revision_id":8}}}'
    ;;
  *" --command block_delete "*)
    printf '%s\\n' '{"ok":true,"data":{"result":"success","document":{"revision_id":9}}}'
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
          sinks: [{
            type: 'lark',
            document: 'doc-token',
            executable,
            mode: 'section-append',
          }],
        },
      },
    });
    const job = config.jobs['dev-log']!;
    const context: RunContext = {
      jobName: 'dev-log',
      job,
      date: '2026-07-26',
      timezone: config.timezone,
      dryRun: false,
      force: false,
    };
    const sink = new LarkSink();
    const sinkConfig = job.sinks[0]!;
    const snapshot = await sink.inspect(context, sinkConfig);

    await sink.apply(context, sinkConfig, {
      kind: 'records',
      records: [{
        section: 'requirement',
        targetRef: 'h3',
        operation: 'replace',
        role: 'requirement-overview',
        markdown: '#### 需求概览\n| 项目 | 当前事实 |\n| --- | --- |\n| 状态 | 完成 |\n',
      }],
    }, snapshot);

    const args = await readFile(logPath, 'utf8');
    expect(args).toContain('--command\nblock_insert_after\n--block-id\ntable');
    expect(args).toContain('--command\nblock_delete\n--block-id\noverview,table');
    expect(args).not.toContain('overview,table,nested');
    expect(args).toContain('--revision-id\n8');
    expect(await readFile(inputPath, 'utf8')).toContain('#### 需求概览');
  });
});
