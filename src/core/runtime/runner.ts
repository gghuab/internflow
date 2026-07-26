import { assertLocalDate, dateSkipReason, isLastWorkdayOfMonth, weekdayForLocalDate } from '../calendar.js';
import type { InternFlowConfig } from '../config.js';
import type {
  DecisionAssessment,
  OutputArtifact,
  RunContext,
  RunResult,
  SinkSnapshot,
} from '../contracts/index.js';
import { buildDecisionAudit, decisionFingerprint, withDecisionId } from '../decision-audit.js';
import { notifyMacOsFailure } from '../notifications.js';
import { ArtifactStore, artifactHash, StateStore } from '../persistence/index.js';
import { acquireRunLock } from '../run-lock.js';
import { projectWorkday } from '../../workflows/workday/index.js';
import { createJobStrategy, type JobStrategy } from './job-strategies/index.js';
import { PluginRegistry } from './registry.js';
import { preflightRecovery } from './recovery.js';
import { alreadyAppliedOutput, skippedResult } from './results.js';
import {
  applySinks,
  createSinkRuns,
  inspectMissingSnapshots,
  inspectSinks,
} from './sink-pipeline.js';

export interface RunOptions {
  date: string;
  dryRun?: boolean;
  force?: boolean;
  model?: string;
}

export async function runJob(
  config: InternFlowConfig,
  jobName: string,
  options: RunOptions,
  registry = new PluginRegistry(),
  state = new StateStore(),
  artifacts?: ArtifactStore,
  notifyFailure: typeof notifyMacOsFailure = notifyMacOsFailure,
): Promise<RunResult> {
  const artifactStore = artifacts || new ArtifactStore({
    ...(config.artifacts?.dailyDirectory
      ? { dailyDirectory: config.artifacts.dailyDirectory }
      : {}),
    ...(config.artifacts?.devLogDirectory
      ? { devLogDirectory: config.artifacts.devLogDirectory }
      : {}),
  });
  let release: (() => Promise<void>) | undefined;
  let strategy: JobStrategy | undefined;
  const decisions: DecisionAssessment[] = [];
  let snapshotId: string | null = null;
  try {
    // 先校验日期，避免未经校验的路径片段进入锁文件名。
    assertLocalDate(options.date);
    const job = config.jobs[jobName];
    if (!job) throw new Error(`Unknown job: ${jobName}`);
    strategy = createJobStrategy(job.template, {
      artifacts: artifactStore,
      state,
      date: options.date,
      dryRun: Boolean(options.dryRun),
      ...(options.model ? { model: options.model } : {}),
      generatorType: job.generator.type,
      generatorModel: job.generator.model,
    });
    release = await acquireRunLock(jobName, options.date);
    const result = await runJobUnlocked(
      config, jobName, options, registry, state, artifactStore, strategy, decisions,
      (value) => { snapshotId = value; },
    );
    const decorated = await attachDecisionAudit(
      artifactStore, config, jobName, options, decisions, snapshotId, result,
    );
    await strategy.saveRunResult(decorated);
    return decorated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    decisions.push(runtimeAssessment(jobName, 'runtime.execution', 'failed', false, message));
    try {
      await attachDecisionAudit(
        artifactStore, config, jobName, options, decisions, snapshotId,
        skippedResult(jobName, options.date, Boolean(options.dryRun), 'failed'),
      );
    } catch {
      // 日期、配置或审计自身无效时，保留原始运行错误。
    }
    try {
      await strategy?.saveFailure(message);
    } catch {
      // 失败审计不能覆盖真正的运行错误。
    }
    try {
      const title = strategy?.failureTitle(jobName) || `InternFlow ${jobName} 运行失败`;
      await notifyFailure(message, { title });
    } catch {
      // 通知只是兜底，原始错误始终优先返回。
    }
    throw error;
  } finally {
    await release?.();
  }
}

async function runJobUnlocked(
  config: InternFlowConfig,
  jobName: string,
  options: RunOptions,
  registry: PluginRegistry,
  state: StateStore,
  artifacts: ArtifactStore,
  strategy: JobStrategy,
  decisions: DecisionAssessment[],
  setSnapshotId: (value: string | null) => void,
): Promise<RunResult> {
  const job = config.jobs[jobName];
  if (!job) throw new Error(`Unknown job: ${jobName}`);

  const weekday = weekdayForLocalDate(options.date);
  const skipReason = dateSkipReason(options.date, job.skipDates);
  // 周末 / skipDates 始终跳过；调度日门禁可被 --force 绕过，便于补跑与预览。
  const wrongRunDay = job.schedule.runOn === 'last-workday'
    ? !isLastWorkdayOfMonth(options.date, job.skipDates)
    : !job.schedule.days.includes(weekday);
  decisions.push(runtimeAssessment(
    jobName,
    'runtime.schedule',
    skipReason ? 'skip' : wrongRunDay && !options.force ? 'skip' : options.force ? 'forced' : 'run',
    !skipReason && (!wrongRunDay || Boolean(options.force)),
    skipReason || (wrongRunDay && !options.force ? '当前日期不在任务调度范围内' : options.force ? '显式 force 允许补跑' : '当前日期符合任务调度'),
  ));
  if (skipReason) {
    return skippedResult(
      jobName,
      options.date,
      Boolean(options.dryRun),
      skipReason,
    );
  }
  if (wrongRunDay && !options.force) {
    return skippedResult(
      jobName,
      options.date,
      Boolean(options.dryRun),
      'day_not_scheduled',
    );
  }
  if (!job.enabled && !options.force) {
    decisions.push(runtimeAssessment(jobName, 'runtime.enabled', 'reject', false, '任务已停用且没有显式 force'));
    throw new Error(`Job ${jobName} is disabled. Use --force for an explicit manual run.`);
  }
  decisions.push(runtimeAssessment(
    jobName, 'runtime.enabled', job.enabled ? 'accept' : 'forced', true,
    job.enabled ? '任务处于启用状态' : '任务已停用，但显式 force 允许本次运行',
  ));

  const context: RunContext = {
    jobName,
    job,
    date: options.date,
    timezone: config.timezone,
    dryRun: Boolean(options.dryRun),
    force: Boolean(options.force),
    ...(options.model ? { modelOverride: options.model } : {}),
  };
  const sinkRuns = await createSinkRuns(jobName, options.date, context, state);
  let stored = context.dryRun ? null : await state.artifact(jobName, options.date);

  if (!context.dryRun && sinkRuns.every((run) => run.state?.status === 'applied')) {
    decisions.push(runtimeAssessment(jobName, 'runtime.idempotency', 'skip', true, '所有输出端均已应用同一运行结果'));
    return {
      ...skippedResult(jobName, options.date, false),
      reason: 'already_applied',
      sourceCount: stored?.sourceCount || 0,
      activityCount: stored?.activityCount || 0,
      outputs: sinkRuns.map((run) => alreadyAppliedOutput(run.config.type)),
    };
  }
  const pendingRuns = sinkRuns.filter((run) => run.state?.status === 'pending');
  if (pendingRuns.length) {
    const recoverable = Boolean(stored)
      && pendingRuns.every((run) => run.state?.hash === stored?.hash)
      && context.force;
    decisions.push(runtimeAssessment(
      jobName,
      'runtime.recovery',
      recoverable ? 'forced' : 'reject',
      recoverable,
      recoverable
        ? `${pendingRuns.length} 个不确定输出使用同一不可变工件显式恢复`
        : `${pendingRuns.length} 个输出处于不确定状态，缺少安全恢复条件`,
    ));
  }
  preflightRecovery(sinkRuns, stored, context.force);

  let artifact: OutputArtifact;
  let hash: string;
  let sourceCount: number;
  let activityCount: number;
  let filteredCount: number;
  const inspected = new Map<number, SinkSnapshot>();

  if (stored) {
    artifact = stored.artifact;
    hash = stored.hash;
    sourceCount = stored.sourceCount;
    activityCount = stored.activityCount;
    filteredCount = Math.max(0, sourceCount - activityCount);
    restoreStoredSnapshots(sinkRuns, stored.snapshots, inspected);
  } else {
    const collectDay = async (date: string) => {
      const dayContext = { ...context, date };
      const captured = await registry.source(job.source.type).collect(dayContext, job.source);
      const dayBatch = projectWorkday(captured, dayContext, job.source);
      // dry-run 只在内存中补齐周期输入，不写正式 capture/work-layer 工件。
      if (!context.dryRun) {
        await artifacts.saveCaptureAudit(date, captured);
        await artifacts.saveWorkLayer(date, dayBatch);
      }
      return dayBatch;
    };
    const batch = strategy.buildBatch
      ? await strategy.buildBatch({ context, artifacts, collectDay })
      : await collectDay(options.date);
    setSnapshotId(batch.captureSnapshot?.id || null);
    const batchAssessments = batch.decisionAssessments || (batch.decisionAssessments = []);
    let collectedAssessmentCount = batchAssessments.length;
    decisions.push(...batchAssessments);
    await strategy.prepareBatch(batch);
    decisions.push(...batchAssessments.slice(collectedAssessmentCount));
    collectedAssessmentCount = batchAssessments.length;
    await strategy.saveInput(batch);

    sourceCount = batch.sourceCount;
    activityCount = strategy.reportableCount?.(batch) ?? batch.activities.length;
    filteredCount = batch.filteredCount;
    if (!activityCount) {
      decisions.push(runtimeAssessment(jobName, 'runtime.reportable', 'skip', true, '没有可汇报的工作项'));
      const result: RunResult = {
        ...skippedResult(
          jobName,
          options.date,
          context.dryRun,
          'no_reportable_codex_sessions',
        ),
        sourceCount,
      };
      return strategy.decorateEmptyResult(result, sourceCount, filteredCount);
    }
    decisions.push(runtimeAssessment(jobName, 'runtime.reportable', 'accept', true, `共有 ${activityCount} 个可汇报工作项`));

    let generationSnapshot = await inspectSinks(sinkRuns, context, registry, inspected);
    generationSnapshot = await strategy.prepareGeneration(batch, generationSnapshot, context);
    decisions.push(...batchAssessments.slice(collectedAssessmentCount));

    artifact = await registry.generator(job.generator.type).generate(
      context,
      job.generator,
      batch,
      generationSnapshot,
    );
    hash = artifactHash(artifact);
    strategy.assertArtifact(artifact);
    await strategy.saveGenerated(artifact, generationSnapshot);

    if (!context.dryRun) {
      const snapshots = snapshotRecord(sinkRuns, inspected);
      stored = await state.saveArtifact({
        job: jobName,
        date: options.date,
        sourceCount,
        activityCount,
        artifact,
        snapshots,
        ...(generationSnapshot ? { generationSnapshot } : {}),
      });
      artifact = stored.artifact;
      hash = stored.hash;
      sourceCount = stored.sourceCount;
      activityCount = stored.activityCount;
      restoreStoredSnapshots(sinkRuns, stored.snapshots, inspected);
    }
  }

  await inspectMissingSnapshots(sinkRuns, context, registry, inspected);
  let outputs: Array<Record<string, unknown>>;
  try {
    outputs = await applySinks({
      sinkRuns,
      context,
      registry,
      state,
      artifact,
      hash,
      inspected,
      afterApplied: async (run, snapshot) => {
        await strategy.afterSinkApplied(run, snapshot, artifact);
      },
    });
    decisions.push(runtimeAssessment(
      jobName,
      'runtime.sink-write',
      context.dryRun ? 'preview' : outputs.every((output) => output.skipped === true) ? 'skip' : 'applied',
      true,
      context.dryRun ? 'dry-run 仅生成本地预览' : `${outputs.length} 个输出端处理完成`,
    ));
  } catch (error) {
    decisions.push(runtimeAssessment(
      jobName,
      'runtime.sink-write',
      'failed',
      false,
      error instanceof Error ? error.message : String(error),
    ));
    throw error;
  }

  const noAppendOperations = artifact.kind === 'records' && artifact.records.length === 0;
  const result: RunResult = {
    ok: true,
    skipped: noAppendOperations || outputs.every((output) => output.skipped === true),
    ...(noAppendOperations ? { reason: 'ai_proposed_no_append_operations' } : {}),
    job: jobName,
    date: options.date,
    dryRun: context.dryRun,
    sourceCount,
    activityCount,
    ...(artifact.kind === 'records' ? { operationCount: artifact.records.length } : {}),
    outputs,
  };
  return strategy.decorateResult(result, {
    sourceCount,
    activityCount,
    filteredCount,
    artifact,
    sinkRuns,
    inspected,
    outputs,
  });
}

async function attachDecisionAudit(
  artifacts: ArtifactStore,
  config: InternFlowConfig,
  jobName: string,
  options: RunOptions,
  assessments: DecisionAssessment[],
  snapshotId: string | null,
  result: RunResult,
): Promise<RunResult> {
  const audit = buildDecisionAudit({
    job: jobName,
    date: options.date,
    timezone: config.timezone,
    snapshotId,
    inputFingerprint: decisionFingerprint({ job: jobName, options, snapshotId }),
    assessments,
  });
  const decisionAuditPath = await artifacts.saveDecisionAudit(audit);
  return {
    ...result,
    decisionAuditPath,
    decisionSummary: {
      included: assessments.filter((item) => ['accept', 'include', 'selected', 'append', 'create', 'run', 'forced'].includes(item.outcome)).length,
      excluded: assessments.filter((item) => ['exclude', 'none', 'skip', 'unavailable'].includes(item.outcome)).length,
      blocked: assessments.filter((item) => item.outcome === 'reject' || item.outcome === 'failed' || item.gates.some((gate) => !gate.passed)).length,
      lowConfidence: assessments.filter((item) => item.confidence === 'low').length,
    },
  };
}

function runtimeAssessment(
  jobName: string,
  policyId: string,
  outcome: string,
  passed: boolean,
  message: string,
): DecisionAssessment {
  const subject = { kind: 'job' as const, id: jobName };
  const evidence = [subject];
  return withDecisionId({
    kind: 'gate' as const,
    policyId,
    policyVersion: '1.0.0',
    subject,
    outcome,
    confidence: 'high' as const,
    gates: [{ key: policyId.split('.').at(-1) || policyId, passed, message, evidence }],
    signals: [],
    reasons: [{ code: `${policyId}.${outcome}`, message, evidence }],
    evidence,
    constraints: [],
  });
}

function snapshotRecord(
  sinkRuns: Awaited<ReturnType<typeof createSinkRuns>>,
  inspected: Map<number, SinkSnapshot>,
): Record<string, SinkSnapshot> {
  const snapshots: Record<string, SinkSnapshot> = {};
  for (const run of sinkRuns) {
    const snapshot = inspected.get(run.index);
    if (snapshot) snapshots[run.stateKey] = snapshot;
  }
  return snapshots;
}

function restoreStoredSnapshots(
  sinkRuns: Awaited<ReturnType<typeof createSinkRuns>>,
  snapshots: Record<string, SinkSnapshot>,
  inspected: Map<number, SinkSnapshot>,
): void {
  for (const run of sinkRuns) {
    if (run.state?.status === 'applied') continue;
    const snapshot = snapshots[run.stateKey];
    if (snapshot) inspected.set(run.index, snapshot);
  }
}
