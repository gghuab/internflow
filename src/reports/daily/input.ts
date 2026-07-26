import type { ActivityBatch } from '../../core/contracts/index.js';

export function workItemDailyInput(batch: ActivityBatch) {
  if (!batch.dailyView) return null;
  return {
    date: batch.date,
    captureSnapshotId: batch.captureSnapshot?.id,
    quality: batch.dailyView.quality,
    longestWorkItemId: batch.dailyView.longestWorkItemId,
    longestTiedIds: batch.dailyView.longestTiedIds,
    visualPlan: batch.dailyView.visualPlan,
    items: batch.dailyView.items.map((item) => ({
      id: item.id,
      subjectKey: item.subjectKey,
      kind: item.kind,
      status: item.status,
      title: item.title,
      goal: item.goal,
      actions: item.actions,
      outcomes: item.outcomes,
      decisions: item.decisions,
      changes: item.changes,
      verifications: item.verifications,
      blockers: item.blockers,
      activeMinutes: item.activeMinutes,
      evidenceIds: item.evidenceIds,
    })),
  };
}
