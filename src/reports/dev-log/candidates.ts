import type { SourceConfig } from '../../core/config.js';
import type { DecisionAssessment, DecisionSignal } from '../../core/contracts/index.js';
import { withDecisionId } from '../../core/decision-audit.js';
import { isMetaMaintenanceText, matchesConfiguredText } from '../../core/source-filter.js';
import { stableHash } from '../../work-items/index.js';
import type { WorkItem } from '../../work-items/types.js';
import type { DevLogCandidate } from './types.js';

export function projectDevLogCandidates(
  workItems: WorkItem[],
  config: SourceConfig = { type: 'codex' },
  assessments: DecisionAssessment[] = [],
): DevLogCandidate[] {
  const projected = workItems.flatMap((item) => {
    const files = [...new Set(item.changes.flatMap((change) => change.files))]
      .filter((file) => !/(?:^|\/)(?:node_modules|\.git|dist|coverage)(?:\/|$)|\.tsbuildinfo$|\.(?:log|jsonl)$/i.test(file));
    // Daily 与 DevLog 必须共享同一个确定性 WorkItem 标题，禁止下游再次推断。
    const candidateTitle = item.title;
    const text = [
      candidateTitle, item.goal, item.repositoryKey, ...item.actions, ...item.outcomes, ...files,
    ].join('\n');
    const sourceAccepted = !isMetaMaintenanceText(text) && matchesConfiguredText(text, config);
    const evaluated = sectionFor(item, text);
    const section = sourceAccepted ? evaluated.section : null;
    assessments.push(admissionAssessment(
      item, section, sourceAccepted, evaluated.score, evaluated.signals,
      sourceAccepted ? evaluated.message : '工作项属于报告维护内容或未通过来源过滤',
    ));
    if (!section) return [];
    const evidenceIds = [...new Set(item.evidenceIds)].sort();
    const facts = [...new Set([
      item.goal,
      ...item.actions,
      ...item.outcomes,
      ...item.decisions,
      ...item.blockers,
    ].filter(Boolean))].slice(0, 16);
    const contentFingerprint = stableHash(JSON.stringify({
      subjectKey: item.subjectKey,
      section,
      status: item.status,
      evidenceIds,
      facts,
    }));
    return [{
      id: stableHash(`${item.id}|${section}|${contentFingerprint}`),
      subjectKey: item.subjectKey,
      section,
      operation: 'append' as const,
      title: candidateTitle,
      repositoryKey: item.repositoryKey,
      ...(item.branch ? { branch: item.branch } : {}),
      ...(item.commits?.length ? { commits: item.commits } : {}),
      ...(item.startedAt ? { startedAt: item.startedAt } : {}),
      status: item.status,
      facts,
      files,
      excerpts: item.changes.flatMap((change) => change.excerpts).slice(0, 6),
      verificationSummary: verificationSummary(item),
      evidenceIds,
      contentFingerprint,
    }];
  });
  return mergeRequirementCandidates(projected);
}

function mergeRequirementCandidates(candidates: DevLogCandidate[]): DevLogCandidate[] {
  const branchScopes = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (candidate.section !== 'requirement' || !candidate.branch) continue;
    const branchKey = `${candidate.repositoryKey || ''}|${candidate.branch}`;
    const scopes = branchScopes.get(branchKey) || new Set<string>();
    for (const scope of businessScopes(candidate.files)) scopes.add(scope);
    branchScopes.set(branchKey, scopes);
  }

  const groups = new Map<string, DevLogCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.section !== 'requirement' || !candidate.branch) {
      groups.set(`candidate:${candidate.id}`, [candidate]);
      continue;
    }
    const branchKey = `${candidate.repositoryKey || ''}|${candidate.branch}`;
    const scopes = businessScopes(candidate.files);
    const knownScopes = branchScopes.get(branchKey) || new Set<string>();
    // 配置、IDL 等辅助文件在该分支只有一个业务域时，归入同一需求；多个业务域时保持独立。
    const scope = scopes[0] || (knownScopes.size === 1 ? [...knownScopes][0] : `aux:${candidate.subjectKey}`);
    const key = `${branchKey}|${scope}`;
    const values = groups.get(key) || [];
    values.push(candidate);
    groups.set(key, values);
  }
  return [...groups.values()].map(mergeCandidateGroup);
}

function mergeCandidateGroup(values: DevLogCandidate[]): DevLogCandidate {
  if (values.length === 1) return values[0]!;
  const facts = unique(values.flatMap((item) => item.facts));
  const files = unique(values.flatMap((item) => item.files));
  const evidenceIds = unique(values.flatMap((item) => item.evidenceIds)).sort();
  const subjectKey = stableHash(`devlog-requirement|${values[0]?.repositoryKey || ''}|${values[0]?.branch || ''}|${businessScopes(files).join('|')}`);
  const status = values.some((item) => item.status === 'blocked')
    ? 'blocked'
    : values.some((item) => item.status === 'in_progress') ? 'in_progress' : 'completed';
  const title = [...values].sort((left, right) => candidateTitleScore(right.title) - candidateTitleScore(left.title)
    || left.title.length - right.title.length)[0]?.title || values[0]!.title;
  const contentFingerprint = stableHash(JSON.stringify({ subjectKey, section: 'requirement', status, evidenceIds, facts }));
  const startedAt = values.map((item) => item.startedAt || '').filter(Boolean).sort()[0];
  return {
    ...values[0]!,
    id: stableHash(`${subjectKey}|requirement|${contentFingerprint}`),
    subjectKey,
    title,
    status,
    facts,
    files,
    excerpts: values.flatMap((item) => item.excerpts).slice(0, 6),
    verificationSummary: unique(values.map((item) => item.verificationSummary)).join('；'),
    evidenceIds,
    contentFingerprint,
    ...(values.flatMap((item) => item.commits || []).length
      ? { commits: unique(values.flatMap((item) => item.commits || [])) }
      : {}),
    ...(startedAt ? { startedAt } : {}),
  };
}

function businessScopes(files: string[]): string[] {
  return unique(files.flatMap((file) => {
    const parts = file.replace(/\\/g, '/').split('/').filter(Boolean);
    for (const marker of ['features', 'pages', 'domain']) {
      const index = parts.indexOf(marker);
      if (index >= 0 && parts[index + 1]) return [parts.slice(index, index + 2).join('/')];
    }
    const subPackage = parts.indexOf('sub-packages');
    return subPackage >= 0 && parts[subPackage + 2]
      ? [parts.slice(subPackage, subPackage + 3).join('/')]
      : [];
  })).sort((left, right) => scopePriority(left) - scopePriority(right) || left.localeCompare(right));
}

function scopePriority(value: string): number {
  if (value.startsWith('sub-packages/')) return 0;
  if (value.startsWith('pages/')) return 1;
  if (value.startsWith('features/')) return 2;
  return 3;
}

function candidateTitleScore(title: string): number {
  let score = Math.min(title.length, 32);
  if (title.length >= 6 && title.length <= 28) score += 8;
  if (/(贴纸|海报|模板|上传|预览|下载|核销|报名|活动|页面|接口|组件)/.test(title)) score += 8;
  if (/^(?:这个|那个|这里|你的|给我|再|现在)|(?:怎么实现|能实现|分析|看看)$/.test(title)) score -= 12;
  if (/(?:status_code|status_msg|\bconst\b|container|service|serivice|commit|push|git|diff|incut_)/i.test(title)) score -= 16;
  if (/^[A-Za-z0-9_.-]+(?:功能开发|代码重构)$/.test(title)) score -= 10;
  return score;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function sectionFor(item: WorkItem, text: string): {
  section: DevLogCandidate['section'] | null;
  score: number;
  signals: DecisionSignal[];
  message: string;
} {
  const hasChange = item.changes.length > 0;
  const hasPassedVerification = item.verifications.some((value) => value.outcome === 'passed');
  const explicitRequirement = item.kind === 'feature'
    || /需求|业务|用户|功能|页面|接口|组件|活动|打卡|排行榜|小程序|客户端|服务端/i.test(text);
  const stableProductModule = item.changes.some((change) => change.files.some((file) => /(?:^|\/)(?:apps?|packages?|src)\//i.test(file)));
  const deliveryReference = Boolean(item.branch || item.commits?.length);
  const personalTooling = /grok2api|个人工具|本机配置|环境配置|代理配置|模型接入|命令行工具|\bcli\b/i.test(text);
  const temporaryExploration = /临时脚本|仅调研|探索验证|一次性脚本/i.test(text);
  const score = (explicitRequirement ? 3 : 0)
    + (hasChange ? 3 : 0)
    + (stableProductModule ? 2 : 0)
    + (hasPassedVerification ? 1 : 0)
    + (deliveryReference ? 1 : 0)
    - (personalTooling ? 4 : 0)
    - (temporaryExploration ? 4 : 0);
  const signals: DecisionSignal[] = [
    { key: 'work-kind', value: item.kind, contribution: 0, message: `工作类型为 ${item.kind}` },
    { key: 'material-change', value: hasChange, contribution: hasChange ? 3 : 0, message: hasChange ? '存在真实代码改动' : '没有真实代码改动' },
    { key: 'requirement-intent', value: explicitRequirement, contribution: explicitRequirement ? 3 : 0, message: explicitRequirement ? '目标包含产品或业务交付语义' : '未发现明确产品或业务语义' },
    { key: 'stable-product-module', value: stableProductModule, contribution: stableProductModule ? 2 : 0, message: stableProductModule ? '改动位于稳定产品代码范围' : '未识别稳定产品代码范围' },
    { key: 'passed-verification', value: hasPassedVerification, contribution: hasPassedVerification ? 1 : 0, message: hasPassedVerification ? '存在通过验证' : '未记录通过验证' },
    { key: 'delivery-reference', value: deliveryReference, contribution: deliveryReference ? 1 : 0, message: deliveryReference ? '存在分支或提交引用' : '未记录分支或提交引用' },
    { key: 'personal-tooling', value: personalTooling, contribution: personalTooling ? -4 : 0, message: personalTooling ? '命中个人工具或本机配置语义' : '未命中个人工具语义' },
    { key: 'temporary-exploration', value: temporaryExploration, contribution: temporaryExploration ? -4 : 0, message: temporaryExploration ? '命中临时探索或一次性脚本语义' : '未命中临时探索语义' },
  ];
  if (item.kind === 'bugfix' && hasChange) {
    return { section: 'bugfix', score, signals, message: '问题修复具备真实改动，进入 Bug-fix 汇总' };
  }
  if ((item.kind === 'feature' || item.kind === 'refactor')
    && hasChange
    // 需求开发记录只接收稳定产品代码；插件、个人工作流等工具改动留在日报。
    && stableProductModule
    // 持续需求分支或已有提交可以证明重构归属；零散重构仍要求当天验证通过。
    && (item.kind !== 'refactor' || hasPassedVerification || deliveryReference)
    && score >= 6) {
    return { section: 'requirement', score, signals, message: '产品交付语义达到需求开发记录准入门槛' };
  }
  if (item.decisions.length && hasPassedVerification && item.kind === 'research') {
    return { section: 'insight', score, signals, message: '调研形成明确决策并通过验证，进入个人沉淀' };
  }
  return { section: null, score, signals, message: personalTooling ? '个人工具工作只进入日报，不进入需求开发记录' : '当前证据不足以进入需求、Bug-fix 或个人沉淀' };
}

function admissionAssessment(
  item: WorkItem,
  section: DevLogCandidate['section'] | null,
  sourceAccepted: boolean,
  score: number,
  signals: DecisionSignal[],
  message: string,
): DecisionAssessment {
  const evidence = item.evidenceIds.map((id) => ({ kind: 'work-evidence' as const, id }));
  return withDecisionId({
    kind: 'assessment' as const,
    policyId: 'devlog.admission',
    policyVersion: '1.0.0',
    subject: { kind: 'work-item' as const, id: item.id },
    outcome: section || 'exclude',
    confidence: item.confidence === 'confirmed' ? 'high' as const : 'medium' as const,
    gates: [
      { key: 'source-scope', passed: sourceAccepted, message: sourceAccepted ? '工作项属于允许的来源范围' : '工作项未通过来源范围', evidence },
      { key: 'material-change-or-insight', passed: item.changes.length > 0 || section === 'insight', message: item.changes.length > 0 ? '存在真实改动' : section === 'insight' ? '存在可验证研究结论' : '没有真实改动或可验证研究结论', evidence },
    ],
    signals,
    reasons: [{ code: section ? `devlog.admission.${section}` : 'devlog.admission.exclude', message, evidence }],
    evidence,
    ...(['feature', 'refactor'].includes(item.kind)
      ? { score: { value: score, threshold: 6, direction: 'higher' as const } }
      : {}),
    constraints: [],
  });
}

function verificationSummary(item: WorkItem): string {
  if (!item.verifications.length) return '未记录结构化验证结果';
  return item.verifications.slice(-6).map((value) => {
    const label = value.outcome === 'passed' ? '通过' : value.outcome === 'failed' ? '失败' : '结果未知';
    return `${compactCommand(value.command)}：${label}`;
  }).join('；');
}

function compactCommand(value: string): string {
  const command = value.replace(/\s+/g, ' ').trim();
  return command.length > 220 ? `${command.slice(0, 219)}…` : command;
}
