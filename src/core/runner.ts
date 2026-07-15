import { createHash } from 'node:crypto';
import type { InternFlowConfig } from './config.js';
import { acquireRunLock } from './lock.js';
import { PluginRegistry } from './registry.js';
import { StateStore } from './state.js';
import type { HeadingReference, RunContext, RunResult, SinkSnapshot } from './types.js';

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
): Promise<RunResult> {
  const release = await acquireRunLock(jobName, options.date);
  try {
    return await runJobUnlocked(config, jobName, options, registry, state);
  } finally {
    await release();
  }
}

async function runJobUnlocked(
  config: InternFlowConfig,
  jobName: string,
  options: RunOptions,
  registry: PluginRegistry,
  state: StateStore,
): Promise<RunResult> {
  const job = config.jobs[jobName];
  if (!job) throw new Error(`Unknown job: ${jobName}`);
  if (!job.enabled && !options.force) {
    throw new Error(`Job ${jobName} is disabled. Use --force for an explicit manual run.`);
  }
  const context: RunContext = {
    jobName,
    job,
    date: options.date,
    timezone: config.timezone,
    dryRun: Boolean(options.dryRun),
    force: Boolean(options.force),
    ...(options.model ? { modelOverride: options.model } : {}),
  };

  const source = registry.source(job.source.type);
  const batch = await source.collect(context, job.source);
  if (!batch.activities.length) {
    return {
      ok: true,
      skipped: true,
      job: jobName,
      date: options.date,
      dryRun: context.dryRun,
      sourceCount: batch.sourceCount,
      activityCount: 0,
      outputs: [],
    };
  }

  const inspected = new Map<number, SinkSnapshot>();
  let generationSnapshot: SinkSnapshot | undefined;
  for (const [index, sinkConfig] of job.sinks.entries()) {
    const sink = registry.sink(sinkConfig.type);
    if (!sink.inspect) continue;
    const snapshot = await sink.inspect(context, sinkConfig);
    inspected.set(index, snapshot);
    generationSnapshot ||= snapshot;
  }
  if (job.template === 'dev-log' && !generationSnapshot) {
    generationSnapshot = virtualDevLogSnapshot();
  }

  const generator = registry.generator(job.generator.type);
  const artifact = await generator.generate(context, job.generator, batch, generationSnapshot);
  const artifactHash = createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
  const outputs: Array<Record<string, unknown>> = [];

  for (const [index, sinkConfig] of job.sinks.entries()) {
    const sinkKey = sinkIdentity(sinkConfig);
    const stateKey = `${jobName}:${options.date}:${sinkConfig.type}:${sinkKey}`;
    const currentStatus = context.dryRun ? null : await state.status(stateKey);
    if (!context.force && currentStatus === 'applied') {
      outputs.push({ sink: sinkConfig.type, skipped: true, reason: 'already_applied' });
      continue;
    }
    if (!context.dryRun) await state.begin(stateKey, artifactHash, context.force);
    const sink = registry.sink(sinkConfig.type);
    const output = await sink.apply(context, sinkConfig, artifact, inspected.get(index));
    outputs.push(output);
    if (!context.dryRun) await state.complete(stateKey, artifactHash);
  }

  return {
    ok: true,
    skipped: outputs.every((output) => output.skipped === true),
    job: jobName,
    date: options.date,
    dryRun: context.dryRun,
    sourceCount: batch.sourceCount,
    activityCount: batch.activities.length,
    outputs,
  };
}

function sinkIdentity(sink: InternFlowConfig['jobs'][string]['sinks'][number]): string {
  const target = sink.type === 'lark'
    ? { type: sink.type, document: sink.document, profile: sink.profile || '', mode: sink.mode }
    : { type: sink.type, directory: sink.directory, filename: sink.filename };
  return createHash('sha256').update(JSON.stringify(target)).digest('hex').slice(0, 16);
}

function virtualDevLogSnapshot(): SinkSnapshot {
  const headings: HeadingReference[] = [
    { ref: 'h1', blockId: 'virtual-requirement', level: 2, text: '一、需求开发记录', section: 'requirement' },
    { ref: 'h2', blockId: 'virtual-bugfix', level: 2, text: '二、联调问题与 Bug Fix 汇总', section: 'bugfix' },
    { ref: 'h3', blockId: 'virtual-insight', level: 2, text: '三、个人沉淀', section: 'insight' },
  ];
  return { markdown: '', headings };
}
