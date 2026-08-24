import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src/core/persistence/artifacts.js';
import { internFlowConfigSchema } from '../src/core/config.js';
import { PluginRegistry } from '../src/core/runtime/registry.js';
import { runJob } from '../src/core/runtime/runner.js';
import { StateStore } from '../src/core/persistence/index.js';
import type {
  ActivityBatch,
  GeneratorPlugin,
  SinkPlugin,
  SourcePlugin,
} from '../src/core/contracts/index.js';

const DATE = '2026-07-15';

describe('runJob recovery', () => {
  it('reuses one immutable artifact after a later sink fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-runner-recovery-'));
    const state = new StateStore(join(directory, 'state.json'));
    const artifacts = new ArtifactStore({ rootDirectory: join(directory, 'audit') });
    const registry = new PluginRegistry();
    let sourceCalls = 0;
    let generatorCalls = 0;
    let failSecond = true;
    const applyCalls: string[] = [];
    const generated = { kind: 'markdown' as const, markdown: `# ${DATE}\n\nStable output\n` };

    registry.sources.set('codex', sourcePlugin(async () => {
      sourceCalls += 1;
      return activityBatch();
    }));
    registry.generators.set('codex', generatorPlugin(async () => {
      generatorCalls += 1;
      return generated;
    }));
    registry.sinks.set('markdown', sinkPlugin(async (_context, config, artifact) => {
      if (config.type !== 'markdown') throw new Error('Expected markdown config.');
      applyCalls.push(config.directory);
      expect(artifact).toEqual(generated);
      if (config.directory === 'second' && failSecond) {
        failSecond = false;
        throw new Error('second sink failed');
      }
      return { sink: 'markdown', target: config.directory };
    }));
    const config = testConfig(['first', 'second']);
    const notifications: string[] = [];
    const notify = async (message: string) => {
      notifications.push(message);
      return { sent: false as const, reason: 'unsupported_platform' as const };
    };

    await expect(runJob(config, 'daily-report', { date: DATE }, registry, state, artifacts, notify))
      .rejects.toThrow('second sink failed');
    const failedAudits = await artifacts.listDecisionAudits(DATE, 'daily-report');
    expect(failedAudits).toHaveLength(1);
    expect(JSON.parse(await readFile(failedAudits[0]!, 'utf8')).assessments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ policyId: 'runtime.sink-write', outcome: 'failed' }),
        expect.objectContaining({ policyId: 'runtime.execution', outcome: 'failed' }),
      ]),
    );
    expect(sourceCalls).toBe(1);
    expect(generatorCalls).toBe(1);
    expect(applyCalls).toEqual(['first', 'second']);

    const persisted = JSON.parse(await readFile(
      join(directory, 'runs', 'daily-report', DATE, 'artifact.json'),
      'utf8',
    ));
    expect(persisted.artifact).toEqual(generated);
    expect(Object.values(JSON.parse(await readFile(state.path, 'utf8')).sinks))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'applied', hash: persisted.hash }),
        expect.objectContaining({ status: 'pending', hash: persisted.hash }),
      ]));

    await expect(runJob(config, 'daily-report', { date: DATE }, registry, state, artifacts, notify))
      .rejects.toThrow('uncertain previous write');
    expect(sourceCalls).toBe(1);
    expect(generatorCalls).toBe(1);
    expect(applyCalls).toEqual(['first', 'second']);

    const resumed = await runJob(
      config,
      'daily-report',
      { date: DATE, force: true },
      registry,
      state,
      artifacts,
      notify,
    );
    expect(resumed.outputs).toEqual([
      { sink: 'markdown', skipped: true, reason: 'already_applied' },
      { sink: 'markdown', target: 'second' },
    ]);
    expect(JSON.parse(await readFile(resumed.decisionAuditPath!, 'utf8')).assessments).toEqual(
      expect.arrayContaining([expect.objectContaining({ policyId: 'runtime.recovery', outcome: 'forced' })]),
    );
    expect(sourceCalls).toBe(1);
    expect(generatorCalls).toBe(1);
    expect(applyCalls).toEqual(['first', 'second', 'second']);

    const repeated = await runJob(
      config,
      'daily-report',
      { date: DATE, force: true },
      registry,
      state,
      artifacts,
      notify,
    );
    expect(repeated.skipped).toBe(true);
    expect(repeated.outputs).toHaveLength(2);
    expect(sourceCalls).toBe(1);
    expect(generatorCalls).toBe(1);
    expect(applyCalls).toEqual(['first', 'second', 'second']);
    expect(notifications).toEqual(['second sink failed', expect.stringContaining('uncertain previous write')]);
  });

  it('does not create idempotency state for dry-run or empty input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-runner-dry-'));
    const state = new StateStore(join(directory, 'state.json'));
    const artifacts = new ArtifactStore({ rootDirectory: join(directory, 'audit') });
    const registry = new PluginRegistry();
    let empty = false;
    let generatorCalls = 0;
    let sinkCalls = 0;
    registry.sources.set('codex', sourcePlugin(async () => (
      empty ? { ...activityBatch(), sourceCount: 3, activities: [] } : activityBatch()
    )));
    registry.generators.set('codex', generatorPlugin(async () => {
      generatorCalls += 1;
      return { kind: 'markdown', markdown: `# ${DATE}\n` };
    }));
    registry.sinks.set('markdown', sinkPlugin(async (context) => {
      expect(context.dryRun).toBe(true);
      sinkCalls += 1;
      return { sink: 'markdown', preview: true };
    }));
    const config = testConfig(['only']);
    const notify = async () => ({ sent: false as const, reason: 'unsupported_platform' as const });

    const preview = await runJob(
      config,
      'daily-report',
      { date: DATE, dryRun: true },
      registry,
      state,
      artifacts,
      notify,
    );
    expect(preview.dryRun).toBe(true);
    expect(generatorCalls).toBe(1);
    expect(sinkCalls).toBe(1);
    expect(existsSync(state.path)).toBe(false);
    expect(existsSync(join(directory, 'runs', 'daily-report', DATE, 'artifact.json'))).toBe(false);
    expect(existsSync(artifacts.dailyInputPath(DATE))).toBe(true);
    expect(JSON.parse(await readFile(artifacts.dailyInputPath(DATE), 'utf8')))
      .not.toHaveProperty('captureSnapshot');
    expect(existsSync(artifacts.dailyReportDraftPath(DATE))).toBe(true);

    empty = true;
    const emptyResult = await runJob(
      config,
      'daily-report',
      { date: DATE, dryRun: true },
      registry,
      state,
      artifacts,
      notify,
    );
    expect(emptyResult).toMatchObject({ skipped: true, sourceCount: 3, activityCount: 0 });
    expect(generatorCalls).toBe(1);
    expect(sinkCalls).toBe(1);
    expect(existsSync(state.path)).toBe(false);
  });

  it('saves dev-log audit files and records both success and failure results', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-runner-dev-log-'));
    const state = new StateStore(join(directory, 'state.json'));
    const artifacts = new ArtifactStore({ rootDirectory: join(directory, 'audit') });
    const registry = new PluginRegistry();
    let failGeneration = false;
    const notifications: string[] = [];
    registry.sources.set('codex', sourcePlugin(async () => activityBatch()));
    registry.generators.set('codex', generatorPlugin(async () => {
      if (failGeneration) throw new Error('dev-log generation failed');
      return {
        kind: 'records',
        records: [{ section: 'requirement', targetRef: 'h1', markdown: 'New record\n' }],
      };
    }));
    registry.sinks.set('lark', {
      name: 'lark',
      async inspect() {
        return {
          markdown: '# Current document\n',
          headings: [{
            ref: 'h1',
            blockId: 'requirement',
            level: 2,
            text: '一、需求开发记录',
            section: 'requirement',
          }],
        };
      },
      async apply() {
        return { sink: 'lark', preview: true };
      },
      async doctor() {
        return { ok: true, message: 'test lark' };
      },
    });
    const config = internFlowConfigSchema.parse({
      version: 1,
      timezone: 'Asia/Shanghai',
      jobs: {
        'dev-log': {
          enabled: true,
          template: 'dev-log',
          schedule: { time: '23:45', days: ['wed'] },
          skipDates: [],
          source: { type: 'codex' },
          generator: { type: 'codex', model: 'test-model' },
          sinks: [{ type: 'lark', document: 'doc-token', mode: 'section-append' }],
        },
      },
    });
    const notify = async (message: string) => {
      notifications.push(message);
      return { sent: false as const, reason: 'unsupported_platform' as const };
    };

    const result = await runJob(
      config,
      'dev-log',
      { date: DATE, dryRun: true },
      registry,
      state,
      artifacts,
      notify,
    );
    expect(result.ok).toBe(true);
    const paths = artifacts.devLogPaths(DATE, true);
    expect(existsSync(artifacts.dailyInputPath(DATE))).toBe(false);
    expect(existsSync(paths.input)).toBe(true);
    expect(JSON.parse(await readFile(paths.input, 'utf8'))).toMatchObject({
      captureSnapshotId: 'snapshot', candidates: expect.any(Array),
    });
    expect(await readFile(paths.current, 'utf8')).toBe('# Current document\n');
    expect(JSON.parse(await readFile(paths.operations, 'utf8')).operations).toHaveLength(1);
    expect(JSON.parse(await readFile(paths.result, 'utf8'))).toMatchObject({ ok: true, dryRun: true });

    failGeneration = true;
    await expect(runJob(
      config,
      'dev-log',
      { date: DATE, dryRun: true },
      registry,
      state,
      artifacts,
      notify,
    )).rejects.toThrow('dev-log generation failed');
    expect(JSON.parse(await readFile(paths.result, 'utf8'))).toMatchObject({
      ok: false,
      error: 'dev-log generation failed',
    });
    expect(notifications).toEqual(['dev-log generation failed']);
  });

  it('reports an empty dev-log proposal as a successful semantic skip', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-runner-no-records-'));
    const state = new StateStore(join(directory, 'state.json'));
    const artifacts = new ArtifactStore({ rootDirectory: join(directory, 'audit') });
    const registry = new PluginRegistry();
    registry.sources.set('codex', sourcePlugin(async () => activityBatch()));
    registry.generators.set('codex', generatorPlugin(async () => ({ kind: 'records', records: [] })));
    registry.sinks.set('lark', {
      name: 'lark',
      async inspect() {
        return { markdown: '# Current\n', headings: [{
          ref: 'h1', blockId: 'requirement', level: 2,
          text: '一、需求开发记录', section: 'requirement',
        }] };
      },
      async apply() { return { sink: 'lark', updates: [] }; },
      async doctor() { return { ok: true, message: 'test lark' }; },
    });
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
          sinks: [{ type: 'lark', document: 'doc-token', mode: 'section-append' }],
        },
      },
    });

    const result = await runJob(
      config,
      'dev-log',
      { date: DATE, dryRun: true },
      registry,
      state,
      artifacts,
      async () => ({ sent: false, reason: 'unsupported_platform' }),
    );

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: 'ai_proposed_no_append_operations',
      operationCount: 0,
    });
  });

  it('skips unscheduled days but lets --force bypass the weekday gate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-runner-force-day-'));
    const state = new StateStore(join(directory, 'state.json'));
    const artifacts = new ArtifactStore({ rootDirectory: join(directory, 'audit') });
    const registry = new PluginRegistry();
    let sourceCalls = 0;
    registry.sources.set('codex', sourcePlugin(async () => {
      sourceCalls += 1;
      return activityBatch();
    }));
    registry.generators.set('codex', generatorPlugin(async () => ({
      kind: 'markdown',
      markdown: `# ${DATE}\n`,
    })));
    registry.sinks.set('markdown', sinkPlugin(async () => ({ sink: 'markdown', target: 'only' })));
    const config = testConfig(['only']);
    // DATE is Wednesday; pin schedule to Friday so the day is unscheduled.
    config.jobs['daily-report']!.schedule.days = ['fri'];
    const notify = async () => ({ sent: false as const, reason: 'unsupported_platform' as const });

    const skipped = await runJob(
      config,
      'daily-report',
      { date: DATE, dryRun: true },
      registry,
      state,
      artifacts,
      notify,
    );
    expect(skipped).toMatchObject({ skipped: true, reason: 'day_not_scheduled' });
    expect(skipped.decisionAuditPath && existsSync(skipped.decisionAuditPath)).toBe(true);
    expect(JSON.parse(await readFile(skipped.decisionAuditPath!, 'utf8'))).toMatchObject({
      job: 'daily-report',
      assessments: [expect.objectContaining({ policyId: 'runtime.schedule', outcome: 'skip' })],
    });
    expect(sourceCalls).toBe(0);

    const forced = await runJob(
      config,
      'daily-report',
      { date: DATE, dryRun: true, force: true },
      registry,
      state,
      artifacts,
      notify,
    );
    expect(forced.skipped).not.toBe(true);
    expect(forced.decisionAuditPath && existsSync(forced.decisionAuditPath)).toBe(true);
    expect(forced.decisionSummary?.included).toBeGreaterThan(0);
    expect(sourceCalls).toBe(1);
  });
});

function testConfig(directories: string[]) {
  return internFlowConfigSchema.parse({
    version: 1,
    timezone: 'Asia/Shanghai',
    jobs: {
      'daily-report': {
        enabled: true,
        template: 'daily-report',
        schedule: { time: '23:30', days: ['wed'] },
        skipDates: [],
        source: { type: 'codex' },
        generator: { type: 'codex', model: 'test-model' },
        sinks: directories.map((directory) => ({
          type: 'markdown' as const,
          directory,
          filename: '{date}.md',
        })),
      },
    },
  });
}

function activityBatch(): ActivityBatch {
  const evidence = [{
    id: 'change-1', workItemKey: '/tmp/project|main|session-1', kind: 'change' as const,
    status: 'confirmed' as const, timestamp: `${DATE}T01:30:00.000Z`, workspace: '/tmp/project',
    branch: 'main', files: ['src/core/runner.ts'], summary: '修改 src/core/runner.ts',
    sourceEventIds: ['event-1'], confidence: 'confirmed' as const,
  }];
  return {
    date: DATE,
    timezone: 'Asia/Shanghai',
    sourceCount: 1,
    filteredCount: 1,
    activities: [{
      id: 'session-1',
      title: 'Runner recovery',
      cwd: '/tmp/project',
      gitBranch: 'main',
      gitSha: 'abc123',
      startedAt: `${DATE}T01:00:00.000Z`,
      endedAt: `${DATE}T02:00:00.000Z`,
      originalStartedAt: `${DATE}T01:00:00.000Z`,
      originalEndedAt: `${DATE}T02:00:00.000Z`,
      activeMinutes: 60,
      durationMinutes: 60,
      observedSpanMinutes: 60,
      durationReliable: true,
      durationReason: 'bounded',
      targetDateActivityCount: 1,
      firstUserMessage: 'Fix recovery',
      userMessages: ['Fix recovery'],
      assistantMessages: [],
      changedFiles: ['src/core/runner.ts'],
      commands: [],
      commandCount: 0,
      errors: [],
    }],
    captureSnapshot: {
      id: 'snapshot', date: DATE, timezone: 'Asia/Shanghai', asOf: `${DATE}T23:30:00+08:00`,
      finalized: true, finalizationBasis: 'configured-cutoff', lateEventCount: 0,
      events: [], evidence,
      quality: {
        discoveredFiles: 1, scannedBytes: 1, validLines: 1, invalidLines: 0,
        targetOccurrences: 0, included: 0, duplicate: 0, replay: 0, unsupported: 0,
        invalid: 0, rolledBack: 0, aborted: 0, orphanToolOutputs: 0,
        unresolvedParents: [], unknownRelevantEventTypes: [], accountingDifference: 0,
        coverage: 'high', reasons: [],
      },
    },
  };
}

function sourcePlugin(collect: SourcePlugin['collect']): SourcePlugin {
  return { name: 'codex', collect };
}

function generatorPlugin(generate: GeneratorPlugin['generate']): GeneratorPlugin {
  return { name: 'codex', generate };
}

function sinkPlugin(apply: SinkPlugin['apply']): SinkPlugin {
  return {
    name: 'markdown',
    apply,
    async doctor() {
      return { ok: true, message: 'test sink' };
    },
  };
}
