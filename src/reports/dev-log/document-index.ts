import type {
  DecisionAssessment,
  DevLogCandidate,
  DevLogWriteTarget,
  HeadingReference,
  SinkSnapshot,
} from '../../core/contracts/index.js';
import { withDecisionId } from '../../core/decision-audit.js';
import type { ResolvedDevLogCandidate } from './types.js';

export const DEV_LOG_APPEND_THRESHOLD = 0.75;
export const DEV_LOG_CREATE_THRESHOLD = 0.45;
export const DEV_LOG_APPEND_MARGIN = 0.15;
export const DEV_LOG_REQUIREMENT_AFFINITY_THRESHOLD = 0.8;
export const DEV_LOG_REQUIREMENT_AFFINITY_MARGIN = 0.08;

const GENERIC_SIMILARITY_TERMS = [
  '需求', '开发', '功能', '问题', '修复', '调整', '修改', '实现',
  '新增', '完成', '处理', '模块', '代码', '记录', '日志', '迭代',
];

interface DocumentTarget {
  heading: HeadingReference;
  target: HeadingReference;
  stableText: string;
  fullText: string;
}

interface Alternative {
  targetRef: string;
  subjectRef: string;
  heading: string;
  score: number;
  indicators: {
    businessGoal: number;
    codeScope: number;
    history: number;
    deliveryReference: number;
    timeContinuity: number;
  };
}

export interface DevLogSubjectBinding {
  blockId?: string;
  headingText?: string;
}

export function resolveDevLogCandidates(
  candidates: DevLogCandidate[],
  snapshot: SinkSnapshot,
  boundTargets: Record<string, string | DevLogSubjectBinding> = {},
  assessments: DecisionAssessment[] = [],
  date = candidates.find((candidate) => candidate.startedAt)?.startedAt?.slice(0, 10) || '日期待确认',
): ResolvedDevLogCandidate[] {
  const headings = (snapshot.headings || []).filter((heading) => heading.level >= 2 && heading.level <= 5);
  const levelTwoRoots = headings.filter((heading) => heading.level === 2 && heading.section);
  const roots = levelTwoRoots.length ? levelTwoRoots : firstHeadingPerSection(headings);
  const targets = documentTargets(headings, snapshot.markdown || '');
  const counters = entryCounters(headings);
  if (!roots.length) return [];

  const resolved = candidates.flatMap<ResolvedDevLogCandidate>((candidate) => {
    const bound = findBoundHeading(headings, boundTargets[candidate.subjectKey]);
    const boundSubject = bound ? enclosingHeading(headings, bound, 3) : undefined;
    if (boundSubject?.section === candidate.section) {
      const target = appendTarget(headings, boundSubject);
      const writeTargets = existingWriteTargets(
        candidate,
        headings,
        snapshot.markdown || '',
        boundSubject,
        target,
        date,
      );
      const assessment = routingAssessment(
        candidate,
        target,
        'append',
        1,
        1,
        '已存在同分类的稳定主题绑定，直接追加',
      );
      assessments.push(assessment);
      return [{
        ...candidate,
        operation: 'append',
        subjectHeading: boundSubject.text,
        allowedTargetRefs: unique(writeTargets.map((item) => item.ref)),
        writeTargets,
        routingAssessmentId: assessment.id,
      }];
    }

    const branch = candidate.branch;
    const exactBranchTargets = branch
      ? targets.filter((target) => (
        target.heading.section === candidate.section
        && target.fullText.includes(branch)
      ))
      : [];
    const scoredNativeAlternatives = targets
      .filter((target) => target.heading.section === candidate.section)
      .map((target) => scoreTarget(candidate, target));
    const branchAlternative = exactBranchTargets.length === 1
      ? scoredNativeAlternatives.find((item) => item.subjectRef === exactBranchTargets[0]?.heading.ref)
      : undefined;
    // 分支只能确认“连续性”，仍需基本语义相似度，避免复用分支时把无关需求串组。
    const exactBranchRef = branchAlternative
      && branchAlternative.score >= DEV_LOG_APPEND_THRESHOLD
      ? branchAlternative.subjectRef
      : undefined;
    const nativeAlternatives = scoredNativeAlternatives
      .sort((left, right) => (
        Number(right.subjectRef === exactBranchRef) - Number(left.subjectRef === exactBranchRef)
        || right.score - left.score
        || left.targetRef.localeCompare(right.targetRef)
      ));
    const nativeBest = nativeAlternatives[0];
    const nativeMargin = exactBranchRef ? 1 : alternativeMargin(nativeAlternatives);
    const nativeMatch = Boolean(exactBranchRef) || isConfidentAppend(nativeBest, nativeMargin);
    const requirementAlternatives = candidate.section === 'bugfix' && !nativeMatch
      ? targets
        .filter((target) => target.heading.section === 'requirement')
        .map((target) => scoreTarget(candidate, target))
        .sort((left, right) => right.score - left.score || left.targetRef.localeCompare(right.targetRef))
      : [];
    const requirementBest = requirementAlternatives[0];
    const requirementMargin = alternativeMargin(requirementAlternatives);
    const requirementMatch = isRequirementAffinity(requirementBest, requirementMargin);
    // 需求相似度只建立“关联需求”，不能把回归修复从 ISSUE 改写成 REQ。
    const relatedRequirementHeading = candidate.section === 'bugfix'
      ? boundSubject?.section === 'requirement'
        ? boundSubject.text
        : requirementMatch ? requirementBest?.heading : undefined
      : undefined;
    const alternatives = nativeAlternatives;
    const best = alternatives[0];
    const margin = alternativeMargin(alternatives);
    const root = roots.find((heading) => heading.section === candidate.section);
    if (!root) return [];

    const operation = exactBranchRef || isConfidentAppend(best, margin)
      ? 'append'
      : 'create';
    const suggestedTargetRef = operation === 'append' && best ? best.targetRef : root.ref;
    const subjectHeading = operation === 'append' && best
      ? headings.find((heading) => heading.ref === best.subjectRef)
      : undefined;
    const createdHeading = operation === 'create'
      ? nextEntryHeading(candidate, counters)
      : '';
    const writeTargets = operation === 'append' && subjectHeading
      ? existingWriteTargets(
        candidate,
        headings,
        snapshot.markdown || '',
        subjectHeading,
        headings.find((heading) => heading.ref === suggestedTargetRef) || subjectHeading,
        date,
      )
      : [createWriteTarget(candidate, root, createdHeading)];
    const assessment = routingAssessment(
      candidate,
      operation === 'append' && best ? { ref: best.targetRef, text: best.heading } : root,
      operation,
      best?.score || 0,
      margin,
      exactBranchRef
          ? '文档中只有一个同分类记录精确包含相同开发分支，沿用该稳定主题'
        : operation === 'append'
          ? '最佳目标达到相似度门槛，且与次优目标差距足够明确'
          : relatedRequirementHeading
            ? `这是与“${relatedRequirementHeading}”相关的回归修复；保留 ISSUE 分类并新建问题记录`
            : '没有唯一可信的已有主题，保守地在对应分类下新建记录',
      alternatives,
    );
    assessments.push(assessment);

    return [{
      ...candidate,
      operation,
      subjectHeading: subjectHeading?.text || createdHeading,
      ...(relatedRequirementHeading ? { relatedRequirementHeading } : {}),
      allowedTargetRefs: unique(writeTargets.map((item) => item.ref)),
      writeTargets,
      routingAssessmentId: assessment.id,
    }];
  });
  deduplicateReplaceTargets(resolved);
  attachOverviewTargets(resolved, headings, date);
  return resolved;
}

function routingAssessment(
  candidate: DevLogCandidate,
  target: Pick<HeadingReference, 'ref' | 'text'>,
  outcome: 'append' | 'create',
  score: number,
  margin: number,
  message: string,
  alternatives: Alternative[] = [],
): DecisionAssessment {
  const subject = { kind: 'dev-log-candidate' as const, id: candidate.id };
  const evidence = [
    subject,
    { kind: 'document-heading' as const, id: target.ref },
  ];
  const best = alternatives[0];
  return withDecisionId({
    kind: 'assessment' as const,
    policyId: 'devlog.routing',
    policyVersion: '1.0.0',
    subject,
    outcome,
    confidence: outcome === 'append' ? 'high' as const : 'low' as const,
    gates: [],
    signals: [
      { key: 'best-score', value: score, weight: 1, contribution: score, message: `最佳目标得分 ${score}` },
      { key: 'runner-up-margin', value: margin, message: `与次优目标分差 ${margin}` },
      { key: 'business-goal', value: best?.indicators.businessGoal || 0, weight: 0.35, contribution: round((best?.indicators.businessGoal || 0) * 0.35), message: '业务目标相似度' },
      { key: 'code-scope', value: best?.indicators.codeScope || 0, weight: 0.25, contribution: round((best?.indicators.codeScope || 0) * 0.25), message: '代码范围相似度' },
      { key: 'history', value: best?.indicators.history || 0, weight: 0.2, contribution: round((best?.indicators.history || 0) * 0.2), message: '历史上下文相似度' },
    ],
    reasons: [{ code: `devlog.routing.${outcome}`, message, evidence }],
    evidence,
    score: { value: score, threshold: DEV_LOG_APPEND_THRESHOLD, direction: 'higher' as const, scale: { min: 0, max: 1 } },
    constraints: [],
  });
}

export function scoreDevLogTargets(
  candidate: DevLogCandidate,
  snapshot: SinkSnapshot,
): Alternative[] {
  const headings = (snapshot.headings || []).filter((heading) => heading.level >= 2 && heading.level <= 5);
  return documentTargets(headings, snapshot.markdown || '')
    .filter((target) => target.heading.section === candidate.section)
    .map((target) => scoreTarget(candidate, target))
    .sort((left, right) => right.score - left.score || left.targetRef.localeCompare(right.targetRef));
}

function alternativeMargin(alternatives: Alternative[]): number {
  return round((alternatives[0]?.score || 0) - (alternatives[1]?.score || 0));
}

function isConfidentAppend(best: Alternative | undefined, margin: number): boolean {
  return Boolean(best && best.score >= DEV_LOG_APPEND_THRESHOLD && margin >= DEV_LOG_APPEND_MARGIN);
}

function isRequirementAffinity(best: Alternative | undefined, margin: number): boolean {
  return Boolean(
    best
    && best.score >= DEV_LOG_REQUIREMENT_AFFINITY_THRESHOLD
    && best.indicators.codeScope >= DEV_LOG_APPEND_THRESHOLD
    && margin >= DEV_LOG_REQUIREMENT_AFFINITY_MARGIN,
  );
}

function scoreTarget(candidate: DevLogCandidate, target: DocumentTarget): Alternative {
  const semanticFacts = candidate.facts.filter(isSemanticFact).slice(0, 6);
  const candidateText = [candidate.title, ...semanticFacts].join('\n');
  const titleMatch = titleSimilarity(candidate.title, target.heading.text);
  const factMatch = bestTextSimilarity(semanticFacts, `${target.heading.text}\n${target.stableText}`);
  // 单句对话只能辅助标题，不能独自把“同仓库、不同需求”推过追加门槛。
  const businessGoal = calibrate(Math.max(titleMatch, factMatch * 0.5), 0.45);
  const codeScope = calibrate(scopeSimilarity(candidate, target.fullText), 0.65);
  const history = calibrate(
    bestTextSimilarity([candidateText, candidate.title, ...semanticFacts], target.fullText),
    0.45,
  );
  const deliveryReference = referenceSimilarity(candidate, target.fullText);
  const timeContinuity = timeSimilarity(candidate.startedAt, target.fullText);
  const score = round(
    businessGoal * 0.35
    + codeScope * 0.25
    + history * 0.2
    + deliveryReference * 0.1
    + timeContinuity * 0.1,
  );
  return {
    targetRef: target.target.ref,
    subjectRef: target.heading.ref,
    heading: target.heading.text,
    score,
    indicators: {
      businessGoal: round(businessGoal),
      codeScope: round(codeScope),
      history: round(history),
      deliveryReference: round(deliveryReference),
      timeContinuity: round(timeContinuity),
    },
  };
}

function documentTargets(headings: HeadingReference[], markdown: string): DocumentTarget[] {
  return headings.flatMap((heading) => {
    if (heading.level !== 3 || !heading.section) return [];
    const fullText = markdownSection(markdown, headings, heading);
    const iterationIndex = fullText.search(/^####\s+.*(?:变更记录|迭代日志).*$/m);
    return [{
      heading,
      target: appendTarget(headings, heading),
      stableText: iterationIndex >= 0 ? fullText.slice(0, iterationIndex) : fullText,
      fullText,
    }];
  });
}

function appendTarget(headings: HeadingReference[], matched: HeadingReference): HeadingReference {
  if (matched.section !== 'requirement' || matched.level < 3) return matched;
  const matchedIndex = headings.indexOf(matched);
  let requirementIndex = matched.level === 3 ? matchedIndex : -1;
  for (let index = matchedIndex - 1; requirementIndex < 0 && index >= 0; index -= 1) {
    if (headings[index]?.level === 3) requirementIndex = index;
    if ((headings[index]?.level || 0) < 3) break;
  }
  if (requirementIndex < 0) return matched;
  for (let index = requirementIndex + 1; index < headings.length; index += 1) {
    const heading = headings[index];
    if (!heading || heading.level <= 3) break;
    if (heading.level === 4 && /(?:变更记录|迭代日志)/.test(heading.text)) return heading;
  }
  return matched;
}

function existingWriteTargets(
  candidate: DevLogCandidate,
  headings: HeadingReference[],
  markdown: string,
  subject: HeadingReference,
  appendHeading: HeadingReference,
  date: string,
): DevLogWriteTarget[] {
  if (candidate.section === 'bugfix' || candidate.section === 'insight') {
    return [{
      ref: subject.ref,
      section: candidate.section,
      operation: 'replace',
      role: candidate.section === 'bugfix' ? 'issue' : 'insight',
      required: true,
      markdownPrefix: `### ${subject.text}`,
      bindSubject: true,
    }];
  }

  const children = childHeadings(headings, subject, 4);
  const targets: DevLogWriteTarget[] = [];
  const rolePatterns: Array<{
    role: DevLogWriteTarget['role'];
    pattern: RegExp;
    required: boolean;
  }> = [
    { role: 'requirement-overview', pattern: /^需求概览$/, required: true },
    { role: 'background', pattern: /^背景与范围$/, required: false },
    { role: 'design', pattern: /^方案与职责边界$/, required: false },
    { role: 'verification', pattern: /^验证与交付$/, required: false },
    { role: 'retrospective', pattern: /^复盘与沉淀$/, required: false },
  ];
  for (const item of rolePatterns) {
    if (!shouldPlanCurrentSection(candidate, item.role)) continue;
    const heading = children.find((child) => item.pattern.test(normalizeHeading(child.text)));
    if (!heading) continue;
    targets.push({
      ref: heading.ref,
      section: 'requirement',
      operation: 'replace',
      role: item.role,
      required: item.role === 'verification'
        ? candidate.verificationSummary !== '未记录结构化验证结果'
        : item.required,
      markdownPrefix: `#### ${heading.text}`,
      bindSubject: false,
    });
  }

  const implementation = children.find((child) => normalizeHeading(child.text) === '核心实现');
  if (implementation && candidate.excerpts.length) {
    const module = matchingImplementationModule(candidate, headings, markdown, implementation);
    targets.push(module ? {
      ref: module.ref,
      section: 'requirement',
      operation: 'replace',
      role: 'implementation',
      required: true,
      markdownPrefix: `##### ${module.text}`,
      bindSubject: false,
    } : {
      ref: implementation.ref,
      section: 'requirement',
      operation: 'append',
      role: 'implementation',
      required: true,
      markdownPrefix: '##### ',
      bindSubject: false,
    });
  }

  const hasChangeLog = appendHeading.level === 4
    && /(?:变更记录|迭代日志)/.test(appendHeading.text);
  targets.push({
    ref: appendHeading.ref,
    section: 'requirement',
    operation: 'append',
    role: 'change-log',
    required: true,
    markdownPrefix: hasChangeLog
      ? `##### ${date}｜`
      : `#### 变更记录\n##### ${date}｜`,
    bindSubject: true,
  });
  return targets;
}

function shouldPlanCurrentSection(
  candidate: DevLogCandidate,
  role: DevLogWriteTarget['role'],
): boolean {
  if (role === 'requirement-overview') return true;
  if (role === 'verification') {
    return candidate.verificationSummary !== '未记录结构化验证结果';
  }
  const facts = [candidate.title, ...candidate.facts].join('\n');
  if (role === 'background') {
    return /需求背景|背景|范围|目标调整|本期|暂缓|不在.+范围|新增.+(?:场景|链路)/i.test(facts);
  }
  if (role === 'design') {
    return /方案|设计|职责|边界|架构|决策|决定|选择|采用|拆分|收口|复用/i.test(facts);
  }
  if (role === 'retrospective') {
    return /复盘|沉淀|经验|教训|反模式|防复发|默认动作|后续原则/i.test(facts);
  }
  return false;
}

function createWriteTarget(
  candidate: DevLogCandidate,
  root: HeadingReference,
  subjectHeading: string,
): DevLogWriteTarget {
  return {
    ref: root.ref,
    section: candidate.section,
    operation: 'create',
    role: candidate.section === 'requirement'
      ? 'entry'
      : candidate.section === 'bugfix'
        ? 'issue'
        : 'insight',
    required: true,
    markdownPrefix: `### ${subjectHeading}`,
    bindSubject: true,
  };
}

function attachOverviewTargets(
  candidates: ResolvedDevLogCandidate[],
  headings: HeadingReference[],
  date: string,
): void {
  const owner = candidates[0];
  if (!owner) return;
  const overviewRoot = headings.find((heading) => heading.level === 2 && heading.section === 'overview');
  if (!overviewRoot) return;
  const children = childHeadings(headings, overviewRoot, 3);
  const definitions: Array<{
    role: DevLogWriteTarget['role'];
    pattern: RegExp;
    prefix: (heading: HeadingReference) => string;
  }> = [
    {
      role: 'overview-status',
      pattern: /^1[.、]\s*当前需求状态/,
      prefix: (heading) => `### ${heading.text}`,
    },
    {
      role: 'overview-recent',
      pattern: /^2[.、]\s*最近更新/,
      prefix: () => `### 2. 最近更新｜${date}`,
    },
    {
      role: 'overview-todos',
      pattern: /^3[.、]\s*待确认事项/,
      prefix: (heading) => `### ${heading.text}`,
    },
  ];
  for (const definition of definitions) {
    if (definition.role === 'overview-status'
      && !candidates.some((candidate) => candidate.section === 'requirement')) continue;
    const heading = children.find((child) => definition.pattern.test(child.text));
    if (!heading) continue;
    owner.writeTargets.push({
      ref: heading.ref,
      section: 'overview',
      operation: 'replace',
      role: definition.role,
      required: true,
      markdownPrefix: definition.prefix(heading),
      bindSubject: false,
    });
  }
  owner.allowedTargetRefs = unique(owner.writeTargets.map((target) => target.ref));
}

function deduplicateReplaceTargets(candidates: ResolvedDevLogCandidate[]): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    candidate.writeTargets = candidate.writeTargets.filter((target) => {
      if (target.operation !== 'replace') return true;
      const key = `${target.section}:${target.ref}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    candidate.allowedTargetRefs = unique(candidate.writeTargets.map((target) => target.ref));
  }
}

function matchingImplementationModule(
  candidate: DevLogCandidate,
  headings: HeadingReference[],
  markdown: string,
  implementation: HeadingReference,
): HeadingReference | undefined {
  const modules = childHeadings(headings, implementation, 5);
  const ranked = modules.map((heading) => {
    const text = markdownSection(markdown, headings, heading);
    const score = scopeSimilarity(candidate, text) * 0.65
      + Math.max(
        titleSimilarity(candidate.title, heading.text),
        bestTextSimilarity(candidate.facts.slice(0, 6), `${heading.text}\n${text}`),
      ) * 0.35;
    return { heading, score };
  }).sort((left, right) => right.score - left.score);
  return (ranked[0]?.score || 0) >= 0.75 ? ranked[0]?.heading : undefined;
}

function childHeadings(
  headings: HeadingReference[],
  parent: HeadingReference,
  level: number,
): HeadingReference[] {
  const start = headings.indexOf(parent);
  if (start < 0) return [];
  const result: HeadingReference[] = [];
  for (let index = start + 1; index < headings.length; index += 1) {
    const heading = headings[index];
    if (!heading || heading.level <= parent.level) break;
    if (heading.level === level) result.push(heading);
  }
  return result;
}

function enclosingHeading(
  headings: HeadingReference[],
  heading: HeadingReference,
  level: number,
): HeadingReference | undefined {
  if (heading.level === level) return heading;
  const start = headings.indexOf(heading);
  for (let index = start - 1; index >= 0; index -= 1) {
    const candidate = headings[index];
    if (!candidate || candidate.level < level) return undefined;
    if (candidate.level === level) return candidate;
  }
  return undefined;
}

function findBoundHeading(
  headings: HeadingReference[],
  binding: string | DevLogSubjectBinding | undefined,
): HeadingReference | undefined {
  if (!binding) return undefined;
  const blockId = typeof binding === 'string' ? binding : binding.blockId;
  const byBlock = blockId
    ? headings.find((heading) => heading.blockId === blockId && heading.level >= 3)
    : undefined;
  if (byBlock) return byBlock;
  const headingText = typeof binding === 'string' ? '' : binding.headingText;
  return headingText
    ? headings.find((heading) => heading.level === 3 && normalizeHeading(heading.text) === normalizeHeading(headingText))
    : undefined;
}

function entryCounters(headings: HeadingReference[]): Record<'requirement' | 'bugfix' | 'insight', number> {
  return {
    requirement: maxHeadingNumber(headings, 'requirement', /\bREQ-(\d+)\b/i),
    bugfix: maxHeadingNumber(headings, 'bugfix', /\bISSUE-(\d+)\b/i),
    insight: maxHeadingNumber(headings, 'insight', /^(\d+)[.、]/),
  };
}

function maxHeadingNumber(
  headings: HeadingReference[],
  section: 'requirement' | 'bugfix' | 'insight',
  pattern: RegExp,
): number {
  return Math.max(0, ...headings
    .filter((heading) => heading.level === 3 && heading.section === section)
    .map((heading) => Number(heading.text.match(pattern)?.[1] || 0)));
}

function nextEntryHeading(
  candidate: DevLogCandidate,
  counters: Record<'requirement' | 'bugfix' | 'insight', number>,
): string {
  counters[candidate.section] += 1;
  const title = candidate.title
    .replace(/^(?:REQ|ISSUE)-\d+\s*[｜|]\s*/i, '')
    .replace(/^\d+[.、]\s*/, '')
    .trim();
  if (candidate.section === 'requirement') {
    return `REQ-${String(counters.requirement).padStart(3, '0')}｜${title}`;
  }
  if (candidate.section === 'bugfix') {
    return `ISSUE-${String(counters.bugfix).padStart(3, '0')}｜${title}`;
  }
  return `${counters.insight}. ${title}`;
}

export function devLogMarkdownSection(snapshot: SinkSnapshot, targetRef: string): string {
  const headings = snapshot.headings || [];
  const heading = headings.find((item) => item.ref === targetRef);
  return heading ? markdownSection(snapshot.markdown || '', headings, heading) : '';
}

function markdownSection(
  markdown: string,
  headings: HeadingReference[],
  heading: Pick<HeadingReference, 'level' | 'text'>,
): string {
  const matches = [...markdown.matchAll(/^(#{2,6})\s+(.+)$/gm)];
  const target = normalizeHeading(heading.text);
  const outlineIndex = headings.indexOf(heading as HeadingReference);
  const occurrence = outlineIndex < 0 ? 0 : headings.slice(0, outlineIndex)
    .filter((item) => item.level === heading.level && normalizeHeading(item.text) === target)
    .length;
  const matching = matches.filter((match) => (
    match[1]?.length === heading.level && normalizeHeading(match[2] || '') === target
  ));
  const selected = matching[occurrence];
  if (!selected) return heading.text;
  const selectedIndex = matches.indexOf(selected);
  const start = selected.index || 0;
  const end = matches.slice(selectedIndex + 1).find((match) => (match[1]?.length || 0) <= heading.level)?.index
    ?? markdown.length;
  return markdown.slice(start, end);
}

function scopeSimilarity(candidate: DevLogCandidate, document: string): number {
  const files = unique(candidate.files.map(normalizePath).filter(Boolean));
  if (!files.length && !candidate.repositoryKey) return 0;
  const normalizedDocument = normalizePath(document);
  const signatures = unique(files.map((file) => file.split('/').slice(-2).join('/')).filter(Boolean));
  const packages = unique(files.flatMap((file) => {
    const match = file.match(/(?:^|\/)(?:apps?|packages?)\/([^/]+)/);
    return match?.[1] ? [match[1]] : [];
  }));
  const pathSegments = unique(files.flatMap((file) => file.split('/'))
    .filter((value) => value.length >= 4 && !['apps', 'packages', 'src', 'pages', 'index.tsx', 'index.ts'].includes(value)));
  const scopes = new Set(tokenize([
    candidate.repositoryKey || '',
    ...files.map((file) => file.split('/').slice(-4, -1).join(' ')),
  ].join('\n')));
  const documentTokens = new Set(tokenize(document));
  const signatureCoverage = coverage(signatures, (value) => normalizedDocument.includes(value));
  const packageCoverage = coverage(packages, (value) => normalizedDocument.includes(value));
  const segmentCoverage = coverage(pathSegments, (value) => normalizedDocument.includes(value));
  const tokenCoverage = coverage([...scopes], (value) => documentTokens.has(value));
  return Math.min(1, Math.max(
    signatureCoverage * 0.7 + packageCoverage * 0.2 + tokenCoverage * 0.1,
    segmentCoverage > 0 ? 0.45 + segmentCoverage * 0.25 : 0,
  ));
}

function referenceSimilarity(candidate: DevLogCandidate, document: string): number {
  const references = new Set([
    ...(candidate.branch ? [candidate.branch.toLowerCase()] : []),
    ...(candidate.commits || []).map((value) => value.toLowerCase()),
    ...extractReferences(candidate.facts.join('\n')),
  ].filter((value) => value.length >= 4));
  if (!references.size) return 0;
  const normalized = document.toLowerCase();
  let matched = 0;
  for (const reference of references) if (normalized.includes(reference)) matched += 1;
  return matched / references.size;
}

function timeSimilarity(startedAt: string | undefined, document: string): number {
  const candidateTime = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(candidateTime)) return 0;
  const dates = [...document.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)]
    .map((match) => Date.parse(`${match[1]}T00:00:00Z`))
    .filter((value) => Number.isFinite(value) && value <= candidateTime)
    .sort((left, right) => right - left);
  if (!dates.length) return 0;
  const days = Math.floor((candidateTime - dates[0]!) / 86_400_000);
  if (days <= 3) return 1;
  if (days <= 7) return 0.8;
  if (days <= 14) return 0.6;
  if (days <= 30) return 0.3;
  return days <= 90 ? 0.1 : 0;
}

function bestTextSimilarity(values: string[], document: string): number {
  const chunks = textChunks(document);
  return Math.max(0, ...values.filter(Boolean).flatMap((value) => (
    chunks.map((chunk) => textSimilarity(value, chunk))
  )));
}

function textChunks(value: string): string[] {
  const blocks = value.split(/\n{2,}|(?=^#{3,6}\s+)/m).map((item) => item.trim()).filter(Boolean);
  return blocks.flatMap((block) => block.length <= 800
    ? [block]
    : block.split(/\n|(?<=[。！？；])/).map((item) => item.trim()).filter(Boolean));
}

function textSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  const dice = (2 * shared) / (leftTokens.size + rightTokens.size);
  const overlap = shared / Math.min(leftTokens.size, rightTokens.size);
  return dice * 0.6 + overlap * 0.4;
}

function tokenize(value: string): string[] {
  let normalized = String(value || '').toLowerCase().replace(/[^a-z0-9_./\u3400-\u9fff-]+/g, ' ');
  // 先移除通用词再切中文二元词，避免“功能开发”残留“能开”造成虚假相似。
  for (const generic of GENERIC_SIMILARITY_TERMS) {
    normalized = normalized.replaceAll(generic, ' ');
  }
  const result = new Set(normalized.match(/[a-z0-9][a-z0-9_./-]+/g) || []);
  for (const word of normalized.match(/[a-z0-9][a-z0-9_-]+/g) || []) result.add(word);
  for (const chunk of normalized.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (let index = 0; index < chunk.length - 1; index += 1) result.add(chunk.slice(index, index + 2));
  }
  return [...result];
}

function extractReferences(value: string): string[] {
  return unique([
    ...(value.match(/\b[0-9a-f]{7,40}\b/gi) || []),
    ...(value.match(/\b(?:mr|pr)[#:\s-]*\d+\b/gi) || []),
    ...(value.match(/https?:\/\/\S+\/(?:merge_requests|pull)\/\d+/gi) || []),
  ].map((item) => item.toLowerCase()));
}

function isSemanticFact(value: string): boolean {
  return Boolean(value.trim())
    && !/^(?:修改|执行|运行|验证|git|npm|npx|pnpm|yarn|emo|set\s|cd\s)/i.test(value.trim());
}

function coverage(values: string[], predicate: (value: string) => boolean): number {
  if (!values.length) return 0;
  return values.filter(predicate).length / values.length;
}

function normalizeHeading(value: string): string {
  return value
    .replace(/\\([`*_~])/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function titleSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeHeading(left).replace(/^\d+(?:\.\d+)*[.、]?\s*/, '');
  const normalizedRight = normalizeHeading(right).replace(/^\d+(?:\.\d+)*[.、]?\s*/, '');
  if (normalizedLeft === normalizedRight) return 1;
  return textSimilarity(normalizedLeft, normalizedRight);
}

function normalizePath(value: string): string {
  return String(value || '').toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function firstHeadingPerSection(headings: HeadingReference[]): HeadingReference[] {
  const seen = new Set<HeadingReference['section']>();
  return headings.filter((heading) => {
    if (!heading.section || seen.has(heading.section)) return false;
    seen.add(heading.section);
    return true;
  });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function calibrate(value: number, fullMatchAt: number): number {
  return Math.min(1, value / fullMatchAt);
}
