import type { SourceConfig } from '../../core/config.js';
import type { CaptureSummary, DecisionAssessment } from '../../core/contracts/index.js';
import { withDecisionId } from '../../core/decision-audit.js';
import { isMetaMaintenanceText, matchesConfiguredText } from '../../core/source-filter.js';
import type { WorkItem } from '../../work-items/types.js';
import type { DailyReportView } from './types.js';
import { allocateVisualPlan, evaluateVisualNeed } from './visual-policy.js';

export function projectDailyWorkItems(
  workItems: WorkItem[],
  config: SourceConfig,
  capture?: CaptureSummary,
  assessments: DecisionAssessment[] = [],
): DailyReportView {
  const items = workItems.filter((item) => {
    const text = workItemSearchText(item);
    const included = !isMetaMaintenanceText(text) && matchesConfiguredText(text, config);
    assessments.push(itemAssessment(
      'daily.inclusion', item, included ? 'include' : 'exclude', 0, 0,
      included ? '工作项符合日报来源范围' : '工作项属于元维护内容或未通过来源过滤',
    ));
    return included;
  });
  const reliable = items.filter((item) => item.durationReliable && item.activeMinutes !== null)
    .sort((a, b) => (b.activeMinutes || 0) - (a.activeMinutes || 0) || a.id.localeCompare(b.id));
  const longest = reliable[0];
  const tied = longest
    ? reliable.filter((item) => Math.abs((item.activeMinutes || 0) - (longest.activeMinutes || 0)) <= 1)
    : [];
  const excludedUnreliableCount = items.length - reliable.length;
  const deepDive = items.map((item) => evaluateContent(item, 'deep-dive'));
  const takeaway = items.map((item) => evaluateContent(item, 'takeaway'));
  const visual = items.map(evaluateVisualNeed);
  assessments.push(...deepDive.map((item) => item.assessment));
  assessments.push(...takeaway.map((item) => item.assessment));
  assessments.push(...visual.map((item) => item.assessment));
  const reportId = items[0]?.startedAt.slice(0, 10) || 'unknown-date';
  const visualBudget = allocateVisualPlan(visual, reportId);
  assessments.push(visualBudget.assessment);
  assessments.push(withDecisionId({
    kind: 'assessment' as const, policyId: 'daily.longest', policyVersion: '1.0.0',
    subject: { kind: 'daily-report' as const, id: reportId },
    outcome: !reliable.length ? 'unavailable' : tied.length > 1 ? 'tied' : 'selected',
    confidence: reliable.length ? 'high' as const : 'low' as const,
    gates: [{ key: 'reliable-duration', passed: reliable.length > 0, message: reliable.length ? '存在可靠活跃时长' : '没有可靠活跃时长', evidence: reliable.map((item) => ({ kind: 'work-item' as const, id: item.id })) }],
    signals: [
      { key: 'reliable-count', value: reliable.length, message: `${reliable.length} 个任务参与排名` },
      { key: 'excluded-unreliable-count', value: excludedUnreliableCount, message: `${excludedUnreliableCount} 个任务因时长不可靠被排除` },
    ],
    reasons: [{
      code: tied.length > 1 ? 'daily.longest.tied' : reliable.length ? 'daily.longest.selected' : 'daily.longest.unavailable',
      message: tied.length > 1 ? '多个可靠任务耗时相差不超过 1 分钟' : reliable.length ? '按可靠活跃时长选择最长任务' : '没有可靠时长，不进行最长任务排名',
      evidence: reliable.map((item) => ({ kind: 'work-item' as const, id: item.id })),
    }],
    evidence: reliable.map((item) => ({ kind: 'work-item' as const, id: item.id })), constraints: [],
  }));
  return {
    items,
    longestWorkItemId: tied.length === 1 ? longest?.id || null : null,
    longestTiedIds: tied.length > 1 ? tied.map((item) => item.id) : [],
    longestReason: !items.length
      ? '当天没有可汇报工作项'
      : !reliable.length
        ? '全部工作项时长均不可靠，不进行排名'
        : tied.length > 1
          ? '多个可靠工作项耗时相差不超过 1 分钟'
          : '按目标日期内可靠活跃时长排名',
    excludedUnreliableCount,
    deepDiveCandidateIds: deepDive.filter((item) => item.value).map((item) => item.item.id),
    takeawayCandidateIds: takeaway.filter((item) => item.value).map((item) => item.item.id),
    visualPlan: visualBudget.plan,
    quality: {
      coverage: capture?.coverage || 'high',
      reasons: capture?.reasons || [],
    },
  };
}

function evaluateContent(item: WorkItem, type: 'deep-dive' | 'takeaway') {
  const crossModule = new Set(item.changes.flatMap((change) => change.files)
    .map((file) => file.split('/').slice(0, -1).join('/'))).size >= 2;
  const failThenPass = item.verifications.some((value) => value.outcome === 'passed' && value.evidenceIds.length > 1);
  const score = type === 'deep-dive'
    ? (item.kind === 'research' ? 3 : 0) + (item.decisions.length ? 2 : 0)
      + (crossModule ? 1 : 0) + (failThenPass ? 2 : 0) + (item.actions.length >= 3 ? 1 : 0)
      - (!item.decisions.length && item.kind !== 'research' ? 2 : 0)
    : (item.decisions.length ? 2 : 0) + (item.verifications.length ? 2 : 0)
      + (item.actions.length >= 3 ? 2 : 0) + (item.blockers.length ? 1 : 0)
      - (item.actions.length <= 1 && !item.decisions.length ? 3 : 0);
  const included = score >= 4;
  return {
    item,
    value: included,
    assessment: itemAssessment(
      `daily.${type}`, item, included ? 'include' : 'exclude', score, 4,
      included
        ? type === 'deep-dive' ? '存在值得解释的机制、决策或验证闭环' : '可以沉淀为可复用的默认动作和验证方法'
        : type === 'deep-dive' ? '当前事实不足以形成有价值的技术深挖' : '当前内容更像一次性结果，不形成方法沉淀',
    ),
  };
}

function itemAssessment(
  policyId: string,
  item: WorkItem,
  outcome: string,
  score: number,
  threshold: number,
  message: string,
): DecisionAssessment {
  const evidence = item.evidenceIds.map((id) => ({ kind: 'work-evidence' as const, id }));
  return withDecisionId({
    kind: 'assessment', policyId, policyVersion: '1.0.0',
    subject: { kind: 'work-item', id: item.id }, outcome,
    confidence: item.confidence === 'confirmed' ? 'high' : 'medium', gates: [],
    signals: [
      { key: 'decision-count', value: item.decisions.length, message: `${item.decisions.length} 条明确决策` },
      { key: 'verification-count', value: item.verifications.length, message: `${item.verifications.length} 条验证记录` },
      { key: 'action-count', value: item.actions.length, message: `${item.actions.length} 条推进动作` },
    ],
    reasons: [{ code: `${policyId}.${outcome}`, message, evidence }], evidence,
    ...(threshold ? { score: { value: score, threshold, direction: 'higher' as const } } : {}),
    constraints: [],
  });
}

function workItemSearchText(item: WorkItem): string {
  return [
    item.title, item.goal, item.repositoryKey, ...item.actions, ...item.outcomes,
    ...item.decisions, ...item.changes.flatMap((change) => change.files),
  ].join('\n');
}
