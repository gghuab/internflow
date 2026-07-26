import type {
  ActivityBatch,
  WorkspaceCandidate,
} from '../core/contracts/index.js';
import { stableHash } from '../work-items/index.js';

export function buildWorkspaceCandidates(batch: ActivityBatch): WorkspaceCandidate[] {
  const snapshotId = batch.captureSnapshot?.id;
  if (!snapshotId) throw new Error('Workspace sync requires a traceable capture snapshot.');

  return (batch.workItems || []).map((item) => {
    const candidate = {
      date: batch.date,
      workItemId: item.id,
      subjectKey: item.subjectKey,
      title: item.title,
      goal: item.goal,
      kind: item.kind,
      status: item.status,
      repositoryKey: item.repositoryKey,
      ...(item.branch ? { branch: item.branch } : {}),
      actions: item.actions,
      outcomes: item.outcomes,
      decisions: item.decisions,
      changedFiles: [...new Set(item.changes.flatMap((change) => change.files))].sort(),
      verifications: item.verifications,
      blockers: item.blockers,
      activeMinutes: item.activeMinutes,
      durationReliable: item.durationReliable,
      sessionIds: item.sessionIds,
      evidenceIds: item.evidenceIds,
      factCount: item.evidenceIds.length,
      snapshotId,
      commits: item.commits || [],
    };
    return {
      ...candidate,
      // 内容指纹只由工作事实决定；重新采集产生的新 snapshotId 不会制造重复档案。
      contentFingerprint: stableHash(JSON.stringify({
        date: candidate.date,
        workItemId: candidate.workItemId,
        evidenceIds: [...candidate.evidenceIds].sort(),
      })),
    };
  }).sort((left, right) => left.date.localeCompare(right.date)
    || left.workItemId.localeCompare(right.workItemId));
}
