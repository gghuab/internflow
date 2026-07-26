import type { SourceConfig } from '../../core/config.js';
import type { Activity, ActivityBatch, ActivitySourceBatch, RunContext } from '../../core/contracts/index.js';
import { withDecisionId } from '../../core/decision-audit.js';
import { projectDailyWorkItems } from '../../reports/daily/view.js';
import { projectDevLogCandidates } from '../../reports/dev-log/candidates.js';
import { assembleWorkItems } from '../../work-items/index.js';

const DAILY_RULE = '日报以 WorkItem 为唯一语义来源；过滤、标题、时长和 Longest Task 均来自可追溯事实';
const DEV_LOG_RULE = '需求记录只同步具备可追溯 Evidence 的 DevLogCandidate';

export function projectWorkday(
  captured: ActivitySourceBatch,
  context: RunContext,
  config: SourceConfig,
): ActivityBatch {
  const snapshot = captured.captureSnapshot;
  if (!snapshot) throw new Error('Workday projection requires a CaptureSnapshot.');
  const decisionAssessments = [withDecisionId({
    kind: 'gate' as const,
    policyId: 'capture.coverage', policyVersion: '1.0.0',
    subject: { kind: 'capture' as const, id: snapshot.id },
    outcome: snapshot.quality.coverage === 'high' ? 'accept' : snapshot.quality.coverage === 'partial' ? 'degrade' : 'reject',
    confidence: snapshot.quality.coverage === 'high' ? 'high' as const : 'medium' as const,
    gates: [{
      key: 'clean-ledger', passed: snapshot.quality.accountingDifference === 0,
      message: snapshot.quality.accountingDifference === 0 ? '事件记账完整' : `事件记账差额为 ${snapshot.quality.accountingDifference}`,
      evidence: [{ kind: 'capture' as const, id: snapshot.id }],
    }],
    signals: [
      { key: 'coverage', value: snapshot.quality.coverage, message: `采集覆盖度为 ${snapshot.quality.coverage}` },
      { key: 'reason-count', value: snapshot.quality.reasons.length, message: `共有 ${snapshot.quality.reasons.length} 条质量说明` },
    ],
    reasons: [{
      code: `capture.coverage.${snapshot.quality.coverage}`,
      message: snapshot.quality.reasons.join('；') || '采集事件全部完成记账',
      evidence: [{ kind: 'capture' as const, id: snapshot.id }],
    }],
    evidence: [{ kind: 'capture' as const, id: snapshot.id }], constraints: [],
  })];
  const workItems = assembleWorkItems({
    activities: captured.activities,
    evidence: snapshot.evidence,
    snapshot,
  }, decisionAssessments);

  if (context.job.template === 'dev-log') {
    const devLogCandidates = projectDevLogCandidates(workItems, config, decisionAssessments);
    const selectedSubjects = new Set(devLogCandidates.map((candidate) => candidate.subjectKey));
    const selectedItems = workItems.filter((item) => selectedSubjects.has(item.subjectKey));
    const activities = selectActivities(captured.activities, selectedItems.flatMap((item) => item.sessionIds));
    const evidenceIds = new Set(devLogCandidates.flatMap((candidate) => candidate.evidenceIds));
    return projectedBatch(captured, activities, DEV_LOG_RULE, {
      workEvidence: snapshot.evidence.filter((evidence) => evidenceIds.has(evidence.id)),
      workItems,
      devLogCandidates,
      decisionAssessments,
    });
  }

  const dailyView = projectDailyWorkItems(workItems, config, captured.captureSummary, decisionAssessments);
  const activities = selectActivities(captured.activities, dailyView.items.flatMap((item) => item.sessionIds));
  return projectedBatch(captured, activities, DAILY_RULE, {
    workEvidence: snapshot.evidence,
    workItems,
    dailyView,
    decisionAssessments,
  });
}

function projectedBatch(
  captured: ActivitySourceBatch,
  activities: Activity[],
  rule: string,
  workLayer: Pick<ActivityBatch, 'workEvidence' | 'workItems' | 'dailyView' | 'devLogCandidates' | 'decisionAssessments'>,
): ActivityBatch {
  return {
    ...captured,
    activities,
    sessions: activities,
    filteredCount: Math.max(0, captured.sourceCount - activities.length),
    candidateRule: rule,
    sourceSessionCount: captured.sourceCount,
    filteredSessionCount: Math.max(0, captured.sourceCount - activities.length),
    reportableSessionCount: activities.length,
    sessionCount: activities.length,
    ...workLayer,
  };
}

function selectActivities(activities: Activity[], selectedSessionIds: string[]): Activity[] {
  const selected = new Set(selectedSessionIds);
  return activities.filter((activity) => selected.has(activity.id));
}
