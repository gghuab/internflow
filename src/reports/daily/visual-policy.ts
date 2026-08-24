import type {
  DecisionAssessment,
  Evaluated,
  VisualMode,
  VisualPlanItem,
  WorkItem,
} from '../../core/contracts/index.js';
import { withDecisionId } from '../../core/decision-audit.js';

interface VisualCandidate {
  workItem: WorkItem;
  mode: 'none' | VisualMode;
  score: number;
  files: Set<string>;
  topics: Set<string>;
}

export function evaluateVisualNeed(item: WorkItem): Evaluated<VisualCandidate> {
  const files = new Set(item.changes.flatMap((change) => change.files));
  const directories = new Set([...files].map((file) => file.split('/').slice(0, -1).join('/')).filter(Boolean));
  const narrative = [item.goal, ...item.actions, ...item.decisions, ...item.outcomes].join('\n');
  const state = /状态机|状态流转|状态转换|transition|生命周期/i.test(narrative) ? 3 : 0;
  const actorCount = [
    /客户端|前端/i, /服务端|后端/i, /第三方|外部服务/i, /消息队列|事件总线/i,
  ].filter((pattern) => pattern.test(narrative)).length;
  const sequence = actorCount >= 2 || /回调链|跨端调用|跨服务调用/i.test(narrative) ? 2 : 0;
  const branching = /分支|条件|否则|失败|fallback|审核|重试|并发|竞态/i.test(narrative) ? 2 : 0;
  const topology = Math.min(3, Math.max(0, directories.size - 1));
  const temporal = item.actions.length >= 4 ? 2 : item.actions.length >= 3 ? 1 : 0;
  const crossBoundary = directories.size >= 3 ? 2 : directories.size >= 2 ? 1 : 0;
  const compression = item.actions.length + item.decisions.length >= 5 ? 2 : item.actions.length >= 3 ? 1 : 0;
  const evidence = item.confidence === 'confirmed' ? 1 : 0;
  const simpleLinear = item.actions.length > 0 && item.actions.length <= 3
    && !state && !sequence && !branching && directories.size <= 1 ? -3 : 0;
  const score = topology + temporal + crossBoundary + Math.max(state, sequence, branching)
    + compression + evidence + simpleLinear;
  const mode: VisualCandidate['mode'] = score < 3
    ? 'none'
    : score < 6
      ? 'inline'
      : state >= 3
        ? 'state'
        : sequence >= 2
          ? 'sequence'
          : 'flowchart';
  const evidenceRefs = item.evidenceIds.map((id) => ({ kind: 'work-evidence' as const, id }));
  const assessment = withDecisionId({
    kind: 'assessment' as const,
    policyId: 'daily.visual-need', policyVersion: '1.0.0',
    subject: { kind: 'work-item' as const, id: item.id }, outcome: mode,
    confidence: item.confidence === 'confirmed' ? 'high' as const : 'medium' as const,
    gates: [{
      key: 'evidence-available', passed: item.evidenceIds.length > 0,
      message: item.evidenceIds.length ? '图示节点可以追溯到工作证据' : '没有足够证据支撑图示', evidence: evidenceRefs,
    }],
    signals: [
      weighted('topology', topology, topology, '结构拓扑复杂度'),
      weighted('temporal', temporal, temporal, '时序与因果复杂度'),
      weighted('cross-boundary', crossBoundary, crossBoundary, '跨模块或跨系统程度'),
      weighted('branch-state-sequence', Math.max(state, sequence, branching), Math.max(state, sequence, branching), '分支、状态或交互复杂度'),
      weighted('compression-gain', compression, compression, '相对文字的信息压缩收益'),
      weighted('evidence-confidence', evidence, evidence, '证据完整度'),
      weighted('simple-linear-penalty', simpleLinear !== 0, simpleLinear, '三步以内简单线性过程降权'),
    ],
    reasons: [{
      code: `daily.visual-need.${mode}`,
      message: visualReason(mode),
      params: { score }, evidence: evidenceRefs,
    }],
    evidence: evidenceRefs,
    score: { value: score, threshold: mode === 'inline' ? 3 : 6, direction: 'higher' as const },
    constraints: [],
  });
  return {
    value: { workItem: item, mode, score, files, topics: topicTokens(narrative) },
    assessment,
  };
}

export function allocateVisualPlan(
  evaluated: Array<Evaluated<VisualCandidate>>,
  date: string,
): { plan: VisualPlanItem[]; assessment: DecisionAssessment } {
  const selected: VisualCandidate[] = [];
  const plan: VisualPlanItem[] = [];
  const sorted = [...evaluated].sort((left, right) => right.value.score - left.value.score
    || left.value.workItem.id.localeCompare(right.value.workItem.id));
  let fullCount = 0;
  for (const entry of sorted) {
    if (entry.value.mode === 'none') continue;
    const overlap = Math.max(0, ...selected.map((item) => similarity(entry.value, item)));
    const redundancy = overlap >= 0.5 ? overlap : 0;
    const marginal = entry.value.score - redundancy * 3
      - (entry.value.mode === 'inline' ? 0 : Math.max(0, fullCount - 2));
    const accepted = entry.value.mode === 'inline' ? marginal >= 3 : marginal >= 6;
    if (!accepted) continue;
    selected.push(entry.value);
    plan.push({
      workItemId: entry.value.workItem.id,
      mode: entry.value.mode,
      assessmentId: entry.assessment.id,
    });
    if (entry.value.mode !== 'inline') fullCount += 1;
  }

  const full = plan.filter((item) => item.mode !== 'inline');
  const acceptedFull = new Set(full.slice(0, 3).map((item) => item.assessmentId));
  const constrainedPlan = plan.filter((item) => item.mode === 'inline' || acceptedFull.has(item.assessmentId));
  const trimmed = full.length - acceptedFull.size;
  const assessment = withDecisionId({
    kind: 'assessment' as const,
    policyId: 'daily.visual-budget', policyVersion: '1.0.0',
    subject: { kind: 'daily-report' as const, id: date },
    outcome: constrainedPlan.length ? 'selected' : 'none', confidence: 'high' as const,
    gates: [],
    signals: [
      { key: 'candidate-count', value: evaluated.length, message: `评价 ${evaluated.length} 个工作项` },
      { key: 'selected-count', value: constrainedPlan.length, message: `选择 ${constrainedPlan.length} 个互补图示` },
      { key: 'full-diagram-count', value: acceptedFull.size, message: `其中 ${acceptedFull.size} 个完整图` },
    ],
    reasons: [{
      code: constrainedPlan.length ? 'daily.visual-budget.marginal-value' : 'daily.visual-budget.no-positive-value',
      message: constrainedPlan.length ? '按边际信息增益选择互补图示，并控制完整图数量' : '没有图示达到边际信息增益门槛',
      evidence: constrainedPlan.flatMap((item) => item.workItemId ? [{ kind: 'work-item' as const, id: item.workItemId }] : []),
    }],
    evidence: constrainedPlan.flatMap((item) => item.workItemId ? [{ kind: 'work-item' as const, id: item.workItemId }] : []),
    constraints: [{
      key: 'full-diagram-count', passed: trimmed === 0, action: trimmed ? 'trim' as const : 'accept' as const,
      actual: full.length, limit: 3,
      message: trimmed ? `安全上限裁剪 ${trimmed} 个完整图；其内容价值评价仍保留` : '未触发完整图安全上限',
    }],
  });
  return { plan: constrainedPlan, assessment };
}

function weighted(key: string, value: number | boolean, contribution: number, message: string) {
  return { key, value, weight: 1, contribution, message };
}

function visualReason(mode: VisualCandidate['mode']): string {
  if (mode === 'none') return '文字已经足以说明该任务，不生成图示';
  if (mode === 'inline') return '任务关系简单，使用行内箭头比完整流程图更清楚';
  if (mode === 'state') return '任务核心包含状态和事件迁移，适合状态图';
  if (mode === 'sequence') return '任务核心包含多参与方调用顺序，适合时序图';
  return '任务包含跨模块结构、分支或多阶段链路，适合流程图';
}

function topicTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9_-]{3,}|[\u4e00-\u9fff]{2,}/g) || []);
}

function similarity(left: VisualCandidate, right: VisualCandidate): number {
  const file = overlap(left.files, right.files);
  const topic = overlap(left.topics, right.topics);
  return Math.max(file, topic);
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / Math.min(left.size, right.size);
}
