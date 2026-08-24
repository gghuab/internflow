import type {
  Activity,
  CaptureSnapshot,
  DecisionAssessment,
  DecisionReason,
  DecisionSignal,
  WorkEvidence,
} from '../../core/contracts/index.js';
import { withDecisionId } from '../../core/decision-audit.js';
import { mergedActiveDurationMinutes } from '../../core/activity-duration.js';
import { classifyWorkItem, isWorkRelated } from '../policies/classification.js';
import { stableHash, subjectKeyFor } from '../policies/identity.js';
import { inferWorkItemTitle } from '../policies/title.js';
import { reduceVerifications, verificationAppliesToFiles } from '../policies/verification.js';
import type { WorkItem } from '../types.js';
import { compactFact, isCompletionMessage, isUsefulFact, workGoal } from './text.js';
import { assertTraceability } from './traceability.js';

export interface WorkItemInput {
  activities: Activity[];
  evidence: WorkEvidence[];
  snapshot?: CaptureSnapshot;
}

interface ProvisionalGroup {
  activities: Activity[];
  evidence: WorkEvidence[];
  fallbackKey: string;
}

export function assembleWorkItems(
  input: WorkItemInput,
  assessments: DecisionAssessment[] = [],
): WorkItem[] {
  const evidenceByRoot = groupEvidenceByRoot(input.evidence);
  const provisional = input.activities.map((activity) => ({
    activities: [activity],
    evidence: evidenceByRoot.get(activity.rootSessionId || activity.id) || [],
    fallbackKey: activity.rootSessionId || activity.id,
  }));
  const merged = new Map<string, ProvisionalGroup>();
  for (const group of provisional) {
    const goal = workGoal(group.evidence, group.activities);
    // 主题身份只使用真实改动文件；验证输出、临时审计文件不能把同一任务拆组或串组。
    const files = materialFiles(group.evidence, group.activities);
    const repositoryKey = repositoryFor(group);
    const branch = group.evidence.find((item) => item.branch)?.branch || group.activities[0]?.gitBranch;
    const subjectKey = subjectKeyFor({
      repositoryKey,
      ...(branch ? { branch } : {}),
      files,
      goal,
      fallbackKey: group.fallbackKey,
    });
    assessments.push(workAssessment({
      policyId: 'work.identity',
      subjectId: subjectKey,
      outcome: existingIdentityOutcome(merged.has(subjectKey)),
      confidence: files.length || branch ? 'high' : 'medium',
      evidence: group.evidence,
      signals: [
        signal('repository', repositoryKey, '仓库范围参与主题身份计算'),
        signal('branch', branch || '', branch ? '分支参与主题身份计算' : '未记录分支'),
        signal('file-count', files.length, `使用 ${files.length} 个真实改动文件计算范围`),
        signal('goal', goal, '目标主题参与身份计算'),
      ],
      reason: merged.has(subjectKey)
        ? reason('work.identity.merged', '与已有主题身份一致，合并为同一工作项', group.evidence)
        : reason('work.identity.new-subject', '生成新的稳定工作主题', group.evidence),
    }));
    const existing = merged.get(subjectKey);
    if (existing) {
      existing.activities.push(...group.activities);
      existing.evidence.push(...group.evidence);
    } else {
      merged.set(subjectKey, group);
    }
  }
  const validEvidenceIds = new Set(input.evidence.map((item) => item.id));
  const validEventIds = new Set(input.snapshot?.events.map((item) => item.occurrenceId) || []);
  return [...merged.entries()]
    .map(([subjectKey, group]) => assembleOne(subjectKey, group, assessments))
    .filter((item): item is WorkItem => item !== null)
    .map((item) => assertTraceability(item, validEvidenceIds, validEventIds, Boolean(input.snapshot)))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

function assembleOne(
  subjectKey: string,
  group: ProvisionalGroup,
  assessments: DecisionAssessment[],
): WorkItem | null {
  const evidence = uniqueById(group.evidence).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  const activities = uniqueById(group.activities).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  const goal = workGoal(evidence, activities);
  const searchText = [goal, ...evidence.map((item) => item.summary), ...activities.flatMap((item) => item.userMessages)].join('\n');
  const workRelated = isWorkRelated(searchText, evidence);
  assessments.push(workAssessment({
    policyId: 'work.relevance', subjectId: subjectKey,
    outcome: workRelated ? 'include' : 'exclude',
    confidence: evidence.length ? 'high' : 'low', evidence,
    signals: [
      signal('evidence-count', evidence.length, `共 ${evidence.length} 条工作证据`),
      signal('has-change-or-verification', evidence.some((item) => ['change', 'verification', 'delivery'].includes(item.kind)), '检查真实改动、验证或交付信号'),
    ],
    reason: workRelated
      ? reason('work.relevance.work-signal', '存在可追溯的开发工作信号', evidence)
      : reason('work.relevance.no-work-signal', '未发现足以形成工作项的开发信号', evidence),
  }));
  if (!workRelated) return null;
  const files = materialFiles(evidence, activities);
  // 验证失败描述执行结果，不应反向把明确的功能开发分类成 Bug 修复。
  const classificationText = [
    goal,
    ...evidence.filter((item) => !['error', 'verification'].includes(item.kind)).map((item) => item.summary),
    ...activities.flatMap((item) => item.userMessages),
  ].join('\n');
  const kind = classifyWorkItem(goal, evidence, classificationText);
  const verifications = reduceVerifications(evidence);
  const failed = verifications.filter((item) => item.outcome === 'failed');
  const delivery = evidence.filter((item) => item.kind === 'delivery');
  const changes = evidence.filter((item) => item.kind === 'change').map((item) => ({
    files: item.files,
    summary: item.summary,
    excerpts: item.codeExcerpts || [],
    evidenceIds: [item.id],
  }));
  const decisions = unique(evidence.filter((item) => item.kind === 'decision')
    .map((item) => compactFact(item.summary))).slice(0, 8);
  const passed = verifications.filter((item) => item.outcome === 'passed');
  const outcomes = unique([
    ...delivery.map((item) => compactFact(item.summary)),
    ...passed.map((item) => `${item.command} 通过`),
    ...activities.flatMap((item) => item.assistantMessages.filter(isCompletionMessage).slice(-2).map(compactFact)),
  ]).filter(isUsefulFact).slice(0, 8);
  const hasExplicitCompletion = outcomes.some(isCompletionMessage);
  // 最终失败的结构化验证优先于助手的自然语言“已完成”；只有真实交付证据可以关闭它。
  const relevantFailures = failed.filter((item) => verificationAppliesToFiles(item, files));
  // 自然语言“已完成”或另一条命令通过，都不能覆盖仍然失败的验证链。
  const unresolvedFailures = delivery.length ? [] : relevantFailures;
  const status = delivery.length
    ? 'completed'
    : unresolvedFailures.length
      ? 'blocked'
      : kind === 'research' && !changes.length
      ? 'investigated'
      : changes.length && (passed.length || hasExplicitCompletion)
        ? 'completed'
        : 'in_progress';
  const durationReliable = activities.every((item) => item.durationReliable);
  const evidenceIds = evidence.map((item) => item.id);
  const branch = evidence.find((item) => item.branch)?.branch || activities.find((item) => item.gitBranch)?.gitBranch;
  const commits = unique(evidence.map((item) => item.commit || ''));
  const item: WorkItem = {
    id: stableHash(`${subjectKey}|${[...evidenceIds].sort().join('|')}`),
    subjectKey,
    repositoryKey: repositoryFor(group),
    ...(branch ? { branch } : {}),
    ...(commits.length ? { commits } : {}),
    kind,
    status,
    // 标题来自稳定分支或工作事实，不把外部会话标题直接透传到日报和需求档案。
    title: inferWorkItemTitle(
      goal,
      outcomes,
      files,
      kind,
      activities.flatMap((activity) => activity.userMessages),
      branch,
    ),
    goal,
    actions: unique([
      ...changes.map((item) => compactFact(item.summary)),
      ...decisions,
      ...verifications.map((item) => `${item.command}：${item.outcome}`),
    ]).slice(0, 12),
    outcomes,
    decisions,
    changes,
    verifications,
    blockers: unresolvedFailures.map((item) => `${item.command} 最终失败${item.exitCode === null ? '' : `（退出码 ${item.exitCode}）`}`),
    startedAt: activities[0]?.startedAt || evidence[0]?.timestamp || '',
    endedAt: activities.at(-1)?.endedAt || evidence.at(-1)?.timestamp || '',
    activeMinutes: durationReliable
      ? mergedActiveDurationMinutes(activities)
      : null,
    durationReliable,
    sessionIds: activities.map((item) => item.id),
    evidenceIds,
    confidence: evidence.every((item) => item.confidence !== 'unknown') ? 'confirmed' : 'partial',
  };
  const confidence = item.confidence === 'confirmed' ? 'high' : 'medium';
  assessments.push(
    workAssessment({
      policyId: 'work.goal', subjectId: item.id, outcome: item.goal || 'unknown', confidence,
      evidence, signals: [signal('goal-length', item.goal.length, '目标文本长度')],
      reason: reason('work.goal.selected', '从请求与会话事实中选择工作目标', evidence),
    }),
    workAssessment({
      policyId: 'work.kind', subjectId: item.id, outcome: item.kind, confidence,
      evidence,
      signals: [
        signal('has-change', item.changes.length > 0, '是否存在真实改动'),
        signal('has-delivery', delivery.length > 0, '是否存在交付证据'),
        signal('kind', item.kind, `按目标语义和证据优先级分类为 ${item.kind}`),
      ],
      reason: reason(`work.kind.${item.kind}`, `工作类型判定为 ${item.kind}`, evidence),
    }),
    workAssessment({
      kind: 'gate', policyId: 'work.status', subjectId: item.id, outcome: item.status, confidence,
      evidence,
      gates: [
        { key: 'delivery', passed: delivery.length > 0, message: delivery.length ? '存在真实交付证据' : '未发现真实交付证据', evidence: evidenceRefs(delivery) },
        { key: 'unresolved-failure', passed: unresolvedFailures.length === 0, message: unresolvedFailures.length ? '仍存在适用于本次改动的最终失败验证' : '没有未解决的相关失败验证', evidence: evidenceRefs(unresolvedFailures.flatMap((failure) => evidence.filter((item) => failure.evidenceIds.includes(item.id)))) },
      ],
      signals: [
        signal('change-count', item.changes.length, `共 ${item.changes.length} 组真实改动`),
        signal('passed-verification-count', passed.length, `共 ${passed.length} 条通过验证`),
      ],
      reason: reason(`work.status.${item.status.replaceAll('_', '-')}`, `工作状态判定为 ${item.status}`, evidence),
    }),
    workAssessment({
      policyId: 'work.title', subjectId: item.id, outcome: item.title, confidence,
      evidence,
      signals: [
        signal('goal-available', Boolean(goal), '是否存在可用目标'),
        signal('outcome-count', outcomes.length, `共 ${outcomes.length} 条结果候选`),
        signal('file-count', files.length, `共 ${files.length} 个文件范围候选`),
      ],
      reason: reason('work.title.selected', `选择“${item.title}”作为稳定工作标题`, evidence),
    }),
  );
  for (const verification of item.verifications) {
    const verificationEvidence = evidence.filter((value) => verification.evidenceIds.includes(value.id));
    assessments.push(workAssessment({
      kind: 'gate', policyId: 'work.verification', subjectId: `${item.id}:${verification.normalizedCommand}`,
      outcome: verification.outcome, confidence, evidence: verificationEvidence,
      gates: [{
        key: 'final-result', passed: verification.outcome === 'passed',
        message: `同一验证命令的最终结构化结果为 ${verification.outcome}`,
        evidence: evidenceRefs(verificationEvidence),
      }],
      signals: [signal('attempt-count', verification.evidenceIds.length, `共记录 ${verification.evidenceIds.length} 次验证尝试`)],
      reason: reason('work.verification.latest-result', '同一命令按时间采用最后一个有明确退出码的结果', verificationEvidence),
    }));
  }
  return item;
}

function groupEvidenceByRoot(evidence: WorkEvidence[]): Map<string, WorkEvidence[]> {
  const result = new Map<string, WorkEvidence[]>();
  for (const item of evidence) {
    const root = item.workItemKey.split('|').at(-1) || item.workItemKey;
    const values = result.get(root) || [];
    values.push(item);
    result.set(root, values);
  }
  return result;
}

function repositoryFor(group: ProvisionalGroup): string {
  return group.evidence.find((item) => item.repository)?.repository
    || group.evidence.find((item) => item.workspace)?.workspace
    || group.activities.find((item) => item.cwd)?.cwd
    || 'unknown-repository';
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function materialFiles(evidence: WorkEvidence[], activities: Activity[]): string[] {
  return unique([
    ...evidence.filter((item) => item.kind === 'change').flatMap((item) => item.files),
    ...activities.flatMap((item) => item.changedFiles),
  ]);
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => !seen.has(value.id) && Boolean(seen.add(value.id)));
}

function existingIdentityOutcome(existing: boolean): string {
  return existing ? 'merge' : 'new';
}

function signal(key: string, value: string | number | boolean, message: string): DecisionSignal {
  return { key, value, message };
}

function reason(code: string, message: string, evidence: WorkEvidence[]): DecisionReason {
  return { code, message, evidence: evidenceRefs(evidence) };
}

function evidenceRefs(evidence: WorkEvidence[]) {
  return evidence.map((item) => ({ kind: 'work-evidence' as const, id: item.id }));
}

function workAssessment(input: {
  kind?: DecisionAssessment['kind'];
  policyId: string;
  subjectId: string;
  outcome: string;
  confidence: DecisionAssessment['confidence'];
  evidence: WorkEvidence[];
  gates?: DecisionAssessment['gates'];
  signals: DecisionSignal[];
  reason: DecisionReason;
}): DecisionAssessment {
  return withDecisionId({
    kind: input.kind || 'assessment',
    policyId: input.policyId,
    policyVersion: '1.0.0',
    subject: { kind: 'work-item', id: input.subjectId },
    outcome: input.outcome,
    confidence: input.confidence,
    gates: input.gates || [],
    signals: input.signals,
    reasons: [input.reason],
    evidence: evidenceRefs(input.evidence),
    constraints: [],
  });
}
