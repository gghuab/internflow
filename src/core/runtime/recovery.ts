import type { StoredRunArtifact } from '../persistence/index.js';
import type { SinkRun } from './sink-pipeline.js';

export function preflightRecovery(
  sinkRuns: SinkRun[],
  stored: StoredRunArtifact | null,
  force: boolean,
): void {
  for (const run of sinkRuns) {
    if (run.state?.status !== 'pending') continue;
    if (!stored) {
      throw new Error(
        `Sink ${run.stateKey} is pending but its immutable artifact is missing. Refusing to regenerate uncertain output.`,
      );
    }
    if (run.state.hash !== stored.hash) {
      throw new Error(
        `Sink ${run.stateKey} belongs to artifact ${run.state.hash}, not ${stored.hash}. Refusing to mix run artifacts.`,
      );
    }
    if (!force) {
      throw new Error(
        `Sink ${run.stateKey} has an uncertain previous write. Inspect the destination, then rerun with --force only when safe.`,
      );
    }
  }
}
