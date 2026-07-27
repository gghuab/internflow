import type { ActivityBatch, RunContext } from '../../contracts/index.js';
import type { JobStrategy } from './types.js';

export function createWorkspaceStrategy(): JobStrategy {
  return {
    failureTitle: () => 'InternFlow Engineering Memory 同步失败',
    reportableCount: (batch) => batch.workItems?.length || 0,
    async prepareBatch(batch) {
      if (!batch.workItems) throw new Error('Workspace sync requires a WorkItem projection.');
    },
    async saveInput() {},
    decorateEmptyResult: (result) => result,
    async prepareGeneration(batch, snapshot, context) {
      assertCaptureReady(batch, context);
      return snapshot;
    },
    assertArtifact(artifact) {
      if (artifact.kind !== 'workspace') {
        throw new Error('Workspace generator returned a non-Workspace artifact.');
      }
    },
    async saveGenerated() {},
    async afterSinkApplied() {},
    decorateResult: (result) => result,
    async saveRunResult() {},
    async saveFailure() {},
  };
}

function assertCaptureReady(batch: ActivityBatch, context: RunContext): void {
  const snapshot = batch.captureSnapshot;
  if (!snapshot) throw new Error('Workspace sync requires a capture snapshot.');
  if (!snapshot.finalized) {
    throw new Error(
      `Workspace sync for ${context.date} requires a finalized capture snapshot. `
      + 'Run it after source.dayEndTime or after the calendar day closes.',
    );
  }
  if (snapshot.quality.coverage !== 'high' || snapshot.quality.accountingDifference !== 0) {
    throw new Error(
      `Workspace sync blocked by capture quality: ${snapshot.quality.reasons.join('; ')
        || snapshot.quality.coverage}`,
    );
  }
}
