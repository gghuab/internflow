import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src/core/persistence/artifacts.js';
import { internFlowConfigSchema } from '../src/core/config.js';
import { PluginRegistry } from '../src/core/runtime/registry.js';
import { runJob } from '../src/core/runtime/runner.js';
import { StateStore } from '../src/core/persistence/index.js';
import type { Activity, ActivityBatch } from '../src/core/contracts/index.js';

describe('work semantic layer integration', () => {
  it('resolves pending dev-log candidates before generation and preserves local evidence fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-work-integration-'));
    const registry = new PluginRegistry();
    let generatedBatch: ActivityBatch | undefined;
    registry.sources.set('codex', {
      name: 'codex', async collect() { return batch(); },
    });
    registry.generators.set('codex', {
      name: 'codex', async generate(_context, _config, value) {
        generatedBatch = value;
        const candidate = value.resolvedDevLogCandidates?.[0];
        if (!candidate) throw new Error('missing resolved candidate');
        return { kind: 'records', records: [{
          section: candidate.section, targetRef: candidate.allowedTargetRefs[0]!, markdown: '完成实现',
          evidenceIds: candidate.evidenceIds, candidateId: candidate.id, subjectKey: candidate.subjectKey,
          contentFingerprint: candidate.contentFingerprint,
        }] };
      },
    });
    registry.sinks.set('lark', {
      name: 'lark',
      async inspect() {
        return { headings: [{
          ref: 'h1', blockId: 'block', level: 3, text: '接口字段实现', section: 'requirement',
        }] };
      },
      async apply() { return { sink: 'lark', applied: true }; },
      async doctor() { return { ok: true, message: 'ok' }; },
    });
    const config = internFlowConfigSchema.parse({
      version: 1, timezone: 'Asia/Shanghai', jobs: { 'dev-log': {
        enabled: true, template: 'dev-log', schedule: { time: '23:45', days: ['thu'] },
        source: { type: 'codex', captureMode: 'precise' }, generator: { type: 'codex', model: null },
        sinks: [{ type: 'lark', document: 'doc', mode: 'section-append' }],
      } },
    });
    const result = await runJob(config, 'dev-log', {
      date: '2026-07-16', dryRun: true,
    }, registry, new StateStore(join(directory, 'state.json')), new ArtifactStore({ rootDirectory: join(directory, 'artifacts') }), async () => ({ sent: false, reason: 'test' }));

    expect(result).toMatchObject({ ok: true, operationCount: 1 });
    expect(generatedBatch?.resolvedDevLogCandidates?.[0]).toMatchObject({ allowedTargetRefs: ['h1'] });
  });
});

function batch(): ActivityBatch {
  const value = activity();
  return {
    date: '2026-07-16', timezone: 'Asia/Shanghai', sourceCount: 1, filteredCount: 0,
    activities: [value], sessions: [value], sessionCount: 1,
    captureSnapshot: {
      id: 'snapshot', date: '2026-07-16', timezone: 'Asia/Shanghai', asOf: '2026-07-16T23:45:00+08:00',
      finalized: true, finalizationBasis: 'configured-cutoff', lateEventCount: 0, events: [], evidence: [{
        id: 'e1', workItemKey: '/workspace|feat/api|session', kind: 'change', status: 'confirmed',
        timestamp: '2026-07-16T01:00:00Z', workspace: '/workspace', branch: 'feat/api',
        files: ['src/api.ts'], summary: '修改 src/api.ts', sourceEventIds: ['event'], confidence: 'confirmed',
      }],
      quality: {
        discoveredFiles: 1, scannedBytes: 1, validLines: 1, invalidLines: 0, targetOccurrences: 0,
        included: 0, duplicate: 0, replay: 0, unsupported: 0, invalid: 0, rolledBack: 0, aborted: 0,
        orphanToolOutputs: 0, unresolvedParents: [], unknownRelevantEventTypes: [], accountingDifference: 0,
        coverage: 'high', reasons: [],
      },
    },
  };
}

function activity(): Activity {
  return {
    file: '/tmp/session.jsonl', id: 'session', title: '接口字段实现', cwd: '/workspace',
    gitBranch: 'feat/api', gitSha: '', startedAt: '2026-07-16T01:00:00Z', endedAt: '2026-07-16T01:10:00Z',
    originalStartedAt: '', originalEndedAt: '', activeMinutes: 10, durationMinutes: 10,
    observedSpanMinutes: 10, durationReliable: true, hadReplayBurst: false, durationReason: '可靠',
    targetDateActivityCount: 2, firstUserMessage: '实现接口字段', userMessages: ['实现接口字段'],
    assistantMessages: ['已完成'], changedFiles: ['src/api.ts'], commands: [], commandCount: 0, errors: [],
  };
}
