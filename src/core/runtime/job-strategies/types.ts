import type { ActivityBatch, OutputArtifact, RunContext, RunResult, SinkSnapshot } from '../../contracts/index.js';
import type { ArtifactStore } from '../../persistence/index.js';
import type { SinkRun } from '../sink-pipeline.js';

export interface ResultContext {
  sourceCount: number;
  activityCount: number;
  filteredCount: number;
  artifact: OutputArtifact;
  sinkRuns: SinkRun[];
  inspected: Map<number, SinkSnapshot>;
  outputs: Array<Record<string, unknown>>;
}

export interface JobStrategy {
  failureTitle(jobName: string): string;
  prepareBatch(batch: ActivityBatch): Promise<void>;
  saveInput(batch: ActivityBatch): Promise<void>;
  decorateEmptyResult(result: RunResult, sourceCount: number, filteredCount: number): RunResult;
  prepareGeneration(
    batch: ActivityBatch,
    snapshot: SinkSnapshot | undefined,
    context: RunContext,
  ): Promise<SinkSnapshot | undefined>;
  assertArtifact(artifact: OutputArtifact): void;
  saveGenerated(artifact: OutputArtifact, snapshot: SinkSnapshot | undefined): Promise<void>;
  afterSinkApplied(run: SinkRun, snapshot: SinkSnapshot | undefined, artifact: OutputArtifact): Promise<void>;
  decorateResult(result: RunResult, context: ResultContext): RunResult;
  saveRunResult(result: RunResult): Promise<void>;
  saveFailure(message: string): Promise<void>;
  buildBatch?(options: {
    context: RunContext;
    artifacts: ArtifactStore;
    collectDay(date: string): Promise<ActivityBatch>;
  }): Promise<ActivityBatch>;
  reportableCount?(batch: ActivityBatch): number;
}
