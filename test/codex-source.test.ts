import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStarterConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/contracts/index.js';
import { CodexSource } from '../src/sessions/codex/index.js';
import { discoverSessionFiles } from '../src/sessions/codex/storage/files.js';

describe('CodexSource', () => {
  it('discovers active and archived sessions without counting the same rollout twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-session-roots-'));
    const active = join(root, 'sessions');
    const archived = join(root, 'archived_sessions');
    await mkdir(active);
    await mkdir(archived);
    await writeFile(join(active, 'rollout-active.jsonl'), '{}\n');
    await writeFile(join(active, 'rollout-moving.jsonl'), '{}\n');
    await writeFile(join(archived, 'rollout-archived.jsonl'), '{}\n');
    await writeFile(join(archived, 'rollout-moving.jsonl'), '{}\n');

    const files = await discoverSessionFiles([active, archived], '2026-07-15');

    expect(files).toHaveLength(3);
    expect(files).toContain(join(active, 'rollout-moving.jsonl'));
    expect(files).not.toContain(join(archived, 'rollout-moving.jsonl'));
  });

  it('parses current custom tool calls and patch changes without leaking secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-sessions-'));
    const directory = join(root, '2026', '07', '15');
    await mkdir(directory, { recursive: true });
    const events = [
      event('2026-07-15T01:00:00.000Z', 'session_meta', {
        id: 'session-1',
        cwd: '/workspace/project',
        git: { branch: 'feat/test' },
      }),
      event('2026-07-15T01:00:01.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ text: '# AGENTS.md instructions\nignored' }],
      }),
      event('2026-07-15T01:00:02.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ text: '修复 TypeScript component bug' }],
      }),
      event('2026-07-15T01:00:03.000Z', 'response_item', {
        type: 'message', role: 'assistant', content: [{ text: 'Using {"client_secret":"json-secret"}' }],
      }),
      event('2026-07-15T01:01:00.000Z', 'response_item', {
        type: 'custom_tool_call', name: 'exec', call_id: 'call-1', input: 'hidden command',
      }),
      event('2026-07-15T01:01:01.000Z', 'response_item', {
        type: 'custom_tool_call_output',
        call_id: 'call-1',
        output: [
          'token=top-secret build passed',
          'WORKSPACE_TOKEN=env-secret',
          'AWS_SECRET_ACCESS_KEY=aws-secret-access-key',
          'SSH_PRIVATE_KEY=ssh-private-key',
          'sk-example-openai-key',
          'AKIAIOSFODNN7EXAMPLE',
          'ghp_123456789012345678901234567890123456',
          'https://example.com/run?signature=url-secret',
          'https://url-user:url-password@example.com/private',
          'Cookie: session=cookie-secret',
          '-----BEGIN PRIVATE KEY-----',
          'pem-secret',
          '-----END PRIVATE KEY-----',
        ].join('\n'),
      }),
      event('2026-07-15T01:02:00.000Z', 'event_msg', {
        type: 'patch_apply_end', changes: { '/workspace/project/src/app.ts': { type: 'update' } },
      }),
      event('2026-07-15T01:03:00.000Z', 'event_msg', {
        type: 'exec_command_end',
        command: ['git', 'status', '--short'],
        cwd: '/workspace/project',
        exit_code: 0,
        aggregated_output: 'M  src/app.ts\ntoken=legacy-secret',
      }),
      '{broken json',
    ];
    await writeFile(join(directory, 'rollout-session-1.jsonl'), `${events.join('\n')}\n`);
    await writeFile(
      join(root, 'index.jsonl'),
      '{"id":"session-1","thread_name":"Fix app?token=title-secret"}\n',
    );
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
    };

    const result = await new CodexSource().collect(context, {
      type: 'codex',
      sessionsDir: root,
      sessionIndex: join(root, 'index.jsonl'),
      includeAssistantMessages: true,
      includeToolOutput: true,
    });

    expect(result.sourceCount).toBe(1);
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]?.title).toBe('Fix app?token=[REDACTED]');
    expect(result.activities[0]?.userMessages).toEqual(['修复 TypeScript component bug']);
    expect(result.activities[0]?.assistantMessages).toEqual([
      'Using {"client_secret":"[REDACTED]"}',
    ]);
    expect(result.activities[0]?.changedFiles).toEqual(['src/app.ts']);
    expect(result.activities[0]?.commands[0]?.output).toContain('token=[REDACTED]');
    const serialized = JSON.stringify(result.activities[0]);
    for (const secret of [
      'top-secret',
      'legacy-secret',
      'env-secret',
      'aws-secret-access-key',
      'ssh-private-key',
      'example-openai-key',
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_123456789012345678901234567890123456',
      'url-secret',
      'url-user',
      'url-password',
      'cookie-secret',
      'pem-secret',
      'json-secret',
      'title-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }

    const privateResult = await new CodexSource().collect(context, {
      type: 'codex',
      sessionsDir: root,
      sessionIndex: join(root, 'index.jsonl'),
      includeAssistantMessages: false,
      includeToolOutput: false,
    });
    expect(privateResult.activities[0]?.assistantMessages).toEqual([]);
    expect(privateResult.activities[0]?.commands.every((command) => command.output === '')).toBe(true);
  });
});

function event(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}
