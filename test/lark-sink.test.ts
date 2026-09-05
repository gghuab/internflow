import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { internFlowConfigSchema } from '../src/core/config.js';
import type { RunContext } from '../src/core/contracts/index.js';
import {
  assertHeadingsUnchanged,
  isLarkIdentityAvailable,
  LarkSink,
  lastBlockId,
  parseOutline,
  prepareLarkMarkdown,
  splitHistoryMarkdown,
  topLevelBlockIds,
} from '../src/plugins/sinks/lark.js';

afterEach(() => {
  delete process.env.CAPTURE_LOG;
  delete process.env.CAPTURE_INPUT;
  delete process.env.INVOKED_PATH;
  delete process.env.INTERNFLOW_STATE_DIR;
  delete process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN;
  delete process.env.LARKSUITE_CLI_APP_ID;
  delete process.env.INTERNFLOW_LARK_CHUNK_DELAY_MS;
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

  it('requires the configured Lark identity to be available', () => {
    expect(isLarkIdentityAvailable(JSON.stringify({
      identities: { user: { available: false }, bot: { available: true } },
    }), 'user')).toBe(false);
    expect(isLarkIdentityAvailable(JSON.stringify({
      identities: { user: { available: true } },
    }), 'user')).toBe(true);
    expect(isLarkIdentityAvailable('not-json', 'user')).toBe(false);
  });

  it('recognizes the current four-part document structure', () => {
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
  });

  it('keeps the current legacy section across an unrelated level-two heading', () => {
    const headings = parseOutline(
      '<fragment><h2 id="req">一、需求开发记录</h2><h3 id="task">Task</h3>'
      + '<h2 id="note">补充说明</h2><h3 id="detail">Detail</h3></fragment>',
    );

    expect(headings.at(-1)?.section).toBe('requirement');
  });

  it('finds the last existing block in a section', () => {
    expect(lastBlockId('<fragment><h3 id="task">Task</h3><p id="body">Old</p></fragment>', 'task'))
      .toBe('body');
  });

  it('uses only top-level blocks when a section contains nested table cells', () => {
    const xml = '<fragment><h4 id="heading">需求概览</h4>'
      + '<table id="table"><tr><td><p id="nested">Old</p></td></tr></table></fragment>';
    expect(topLevelBlockIds(xml)).toEqual(['heading', 'table']);
    expect(lastBlockId(xml, 'heading')).toBe('table');
    expect(topLevelBlockIds(
      '<fragment><h3 id="heading">最近更新</h3><ol><li id="first">A</li><li id="second">B</li></ol></fragment>',
    )).toEqual(['heading', 'first', 'second']);
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

  it('turns Mermaid fences into rendered Lark whiteboards', () => {
    const markdown = [
      '**全天工作关系图**',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[梳理 A & B] --> C[完成]',
      '```',
      '',
      '<p><br/></p>',
      '',
      '```ts',
      'const untouched = true;',
      '```',
    ].join('\n');

    expect(prepareLarkMarkdown(markdown)).toBe([
      '**全天工作关系图**',
      '<whiteboard type="mermaid">',
      'flowchart LR',
      '  A[梳理 A &amp; B] --> C[完成]',
      '</whiteboard>',
      '```ts',
      'const untouched = true;',
      '```',
    ].join('\n'));
  });

  it('removes Lark empty blocks around headings and code fences', () => {
    const markdown = [
      '## 多端协作',
      '',
      '正文',
      '',
      '```ts',
      '',
      'const first = true;',
      '',
      'const second = true;',
      '',
      '```',
      '',
      '### 验证',
      '',
      '- 通过',
      '',
    ].join('\n');

    expect(prepareLarkMarkdown(markdown)).toBe([
      '## 多端协作',
      '正文',
      '```ts',
      'const first = true;',
      '',
      'const second = true;',
      '```',
      '### 验证',
      '- 通过',
      '',
    ].join('\n'));
  });

  it('splits accumulated history only at daily report boundaries', () => {
    const chunks = splitHistoryMarkdown([
      '<title>Codex 日报</title>',
      '# 2026-07-21 工作日报',
      '## 今日工作',
      '# 2026-07-20 工作日报',
      '昨天内容',
    ].join('\n'));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('# 2026-07-21 工作日报');
    expect(chunks[0]).toContain('## 今日工作');
    expect(chunks[1]).toBe('# 2026-07-20 工作日报\n昨天内容');
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

  it('replaces a complete section by inserting the new version before deleting old top-level blocks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-lark-replace-'));
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
          sinks: [{ type: 'lark', document: 'doc-token', executable, mode: 'section-append' }],
        },
      },
    });
    const job = config.jobs['dev-log']!;
    const context: RunContext = {
      jobName: 'dev-log', job, date: '2026-07-26', timezone: config.timezone,
      dryRun: false, force: false,
    };
    const sink = new LarkSink();
    const snapshot = await sink.inspect(context, job.sinks[0]!);

    await sink.apply(context, job.sinks[0]!, {
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

  it('does not duplicate an append whose dated heading is already present', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-lark-idempotent-'));
    const executable = join(directory, 'fake-lark.sh');
    const logPath = join(directory, 'args.log');
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' '---' "$@" >> "$CAPTURE_LOG"
case " $* " in
  *" --scope full "*)
    printf '%s\\n' '{"ok":true,"data":{"document":{"content":"# Doc","revision_id":7}}}'
    ;;
  *" --scope outline "*)
    printf '%s\\n' '{"ok":true,"data":{"document":{"content":"<fragment><h2 id=\\"req\\">二、需求开发记录</h2><h3 id=\\"task\\">REQ-004｜任务</h3><h4 id=\\"changes\\">变更记录</h4></fragment>","revision_id":7}}}'
    ;;
  *" --scope section "*)
    printf '%s\\n' '{"ok":true,"data":{"document":{"content":"<fragment><h4 id=\\"changes\\">变更记录</h4><h5 id=\\"existing\\">2026-07-26｜接口 <code>not found</code> 修复</h5><p id=\\"body\\">Done</p></fragment>","revision_id":7}}}'
    ;;
  *" +update "*)
    printf invoked
    exit 99
    ;;
esac
`);
    await chmod(executable, 0o755);
    process.env.CAPTURE_LOG = logPath;
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
    const job = config.jobs['dev-log']!;
    const context: RunContext = {
      jobName: 'dev-log', job, date: '2026-07-26', timezone: config.timezone,
      dryRun: false, force: false,
    };
    const sink = new LarkSink();
    const snapshot = await sink.inspect(context, job.sinks[0]!);
    const result = await sink.apply(context, job.sinks[0]!, {
      kind: 'records',
      records: [{
        section: 'requirement',
        targetRef: 'h3',
        operation: 'append',
        role: 'change-log',
        markdown: '##### 2026-07-26｜接口 `not found` 修复\nDone\n',
      }],
    }, snapshot);

    expect(result.updates).toEqual([
      expect.objectContaining({ applied: false, alreadyApplied: true }),
    ]);
    expect(await readFile(logPath, 'utf8')).not.toContain('+update');
  });

  it('uses the legacy larkparser fast reader when configured', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-larkparser-'));
    const lark = join(directory, 'fake-lark.sh');
    const parser = join(directory, 'fake-parser.sh');
    const parserArgs = join(directory, 'parser-args.log');
    await writeFile(lark, `#!/bin/sh
case " $* " in
  *" --scope outline "*)
    printf '%s\n' '{"ok":true,"data":{"document":{"content":"<fragment><h2 id=\\"req\\">一、需求开发记录</h2></fragment>","revision_id":7}}}'
    ;;
esac
`);
    await writeFile(parser, `#!/bin/sh
printf '%s\n' "$@" > "${parserArgs}"
printf '# Legacy fast Markdown\n'
`);
    await chmod(lark, 0o755);
    await chmod(parser, 0o755);
    process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN = 'test-token';
    process.env.LARKSUITE_CLI_APP_ID = 'test-app';
    const config = internFlowConfigSchema.parse({
      version: 1,
      timezone: 'Asia/Shanghai',
      jobs: {
        'dev-log': {
          enabled: true,
          template: 'dev-log',
          schedule: { time: '23:45', days: ['wed'] },
          source: { type: 'codex' },
          generator: { type: 'codex', model: null },
          sinks: [{
            type: 'lark', document: 'https://example.com/docx/token', executable: lark,
            reader: 'larkparser', parserExecutable: parser, mode: 'section-append',
          }],
        },
      },
    });
    const job = config.jobs['dev-log']!;
    const context: RunContext = {
      jobName: 'dev-log', job, date: '2026-07-15', timezone: config.timezone,
      dryRun: true, force: false,
    };

    const snapshot = await new LarkSink().inspect(context, job.sinks[0]!);

    expect(snapshot.markdown).toBe('# Legacy fast Markdown');
    expect(await readFile(parserArgs, 'utf8')).toBe(
      'fetch\nhttps://example.com/docx/token\n--mode\nfast\n',
    );
  });

  it('falls back to lark-cli when the configured larkparser reader fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-larkparser-fallback-'));
    const lark = join(directory, 'fake-lark.sh');
    const parser = join(directory, 'fake-parser.sh');
    await writeFile(lark, `#!/bin/sh
case " $* " in
  *" --scope full "*)
    printf '%s\n' '{"ok":true,"data":{"document":{"content":"# Fallback Markdown","revision_id":7}}}'
    ;;
  *" --scope outline "*)
    printf '%s\n' '{"ok":true,"data":{"document":{"content":"<fragment><h2 id=\\"req\\">一、需求开发记录</h2></fragment>","revision_id":7}}}'
    ;;
esac
`);
    await writeFile(parser, '#!/bin/sh\nexit 3\n');
    await chmod(lark, 0o755);
    await chmod(parser, 0o755);
    process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN = 'test-token';
    process.env.LARKSUITE_CLI_APP_ID = 'test-app';
    const config = internFlowConfigSchema.parse({
      version: 1,
      timezone: 'Asia/Shanghai',
      jobs: {
        'dev-log': {
          enabled: true,
          template: 'dev-log',
          schedule: { time: '23:45', days: ['wed'] },
          source: { type: 'codex' },
          generator: { type: 'codex', model: null },
          sinks: [{
            type: 'lark', document: 'doc-token', executable: lark,
            reader: 'larkparser', parserExecutable: parser, mode: 'section-append',
          }],
        },
      },
    });
    const job = config.jobs['dev-log']!;
    const snapshot = await new LarkSink().inspect({
      jobName: 'dev-log', job, date: '2026-07-15', timezone: config.timezone,
      dryRun: true, force: false,
    }, job.sinks[0]!);

    expect(snapshot.markdown).toBe('# Fallback Markdown');
    expect(snapshot.revisionId).toBe(7);
  });

  it('builds a history-replace preview without invoking the remote CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-lark-history-preview-'));
    const reports = join(directory, 'reports');
    const executable = join(directory, 'fake-lark.sh');
    const invokedPath = join(directory, 'invoked');
    await mkdir(reports);
    await writeFile(join(reports, '2026-07-14.md'), '# 2026-07-14\n\n旧日报\n');
    await writeFile(executable, '#!/bin/sh\nprintf invoked > "$INVOKED_PATH"\nexit 99\n');
    await chmod(executable, 0o755);
    process.env.INVOKED_PATH = invokedPath;

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
          sinks: [
            { type: 'markdown', directory: reports, filename: '{date}.md', archive: true },
            {
              type: 'lark', document: 'doc-token', executable,
              mode: 'history-replace', identity: 'user', title: 'Codex 日报',
            },
          ],
        },
      },
    });
    const job = config.jobs['daily-report'];
    expect(job).toBeDefined();
    if (!job) return;
    const sinkConfig = job.sinks[1];
    expect(sinkConfig).toBeDefined();
    if (!sinkConfig) return;
    const context: RunContext = {
      jobName: 'daily-report', job, date: '2026-07-15', timezone: config.timezone,
      dryRun: true, force: false,
    };

    const result = await new LarkSink().apply(context, sinkConfig, {
      kind: 'markdown',
      markdown: '# 2026-07-15\n\n今天日报\n',
    });

    expect(result).toMatchObject({
      sink: 'lark', mode: 'history-replace', applied: false, reportCount: 2,
    });
    await expect(access(invokedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(reports, '2026-07-15.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes history with current Markdown flags and rendered Mermaid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-lark-history-'));
    const reports = join(directory, 'reports');
    const executable = join(directory, 'fake-lark.sh');
    const argsPath = join(directory, 'args.log');
    const inputPath = join(directory, 'input.md');
    await mkdir(reports);
    await writeFile(executable, `#!/bin/sh
printf '%s\n' '---' "$@" >> "$CAPTURE_LOG"
case " $* " in
  *" +fetch "*)
    printf '%s\n' '{"ok":true,"data":{"document":{"content":"# 2026-07-15\\n\\n今天日报\\n\\n# 2026-07-14\\n\\n昨天日报\\n","revision_id":8}}}'
    ;;
  *)
    printf '%s\n' '---' >> "$CAPTURE_INPUT"
    cat >> "$CAPTURE_INPUT"
    printf '%s\n' '{"ok":true,"data":{"result":"success","document":{"revision_id":8}}}'
    ;;
esac
`);
    await chmod(executable, 0o755);
    process.env.CAPTURE_LOG = argsPath;
    process.env.CAPTURE_INPUT = inputPath;
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    process.env.INTERNFLOW_LARK_CHUNK_DELAY_MS = '0';
    const config = internFlowConfigSchema.parse({
      version: 1,
      timezone: 'Asia/Shanghai',
      jobs: {
        'daily-report': {
          enabled: true,
          template: 'daily-report',
          schedule: { time: '23:30', days: ['wed'] },
          source: { type: 'codex' },
          generator: { type: 'codex', model: null },
          sinks: [
            { type: 'markdown', directory: reports, filename: '{date}.md', archive: true },
            {
              type: 'lark', document: 'doc-token', executable,
              mode: 'history-replace', identity: 'user', title: 'Codex 日报',
            },
          ],
        },
      },
    });
    const job = config.jobs['daily-report']!;

    await new LarkSink().apply({
      jobName: 'daily-report', job, date: '2026-07-15', timezone: config.timezone,
      dryRun: false, force: false,
    }, job.sinks[1]!, {
      kind: 'markdown',
      markdown: '# 2026-07-15\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n# 2026-07-14\n\n昨天日报\n',
    });

    const args = await readFile(argsPath, 'utf8');
    const input = await readFile(inputPath, 'utf8');
    expect(args).toContain('--command\noverwrite\n--doc-format\nmarkdown\n--content\n-');
    expect(args).toContain('--command\nappend\n--doc-format\nmarkdown\n--content\n-');
    expect(args).not.toContain('--mode');
    expect(input).toContain('<title>Codex 日报</title>');
    expect(input).toContain('<whiteboard type="mermaid">\nflowchart LR\n  A --> B\n</whiteboard>');
    expect(input).toContain('# 2026-07-14\n昨天日报');
    expect(input).not.toContain('```mermaid');
  });

  it('publishes docx history with parser auth and chunked lark-cli writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-larkparser-history-'));
    const reports = join(directory, 'reports');
    const lark = join(directory, 'fake-lark.sh');
    const parser = join(directory, 'fake-parser.sh');
    const larkArgsPath = join(directory, 'lark-args.log');
    const inputPath = join(directory, 'input.md');
    const authPath = join(directory, 'auth.log');
    const parserInvokedPath = join(directory, 'parser-invoked');
    const insertedPath = join(directory, 'inserted');
    await mkdir(reports);
    await writeFile(lark, `#!/bin/sh
printf '%s\n' "$@" >> "${larkArgsPath}"
printf '%s:%s' "$LARKSUITE_CLI_APP_ID" "$LARKSUITE_CLI_USER_ACCESS_TOKEN" > "${authPath}"
case " $* " in
  *" +fetch "*)
    if [ -f "${insertedPath}" ]; then
      printf '%s\n' '{"ok":true,"data":{"document":{"content":"# 2026-07-15 工作日报\\n\\n今天日报\\n","revision_id":2}}}'
    else
      printf '%s\n' '{"ok":true,"data":{"document":{"content":"","revision_id":1}}}'
    fi
    ;;
  *)
    cat >> "${inputPath}"
    printf inserted > "${insertedPath}"
    printf '%s\n' '{"ok":true,"data":{"result":"success","document":{"revision_id":2}}}'
    ;;
esac
`);
    await writeFile(parser, `#!/bin/sh
printf invoked > "${parserInvokedPath}"
exit 99
`);
    await chmod(lark, 0o755);
    await chmod(parser, 0o755);
    process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
    process.env.INTERNFLOW_LARK_CHUNK_DELAY_MS = '0';
    process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN = 'test-token';
    process.env.LARKSUITE_CLI_APP_ID = 'test-app';
    const config = internFlowConfigSchema.parse({
      version: 1,
      timezone: 'Asia/Shanghai',
      jobs: {
        'daily-report': {
          enabled: true,
          template: 'daily-report',
          schedule: { time: '23:30', days: ['wed'] },
          source: { type: 'codex' },
          generator: { type: 'codex', model: null },
          sinks: [
            { type: 'markdown', directory: reports, filename: '{date}.md', archive: true },
            {
              type: 'lark', document: 'https://example.com/docx/doc-token-123456',
              executable: lark, parserExecutable: parser,
              mode: 'history-replace', identity: 'user', title: 'Codex 日报',
            },
          ],
        },
      },
    });
    const job = config.jobs['daily-report']!;

    const result = await new LarkSink().apply({
      jobName: 'daily-report', job, date: '2026-07-15', timezone: config.timezone,
      dryRun: false, force: false,
    }, job.sinks[1]!, {
      kind: 'markdown', markdown: '# 2026-07-15 工作日报\n\n今天日报\n',
    });

    const args = await readFile(larkArgsPath, 'utf8');
    expect(args).toContain('--command\nblock_insert_after\n--block-id\n0');
    expect(args).toContain('+fetch\n--api-version\nv2');
    expect(await readFile(authPath, 'utf8')).toBe('test-app:test-token');
    expect(await readFile(inputPath, 'utf8')).toContain('# 2026-07-15 工作日报');
    await expect(access(parserInvokedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result).toMatchObject({ applied: true, reportCount: 1 });
  });
});
