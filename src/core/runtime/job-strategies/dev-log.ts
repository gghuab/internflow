import { dirname, join } from 'node:path';
import type {
  ActivityBatch,
  HeadingReference,
  OutputArtifact,
  RunContext,
  RunResult,
  SinkSnapshot,
} from '../../contracts/index.js';
import type { ArtifactStore, StateStore } from '../../persistence/index.js';
import { withDecisionId } from '../../decision-audit.js';
import { resolveDevLogCandidates } from '../../../reports/dev-log/document-index.js';
import { DevLogEvidenceLedger } from '../../../reports/dev-log/ledger.js';
import type { SinkRun } from '../sink-pipeline.js';
import type { JobStrategy, ResultContext } from './types.js';

export function createDevLogStrategy(options: {
  artifacts: ArtifactStore;
  state: StateStore;
  date: string;
  dryRun: boolean;
  model?: string;
  generatorType: string;
  generatorModel: string | null;
}): JobStrategy {
  const ledger = new DevLogEvidenceLedger(join(dirname(options.state.path), 'dev-log-evidence.json'));
  return {
    failureTitle: () => 'Codex 需求开发记录同步失败',
    prepareBatch: (batch) => filterPendingWork(batch, ledger),
    async saveInput(batch) {
      await options.artifacts.saveDevLogInput(options.date, {
        date: batch.date,
        captureSnapshotId: batch.captureSnapshot?.id,
        candidates: batch.devLogCandidates || [],
      });
    },
    decorateEmptyResult(result, sourceCount, filteredCount) {
      return {
        ...result,
        sourceSessionCount: sourceCount,
        filteredSessionCount: filteredCount,
        sessionCount: 0,
        inputPath: options.artifacts.devLogPaths(options.date, options.dryRun).input,
      };
    },
    async prepareGeneration(batch, snapshot, context) {
      const selected = snapshot || virtualSnapshot();
      await resolveTargets(batch, selected, ledger);
      await options.artifacts.saveDevLogInput(options.date, {
        date: batch.date,
        captureSnapshotId: batch.captureSnapshot?.id,
        candidates: batch.resolvedDevLogCandidates || [],
      });
      assertCaptureReady(context, batch);
      await options.artifacts.saveDevLogCurrent(options.date, selected.markdown || '');
      return selected;
    },
    assertArtifact(artifact) {
      if (artifact.kind !== 'records') throw new Error('Dev log generator returned non-record output.');
    },
    async saveGenerated(artifact, snapshot) {
      if (artifact.kind !== 'records') return;
      await options.artifacts.saveDevLogOperations(options.date, artifact.records, snapshot);
    },
    async afterSinkApplied(run, snapshot, artifact) {
      if (run.config.type === 'lark' && artifact.kind === 'records') {
        await ledger.markSynced(artifact.records, snapshot?.revisionId);
      }
    },
    decorateResult(result, context) {
      return decorateResult(result, context, options);
    },
    async saveRunResult(result) {
      await options.artifacts.saveDevLogResult(resultArtifact(result), { dryRun: options.dryRun });
    },
    async saveFailure(message) {
      await options.artifacts.saveDevLogResult({
        ok: false,
        failedAt: new Date().toISOString(),
        error: message,
      }, { dryRun: options.dryRun });
    },
  };
}

async function filterPendingWork(batch: ActivityBatch, ledger: DevLogEvidenceLedger): Promise<void> {
  if (!batch.devLogCandidates) throw new Error('Dev log requires WorkItem candidates.');
  const pending = await ledger.pendingCandidates(
    batch.devLogCandidates,
    batch.decisionAssessments || (batch.decisionAssessments = []),
  );
  const subjects = new Set(pending.map((candidate) => candidate.subjectKey));
  const selectedItems = (batch.workItems || []).filter((item) => subjects.has(item.subjectKey));
  const sessions = new Set(selectedItems.flatMap((item) => item.sessionIds));
  const evidence = new Set(pending.flatMap((candidate) => candidate.evidenceIds));
  batch.devLogCandidates = pending;
  batch.workItems = selectedItems;
  batch.workEvidence = (batch.workEvidence || []).filter((item) => evidence.has(item.id));
  batch.activities = batch.activities.filter((activity) => sessions.has(activity.id));
  resetSelectedActivities(batch);
}

async function resolveTargets(
  batch: ActivityBatch,
  snapshot: SinkSnapshot,
  ledger: DevLogEvidenceLedger,
): Promise<void> {
  if (!batch.devLogCandidates) return;
  batch.resolvedDevLogCandidates = resolveDevLogCandidates(
    batch.devLogCandidates,
    snapshot,
    await ledger.subjectTargets(),
    batch.decisionAssessments || (batch.decisionAssessments = []),
  );
  if (batch.devLogCandidates.length && !batch.resolvedDevLogCandidates.length) {
    throw new Error('No writable Lark heading matches the pending dev-log candidates.');
  }
}

function assertCaptureReady(context: RunContext, batch: ActivityBatch): void {
  if (!batch.captureSnapshot) return;
  const { finalized, quality, id } = batch.captureSnapshot;
  const ready = finalized && quality.coverage === 'high';
  const evidence = [{ kind: 'capture' as const, id }];
  (batch.decisionAssessments ||= []).push(withDecisionId({
    kind: 'gate' as const,
    policyId: 'runtime.remote-write',
    policyVersion: '1.0.0',
    subject: { kind: 'job' as const, id: context.jobName },
    outcome: ready ? (context.dryRun ? 'preview' : 'accept') : context.dryRun ? 'would-block' : 'reject',
    confidence: 'high' as const,
    gates: [
      { key: 'finalized', passed: finalized, message: finalized ? '采集快照已最终化' : '采集快照尚未最终化', evidence },
      { key: 'high-coverage', passed: quality.coverage === 'high', message: `采集覆盖度为 ${quality.coverage}`, evidence },
    ],
    signals: [],
    reasons: [{
      code: ready ? 'runtime.remote-write.ready' : 'runtime.remote-write.blocked',
      message: ready ? '事实质量允许写入远端需求开发记录' : '事实质量不足，正式远端写入会被阻断',
      evidence,
    }],
    evidence,
    constraints: [],
  }));
  if (context.dryRun) return;
  if (!finalized) {
    throw new Error('Dev-log remote write requires a finalized Codex capture snapshot (calendar close or configured workday cutoff).');
  }
  if (quality.coverage !== 'high') {
    throw new Error(`Dev-log remote write blocked by Codex capture quality: ${quality.reasons.join('; ') || quality.coverage}`);
  }
}

function virtualSnapshot(): SinkSnapshot {
  const headings: HeadingReference[] = [
    { ref: 'h1', blockId: 'virtual-requirement', level: 2, text: '一、需求开发档案', section: 'requirement' },
    { ref: 'h2', blockId: 'virtual-bugfix', level: 2, text: '二、问题定位与修复记录', section: 'bugfix' },
    { ref: 'h3', blockId: 'virtual-insight', level: 2, text: '三、工程方法与知识沉淀', section: 'insight' },
  ];
  return { markdown: '', headings };
}

function decorateResult(
  result: RunResult,
  context: ResultContext,
  options: Parameters<typeof createDevLogStrategy>[0],
): RunResult {
  if (context.artifact.kind !== 'records') return result;
  const paths = options.artifacts.devLogPaths(options.date, options.dryRun);
  return {
    ...result,
    sourceSessionCount: context.sourceCount,
    filteredSessionCount: context.filteredCount,
    sessionCount: context.activityCount,
    inputPath: paths.input,
    currentPath: paths.current,
    operationsPath: paths.operations,
    generator: { provider: options.generatorType, model: options.model || options.generatorModel },
    updates: sinkUpdates(context.artifact.records, context.sinkRuns, context.inspected, context.outputs),
  };
}

function sinkUpdates(
  records: Extract<OutputArtifact, { kind: 'records' }>['records'],
  sinkRuns: SinkRun[],
  inspected: Map<number, SinkSnapshot>,
  outputs: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const larkIndex = sinkRuns.findIndex((run) => run.config.type === 'lark');
  if (larkIndex < 0) return [];
  const headings = new Map((inspected.get(larkIndex)?.headings || []).map((heading) => [heading.ref, heading]));
  const updates = Array.isArray(outputs[larkIndex]?.updates)
    ? outputs[larkIndex].updates as Array<Record<string, unknown>>
    : [];
  return records.map((record, index) => {
    const heading = headings.get(record.targetRef);
    const update = updates[index] || {};
    return {
      section: record.section,
      targetHeadingId: heading?.blockId || record.targetRef,
      targetHeading: heading?.text || '',
      anchorBlockId: update.anchorBlockId || null,
      applied: update.applied === true,
      response: update.response || null,
    };
  });
}

function resultArtifact(result: RunResult): Record<string, unknown> {
  if (result.reason === 'weekend_no_record' || result.reason === 'date_in_skip_list') {
    return { ok: result.ok, skipped: result.skipped, reason: result.reason, date: result.date };
  }
  if (result.reason === 'no_reportable_codex_sessions') {
    return { ok: result.ok, skipped: result.skipped, reason: result.reason, date: result.date, inputPath: result.inputPath };
  }
  return {
    ok: result.ok,
    skipped: result.skipped,
    ...(result.reason ? { reason: result.reason } : {}),
    dryRun: result.dryRun,
    date: result.date,
    sourceSessionCount: result.sourceSessionCount ?? result.sourceCount,
    filteredSessionCount: result.filteredSessionCount ?? Math.max(0, result.sourceCount - result.activityCount),
    sessionCount: result.sessionCount ?? result.activityCount,
    inputPath: result.inputPath,
    currentPath: result.currentPath,
    operationsPath: result.operationsPath,
    operationCount: result.operationCount ?? 0,
    generator: result.generator,
    updates: result.updates || [],
  };
}

function resetSelectedActivities(batch: ActivityBatch): void {
  batch.sessions = batch.activities;
  batch.sessionCount = batch.activities.length;
  batch.reportableSessionCount = batch.activities.length;
}
