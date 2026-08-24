import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStarterConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/contracts/index.js';
import { CodexSource } from '../src/sessions/codex/index.js';

describe('CodexSource capture', () => {
  it('finds an old session file, slices today, de-duplicates messages, and removes rolled-back work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-precise-'));
    const oldDirectory = join(root, '2026', '07', '10');
    await mkdir(oldDirectory, { recursive: true });
    await writeFile(join(oldDirectory, 'rollout-old.jsonl'), lines([
      event('2026-07-10T01:00:00.000Z', 'session_meta', {
        id: 'old-session', cwd: '/workspace/api', git: { branch: 'feat/api' },
      }),
      message('2026-07-10T01:01:00.000Z', 'user', '昨天开始实现 TypeScript API'),
      message('2026-07-10T01:02:00.000Z', 'assistant', '昨天完成了接口骨架'),
      message('2026-07-15T01:00:00.000Z', 'user', '修复 TypeScript API bug'),
      event('2026-07-15T01:00:00.500Z', 'event_msg', {
        type: 'user_message', message: '修复 TypeScript API bug',
      }),
      customCall('2026-07-15T01:01:00.000Z', 'old-call', 'apply_patch', 'old change'),
      customOutput('2026-07-15T01:01:01.000Z', 'old-call', 'M  src/rolled-back.ts'),
      event('2026-07-15T01:02:00.000Z', 'event_msg', { type: 'thread_rolled_back', num_turns: 1 }),
      message('2026-07-15T01:03:00.000Z', 'user', '重新实现 TypeScript API 修复'),
      message('2026-07-15T01:04:00.000Z', 'assistant', '修复已经完成并通过测试'),
      customCall('2026-07-15T01:05:00.000Z', 'new-call', 'apply_patch', 'new change'),
      customOutput('2026-07-15T01:05:01.000Z', 'new-call', 'M  src/final.ts\nExit code: 0'),
      event('2026-07-15T01:06:00.000Z', 'event_msg', { type: 'context_compacted' }),
      message('2026-07-15T01:06:30.000Z', 'user', '开始一个随后被中断的尝试'),
      event('2026-07-15T01:07:00.000Z', 'event_msg', {
        type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted',
      }),
    ]));

    const context = runContext();
    const precise = await new CodexSource().collect(context, {
      type: 'codex', captureMode: 'precise', sessionsDir: root,
    });

    expect(precise.sourceCount).toBe(1);
    expect(precise.activities[0]).toMatchObject({
      id: 'old-session',
      continuedFromPreviousDate: true,
      userMessages: ['重新实现 TypeScript API 修复'],
      changedFiles: ['src/final.ts'],
      previousContext: {
        userMessage: '昨天开始实现 TypeScript API',
        assistantMessage: '昨天完成了接口骨架',
      },
      capture: {
        mode: 'precise',
        coverage: 'partial',
        duplicateCount: 1,
        rollbackCount: 1,
        abortedTurnCount: 1,
        compactionCount: 1,
      },
    });
    expect(precise.activities[0]?.commands).toHaveLength(1);
    expect(precise.activities[0]?.commands[0]?.output).toContain('src/final.ts');
    expect(JSON.stringify(precise.activities[0])).not.toContain('rolled-back.ts');
    expect(precise.captureSnapshot?.evidence.length).toBeGreaterThan(0);
    expect(precise).not.toHaveProperty('workItems');
    expect(precise).not.toHaveProperty('dailyView');
  });

  it('merges a child agent tool trail into its parent session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-subagent-'));
    const directory = join(root, '2026', '07', '15');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'parent.jsonl'), lines([
      event('2026-07-15T02:00:00.000Z', 'session_meta', {
        id: 'parent', cwd: '/workspace/app', git: { branch: 'feat/app' },
      }),
      message('2026-07-15T02:01:00.000Z', 'user', '修复 React component bug'),
      message('2026-07-15T02:04:00.000Z', 'assistant', '父任务完成'),
    ]));
    await writeFile(join(directory, 'child.jsonl'), lines([
      event('2026-07-15T02:01:30.000Z', 'session_meta', {
        id: 'child', cwd: '/workspace/app', parent_thread_id: 'parent',
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
      }),
      customCall('2026-07-15T02:02:00.000Z', 'child-call', 'apply_patch', 'child change'),
      customOutput('2026-07-15T02:06:00.000Z', 'child-call', 'M  src/child.ts\nExit code: 0'),
    ]));

    const result = await new CodexSource().collect(runContext(), {
      type: 'codex', captureMode: 'precise', sessionsDir: root,
    });

    expect(result.sourceCount).toBe(1);
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]?.id).toBe('parent');
    expect(result.activities[0]).toMatchObject({
      startedAt: '2026-07-15T02:01:00.000Z',
      endedAt: '2026-07-15T02:06:00.000Z',
      durationMinutes: 5,
      observedSpanMinutes: 5,
    });
    expect(result.activities[0]?.changedFiles).toContain('src/child.ts');
    expect(result.activities[0]?.commands.some((command) => command.command.includes('apply_patch'))).toBe(true);
  });

  it('keeps all messages in the audit activity while exposing prompt compaction separately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-complete-'));
    const directory = join(root, '2026', '07', '15');
    await mkdir(directory, { recursive: true });
    const events = [event('2026-07-15T03:00:00.000Z', 'session_meta', {
      id: 'long-session', cwd: '/workspace/app',
    })];
    for (let index = 0; index < 12; index += 1) {
      events.push(message(`2026-07-15T03:${String(index + 1).padStart(2, '0')}:00.000Z`, 'user', `开发 src/app.ts TypeScript 功能 ${index}`));
    }
    await writeFile(join(directory, 'long.jsonl'), lines(events));

    const result = await new CodexSource().collect(runContext(), {
      type: 'codex', captureMode: 'precise', sessionsDir: root,
    });

    expect(result.activities[0]?.userMessages).toHaveLength(12);
    expect(result.activities[0]?.capture?.truncatedCount).toBe(0);
  });

  it('extracts the real request from IDE context and projects tool search activity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-ide-tool-search-'));
    const directory = join(root, '2026', '07', '15');
    await mkdir(directory, { recursive: true });
    const ideMessage = [
      '# Context from my IDE setup:',
      '## Active file: src/app.ts',
      '## Open tabs:',
      '- app.ts',
      '## My request for Codex:',
      '查找并修复 src/app.ts 登录接口',
    ].join('\n');
    await writeFile(join(directory, 'session.jsonl'), lines([
      event('2026-07-15T03:00:00.000Z', 'session_meta', { id: 'session', cwd: '/workspace/app' }),
      message('2026-07-15T03:01:00.000Z', 'user', ideMessage),
      toolSearchCall('2026-07-15T03:02:00.000Z', 'search-1', 'repository search'),
      toolSearchOutput('2026-07-15T03:02:01.000Z', 'search-1', ['codegraph', 'search']),
      message('2026-07-15T03:03:00.000Z', 'assistant', '已经找到登录接口'),
    ]));

    const result = await new CodexSource().collect(runContext(), {
      type: 'codex', captureMode: 'precise', sessionsDir: root,
    });

    expect(result.activities[0]?.userMessages).toEqual(['查找并修复 src/app.ts 登录接口']);
    expect(result.activities[0]?.commands[0]).toMatchObject({
      command: 'tool_search repository search',
      exitCode: 0,
    });
    expect(result.activities[0]?.commands[0]?.output).toContain('codegraph, search');
    expect(result.captureSnapshot?.evidence.find((item) => item.kind === 'request')?.summary)
      .toBe('查找并修复 src/app.ts 登录接口');
    expect(result.captureSnapshot?.quality.unsupported).toBe(0);
  });

  it('keeps project-specific title rewrites out of capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-title-boundary-'));
    const directory = join(root, '2026', '07', '15');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.jsonl'), lines([
      event('2026-07-15T03:00:00.000Z', 'session_meta', { id: 'session', cwd: '/workspace/app' }),
      message('2026-07-15T03:01:00.000Z', 'user', '继续分析 src/tool.ts 开发工具'),
      message('2026-07-15T03:02:00.000Z', 'assistant', '这里提到了 Superpower Skill 工作流。'),
    ]));

    const precise = await new CodexSource().collect(runContext(), {
      type: 'codex', captureMode: 'precise', sessionsDir: root,
    });
    expect(precise.activities[0]?.title).toBe('继续分析 src/tool.ts 开发工具');
  });

  it('keeps duration reliable after a precisely detected replay burst is removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-replay-duration-'));
    const directory = join(root, '2026', '07', '15');
    await mkdir(directory, { recursive: true });
    const events = [event('2026-07-15T04:00:00.000Z', 'session_meta', {
      id: 'replayed-session', cwd: '/workspace/app',
    })];
    for (let index = 0; index < 6; index += 1) {
      events.push(message('2026-07-15T04:00:01.000Z', 'user', `恢复的历史消息 ${index}`));
    }
    events.push(message('2026-07-15T04:01:00.000Z', 'user', '继续修复 src/app.ts 构建问题'));
    events.push(message('2026-07-15T04:06:00.000Z', 'assistant', '构建问题已经修复'));
    await writeFile(join(directory, 'replayed.jsonl'), lines(events));

    const result = await new CodexSource().collect(runContext(), {
      type: 'codex', captureMode: 'precise', sessionsDir: root,
    });

    expect(result.activities[0]).toMatchObject({
      hadReplayBurst: true,
      durationReliable: true,
      durationMinutes: 5,
      userMessages: ['继续修复 src/app.ts 构建问题'],
      capture: { replayDroppedCount: 6 },
    });
    expect(result.activities[0]?.durationReason).toContain('已先排除上下文恢复/重放事件');
  });
});

function runContext(): RunContext {
  const job = createStarterConfig().jobs['daily-report'];
  if (!job) throw new Error('Missing daily-report job');
  return {
    jobName: 'daily-report', job, date: '2026-07-15', timezone: 'Asia/Shanghai', dryRun: true, force: false,
  };
}

function message(timestamp: string, role: 'user' | 'assistant', text: string): string {
  return event(timestamp, 'response_item', { type: 'message', role, content: [{ text }] });
}

function customCall(timestamp: string, callId: string, name: string, input: string): string {
  return event(timestamp, 'response_item', { type: 'custom_tool_call', call_id: callId, name, input });
}

function customOutput(timestamp: string, callId: string, output: string): string {
  return event(timestamp, 'response_item', { type: 'custom_tool_call_output', call_id: callId, output });
}

function toolSearchCall(timestamp: string, callId: string, query: string): string {
  return event(timestamp, 'response_item', {
    type: 'tool_search_call', call_id: callId, status: 'completed', arguments: { query, limit: 8 },
  });
}

function toolSearchOutput(timestamp: string, callId: string, names: string[]): string {
  return event(timestamp, 'response_item', {
    type: 'tool_search_output',
    call_id: callId,
    status: 'completed',
    tools: [{ type: 'namespace', name: names[0], tools: names.slice(1).map((name) => ({ type: 'function', name })) }],
  });
}

function event(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

function lines(events: string[]): string {
  return `${events.join('\n')}\n`;
}
