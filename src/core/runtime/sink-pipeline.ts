import { createHash } from 'node:crypto';
import type { InternFlowConfig } from '../config.js';
import type { OutputArtifact, RunContext, SinkSnapshot } from '../contracts/index.js';
import type { SinkRunState } from '../persistence/index.js';
import { StateStore } from '../persistence/index.js';
import { PluginRegistry } from './registry.js';
import { alreadyAppliedOutput } from './results.js';

export interface SinkRun {
  index: number;
  config: InternFlowConfig['jobs'][string]['sinks'][number];
  stateKey: string;
  state: SinkRunState | null;
}

export async function createSinkRuns(
  jobName: string,
  date: string,
  context: RunContext,
  state: StateStore,
): Promise<SinkRun[]> {
  return Promise.all(context.job.sinks.map(async (config, index) => {
    const stateKey = `${jobName}:${date}:${config.type}:${sinkIdentity(config)}`;
    return {
      index,
      config,
      stateKey,
      state: context.dryRun ? null : await state.sink(stateKey),
    };
  }));
}

export async function inspectSinks(
  sinkRuns: SinkRun[],
  context: RunContext,
  registry: PluginRegistry,
  inspected: Map<number, SinkSnapshot>,
): Promise<SinkSnapshot | undefined> {
  let generationSnapshot: SinkSnapshot | undefined;
  for (const run of sinkRuns) {
    if (run.state?.status === 'applied') continue;
    const sink = registry.sink(run.config.type);
    if (!sink.inspect) continue;
    const snapshot = await sink.inspect(context, run.config);
    inspected.set(run.index, snapshot);
    generationSnapshot ||= snapshot;
  }
  return generationSnapshot;
}

export async function inspectMissingSnapshots(
  sinkRuns: SinkRun[],
  context: RunContext,
  registry: PluginRegistry,
  inspected: Map<number, SinkSnapshot>,
): Promise<void> {
  for (const run of sinkRuns) {
    if (run.state?.status === 'applied' || inspected.has(run.index)) continue;
    const sink = registry.sink(run.config.type);
    if (!sink.inspect) continue;
    inspected.set(run.index, await sink.inspect(context, run.config));
  }
}

export async function applySinks(options: {
  sinkRuns: SinkRun[];
  context: RunContext;
  registry: PluginRegistry;
  state: StateStore;
  artifact: OutputArtifact;
  hash: string;
  inspected: Map<number, SinkSnapshot>;
  afterApplied?: (run: SinkRun, snapshot: SinkSnapshot | undefined) => Promise<void>;
}): Promise<Array<Record<string, unknown>>> {
  const outputs: Array<Record<string, unknown>> = [];
  for (const run of options.sinkRuns) {
    if (!options.context.dryRun) {
      const begin = await options.state.begin(run.stateKey, options.hash, options.context.force);
      if (begin === 'applied') {
        outputs.push(alreadyAppliedOutput(run.config.type));
        continue;
      }
    }

    const snapshot = options.inspected.get(run.index);
    const sink = options.registry.sink(run.config.type);
    outputs.push(await sink.apply(options.context, run.config, options.artifact, snapshot));
    if (!options.context.dryRun) {
      await options.state.complete(run.stateKey, options.hash);
      await options.afterApplied?.(run, snapshot);
    }
  }
  return outputs;
}

function sinkIdentity(sink: InternFlowConfig['jobs'][string]['sinks'][number]): string {
  const target = sink.type === 'lark'
    ? { type: sink.type, document: sink.document, profile: sink.profile || '', mode: sink.mode }
    : { type: sink.type, directory: sink.directory, filename: sink.filename };
  return createHash('sha256').update(JSON.stringify(target)).digest('hex').slice(0, 16);
}
