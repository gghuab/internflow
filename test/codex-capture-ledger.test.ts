import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureCodexDay } from '../src/sessions/codex/capture/capture.js';
import { readJsonlFile } from '../src/sessions/codex/storage/reader.js';
import {
  buildSessionManifest,
  loadCodexSourceCache,
  refreshSessionManifest,
  saveCodexSourceCache,
} from '../src/sessions/codex/storage/source-cache.js';

describe('Codex event ledger', () => {
  it('finalizes the current workday at the configured 23:30 cutoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-cutoff-'));
    const directory = join(root, '2026', '07', '16');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.jsonl'), lines([
      event('2026-07-16T15:00:00.000Z', 'session_meta', { id: 'session' }),
      message('2026-07-16T15:01:00.000Z', 'user', '当天工作'),
    ]));

    const before = await captureCodexDay(
      root,
      '2026-07-16',
      'Asia/Shanghai',
      new Date('2026-07-16T23:29:00+08:00'),
      { finalizationCutoff: '23:30' },
    );
    const atCutoff = await captureCodexDay(
      root,
      '2026-07-16',
      'Asia/Shanghai',
      new Date('2026-07-16T23:30:00+08:00'),
      { finalizationCutoff: '23:30' },
    );

    expect(before.snapshot.finalized).toBe(false);
    expect(atCutoff.snapshot).toMatchObject({
      finalized: true,
      finalizationBasis: 'configured-cutoff',
    });
  });

  it('captures structured verification details and traceable patch excerpts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-evidence-details-'));
    const directory = join(root, '2026', '07', '16');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.jsonl'), lines([
      event('2026-07-16T01:00:00.000Z', 'session_meta', { id: 'session', cwd: '/workspace/app' }),
      customCall('2026-07-16T01:01:00.000Z', 'patch', 'functions.exec', `const patch = ${JSON.stringify([
        '*** Begin Patch',
        '*** Update File: /workspace/app/src/app.ts',
        '@@',
        '+export const ready = true;',
        '*** End Patch',
      ].join('\n'))}; text(await tools.apply_patch(patch));`),
      customOutput('2026-07-16T01:01:01.000Z', 'patch', 'Done!'),
      customCall('2026-07-16T01:02:00.000Z', 'test', 'exec_command', JSON.stringify({ cmd: 'npm test' })),
      customOutput('2026-07-16T01:02:01.000Z', 'test', 'Exit code: 0'),
    ]));

    const capture = await captureCodexDay(root, '2026-07-16', 'Asia/Shanghai');
    const change = capture.snapshot.evidence.find((item) => item.kind === 'change');
    const verification = capture.snapshot.evidence.find((item) => item.kind === 'verification');

    expect(change?.codeExcerpts?.[0]).toMatchObject({
      file: 'src/app.ts',
      content: 'export const ready = true;',
      sourceEventId: expect.any(String),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(verification?.verification).toEqual({ command: 'npm test', exitCode: 0, outcome: 'passed' });
    expect(capture.snapshot.evidence.filter((item) => item.verification)).toHaveLength(1);
  });

  it('accounts for tool search calls and outputs as supported paired events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-tool-search-'));
    const directory = join(root, '2026', '07', '16');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.jsonl'), lines([
      event('2026-07-16T02:00:00.000Z', 'session_meta', { id: 'session', cwd: '/workspace/app' }),
      message('2026-07-16T02:01:00.000Z', 'user', '查找浏览器工具'),
      toolSearchCall('2026-07-16T02:02:00.000Z', 'search-1', 'browser screenshot'),
      toolSearchOutput('2026-07-16T02:02:01.000Z', 'search-1', ['browser', 'screenshot']),
    ]));

    const capture = await captureCodexDay(root, '2026-07-16', 'Asia/Shanghai');
    const toolEvents = capture.events.filter((item) => item.callId === 'search-1');

    expect(toolEvents.map((item) => item.kind)).toEqual(['tool_call', 'tool_output']);
    expect(toolEvents.every((item) => item.disposition === 'included')).toBe(true);
    expect(capture.snapshot.quality).toMatchObject({
      unsupported: 0,
      orphanToolOutputs: 0,
      accountingDifference: 0,
    });
  });

  it('accounts for duplicate, rollback and aborted events without deleting their audit trail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-ledger-'));
    const directory = join(root, '2026', '07', '10');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'parent.jsonl'), lines([
      event('2026-07-10T01:00:00.000Z', 'session_meta', {
        id: 'parent', cwd: '/workspace/app', git: { branch: 'feat/app' },
      }),
      message('2026-07-15T01:00:00.000Z', 'user', '实现 src/app.ts 数据源'),
      event('2026-07-15T01:00:00.500Z', 'event_msg', {
        type: 'user_message', message: '实现 src/app.ts 数据源',
      }),
      customCall('2026-07-15T01:01:00.000Z', 'test-1', 'exec', 'npm test'),
      customOutput('2026-07-15T01:01:01.000Z', 'test-1', 'Exit code: 1'),
      customCall('2026-07-15T01:02:00.000Z', 'test-2', 'exec', 'npm test'),
      customOutput('2026-07-15T01:02:01.000Z', 'test-2', 'Exit code: 0'),
      message('2026-07-15T01:03:00.000Z', 'user', '尝试修改中断方案'),
      customCall('2026-07-15T01:03:01.000Z', 'abort-patch', 'apply_patch', 'M src/aborted.ts'),
      event('2026-07-15T01:03:02.000Z', 'event_msg', { type: 'turn_aborted' }),
      message('2026-07-15T01:04:00.000Z', 'user', '尝试修改回滚方案'),
      customCall('2026-07-15T01:04:01.000Z', 'rollback-patch', 'apply_patch', 'M src/rolled.ts'),
      event('2026-07-15T01:04:02.000Z', 'event_msg', { type: 'thread_rolled_back', num_turns: 1 }),
      '{broken json',
    ]));

    const capture = await captureCodexDay(
      root,
      '2026-07-15',
      'Asia/Shanghai',
      new Date('2026-07-16T00:20:00+08:00'),
    );
    const target = capture.events.filter((item) => item.localDate === '2026-07-15');

    expect(capture.snapshot.finalized).toBe(true);
    expect(capture.snapshot.quality).toMatchObject({
      accountingDifference: 0,
      duplicate: 1,
      aborted: 2,
      rolledBack: 2,
      invalidLines: 1,
    });
    expect(target.filter((item) => item.kind === 'tool_call' && item.payloadPreview.includes('npm test'))).toHaveLength(2);
    expect(capture.snapshot.evidence.filter((item) => item.kind === 'verification')).toHaveLength(1);
    expect(capture.snapshot.evidence.filter((item) => item.kind === 'error')).toHaveLength(1);
    expect(capture.snapshot.evidence.some((item) => item.summary.includes('aborted.ts'))).toBe(false);
    expect(capture.snapshot.evidence.some((item) => item.summary.includes('rolled.ts'))).toBe(false);
    expect(target.some((item) => item.lifecycle === 'aborted')).toBe(true);
    expect(target.some((item) => item.lifecycle === 'rolled_back')).toBe(true);
    const auditedIds = new Set(capture.snapshot.events.map((item) => item.occurrenceId));
    expect(capture.snapshot.evidence.flatMap((item) => item.sourceEventIds).every((id) => auditedIds.has(id))).toBe(true);
    expect(capture.snapshot.events.every((item) => item.source.lineSha256.length === 64)).toBe(true);
  });

  it('resolves a parent, child and grandchild to the same root even when the parent has no target-day event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-thread-graph-'));
    const directory = join(root, '2026', '07', '12');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'parent.jsonl'), lines([
      event('2026-07-12T01:00:00.000Z', 'session_meta', { id: 'parent', cwd: '/workspace/app' }),
    ]));
    await writeFile(join(directory, 'child.jsonl'), lines([
      event('2026-07-12T01:01:00.000Z', 'session_meta', { id: 'child', parent_thread_id: 'parent', cwd: '/workspace/app' }),
      message('2026-07-15T02:00:00.000Z', 'user', '子任务修改 src/child.ts'),
    ]));
    await writeFile(join(directory, 'grandchild.jsonl'), lines([
      event('2026-07-12T01:02:00.000Z', 'session_meta', { id: 'grandchild', parent_thread_id: 'child', cwd: '/workspace/app' }),
      customCall('2026-07-15T02:01:00.000Z', 'patch-1', 'apply_patch', 'M src/grandchild.ts'),
    ]));

    const capture = await captureCodexDay(root, '2026-07-15', 'Asia/Shanghai');
    const roots = new Set(
      capture.events
        .filter((item) => item.localDate === '2026-07-15')
        .map((item) => item.rootSessionId),
    );

    expect([...roots]).toEqual(['parent']);
    expect(capture.snapshot.quality.unresolvedParents).toEqual([]);
  });

  it('keeps byte provenance and quarantines an incomplete trailing line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-reader-'));
    const file = join(root, 'events.jsonl');
    const valid = event('2026-07-15T03:00:00.000Z', 'session_meta', { id: 'session' });
    await writeFile(file, `${valid}\n{"timestamp":"unfinished`);

    const result = await readJsonlFile(file);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.source).toMatchObject({ byteStart: 0, byteEnd: Buffer.byteLength(valid) + 1 });
    expect(result.records[0]?.source.lineSha256).toHaveLength(64);
    expect(result.invalid).toEqual([
      expect.objectContaining({ reason: 'incomplete_trailing_line' }),
    ]);
  });

  it('reuses a stable snapshot id and reports evidence that arrives after finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-capture-cache-'));
    const directory = join(root, '2026', '07', '15');
    const cacheFile = join(root, 'cache', 'snapshot.json');
    const file = join(directory, 'session.jsonl');
    await mkdir(directory, { recursive: true });
    await writeFile(file, lines([
      event('2026-07-15T05:00:00.000Z', 'session_meta', { id: 'session', cwd: '/workspace/app' }),
      message('2026-07-15T05:01:00.000Z', 'user', '实现 src/one.ts'),
    ]));

    const first = await captureCodexDay(
      root,
      '2026-07-15',
      'Asia/Shanghai',
      new Date('2026-07-16T00:20:00+08:00'),
      { cacheFile },
    );
    const unchanged = await captureCodexDay(
      root,
      '2026-07-15',
      'Asia/Shanghai',
      new Date('2026-07-16T00:21:00+08:00'),
      { cacheFile },
    );
    expect(unchanged.snapshot.id).toBe(first.snapshot.id);
    expect(unchanged.snapshot.lateEventCount).toBe(0);

    await appendFile(file, message('2026-07-15T05:02:00.000Z', 'user', '继续实现 src/two.ts') + '\n');
    const changed = await captureCodexDay(
      root,
      '2026-07-15',
      'Asia/Shanghai',
      new Date('2026-07-16T00:22:00+08:00'),
      { cacheFile },
    );
    expect(changed.snapshot.id).not.toBe(first.snapshot.id);
    expect(changed.snapshot.lateEventCount).toBe(1);
  });

  it('keeps a finalized cache when only a later date is appended and invalidates on late target events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-tail-cache-'));
    const file = join(root, 'session.jsonl');
    await writeFile(file, message('2026-07-15T05:00:00.000Z', 'user', '当天工作') + '\n');
    const initial = await buildSessionManifest([file]);

    await appendFile(file, message('2026-07-16T01:00:00.000Z', 'user', '第二天工作') + '\n');
    const laterDate = await buildSessionManifest([file]);
    expect(await refreshSessionManifest(initial, laterDate, '2026-07-15', 'Asia/Shanghai')).toEqual(laterDate);

    await appendFile(file, message('2026-07-15T15:59:59.000Z', 'user', '迟到写入') + '\n');
    const lateTarget = await buildSessionManifest([file]);
    expect(await refreshSessionManifest(laterDate, lateTarget, '2026-07-15', 'Asia/Shanghai')).toBeNull();
  });

  it('migrates a self-contained source cache to a snapshot reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-source-cache-'));
    const sourcePath = join(root, '2026-07-15.source.json');
    const capture = await captureCodexDay(
      root,
      '2026-07-15',
      'Asia/Shanghai',
      new Date('2026-07-16T00:20:00+08:00'),
    );
    const captureSummary = {
      mode: 'precise' as const, coverage: 'high' as const,
      rawEventCount: 0, relevantEventCount: 0, capturedEventCount: 0,
      duplicateCount: 0, replayDroppedCount: 0, rollbackCount: 0,
      abortedTurnCount: 0, compactionCount: 0, truncatedCount: 0,
      unhandledEventTypes: [], reasons: [],
    };
    await writeFile(sourcePath, JSON.stringify({
      version: 1,
      date: '2026-07-15', timezone: 'Asia/Shanghai', configKey: 'config', manifest: [],
      snapshot: capture.snapshot, captureSummary, sourceActivities: [],
    }));

    const loaded = await loadCodexSourceCache(sourcePath, {
      date: '2026-07-15', timezone: 'Asia/Shanghai', configKey: 'config',
    });
    expect(loaded?.snapshot.id).toBe(capture.snapshot.id);
    await saveCodexSourceCache(sourcePath, loaded!);

    const persisted = JSON.parse(await readFile(sourcePath, 'utf8'));
    expect(persisted).toMatchObject({ version: 2, snapshotId: capture.snapshot.id });
    expect(persisted).not.toHaveProperty('snapshot');
    expect(JSON.parse(await readFile(join(root, '2026-07-15.snapshot.json'), 'utf8')).id)
      .toBe(capture.snapshot.id);
  });
});

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
