import type {
  DecisionAssessment,
  DevLogCandidate,
  HeadingReference,
  SinkSnapshot,
} from '../../core/contracts/index.js';
import { withDecisionId } from '../../core/decision-audit.js';
import type { ResolvedDevLogCandidate } from './types.js';

export const DEV_LOG_APPEND_THRESHOLD = 0.75;
export const DEV_LOG_CREATE_THRESHOLD = 0.45;
export const DEV_LOG_APPEND_MARGIN = 0.15;

interface DocumentTarget {
  heading: HeadingReference;
  target: HeadingReference;
  stableText: string;
  fullText: string;
}

interface Alternative {
  targetRef: string;
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

export function resolveDevLogCandidates(
  candidates: DevLogCandidate[],
  snapshot: SinkSnapshot,
  boundTargets: Record<string, string> = {},
  assessments: DecisionAssessment[] = [],
): ResolvedDevLogCandidate[] {
  const headings = (snapshot.headings || []).filter((heading) => heading.level >= 2 && heading.level <= 4);
  const levelTwoRoots = headings.filter((heading) => heading.level === 2 && heading.section);
  const roots = levelTwoRoots.length ? levelTwoRoots : firstHeadingPerSection(headings);
  const targets = documentTargets(headings, snapshot.markdown || '');
  if (!roots.length) return [];

  return candidates.flatMap<ResolvedDevLogCandidate>((candidate) => {
    const bound = headings.find((heading) => heading.ref === boundTargets[candidate.subjectKey]);
    if (bound?.section) {
      const target = appendTarget(headings, bound);
      const assessment = routingAssessment(candidate, target, 'append', 1, 1, '已存在稳定主题绑定，直接追加');
      assessments.push(assessment);
      return [{
        ...candidate,
        operation: 'append',
        allowedTargetRefs: [target.ref],
        routingAssessmentId: assessment.id,
      }];
    }

    const alternatives = targets
      .map((target) => scoreTarget(candidate, target))
      .sort((left, right) => right.score - left.score || left.targetRef.localeCompare(right.targetRef));
    const best = alternatives[0];
    const margin = round((best?.score || 0) - (alternatives[1]?.score || 0));
    const root = roots.find((heading) => heading.section === candidate.section) || roots[0];
    if (!root) return [];

    const operation = best && best.score >= DEV_LOG_APPEND_THRESHOLD && margin >= DEV_LOG_APPEND_MARGIN
      ? 'append'
      : 'create';
    const suggestedTargetRef = operation === 'append' && best ? best.targetRef : root.ref;
    const allowedTargetRefs = [suggestedTargetRef];
    const assessment = routingAssessment(
      candidate,
      operation === 'append' && best ? { ref: best.targetRef, text: best.heading } : root,
      operation,
      best?.score || 0,
      margin,
      operation === 'append'
        ? '最佳目标达到相似度门槛，且与次优目标差距足够明确'
        : '没有唯一可信的已有主题，保守地在对应分类下新建记录',
      alternatives,
    );
    assessments.push(assessment);

    return [{
      ...candidate,
      operation,
      allowedTargetRefs,
      routingAssessmentId: assessment.id,
    }];
  });
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
  const headings = (snapshot.headings || []).filter((heading) => heading.level >= 2 && heading.level <= 4);
  return documentTargets(headings, snapshot.markdown || '')
    .map((target) => scoreTarget(candidate, target))
    .sort((left, right) => right.score - left.score || left.targetRef.localeCompare(right.targetRef));
}

function scoreTarget(candidate: DevLogCandidate, target: DocumentTarget): Alternative {
  const semanticFacts = candidate.facts.filter(isSemanticFact).slice(0, 6);
  const candidateText = [candidate.title, ...semanticFacts].join('\n');
  const businessGoal = calibrate(Math.max(
    titleSimilarity(candidate.title, target.heading.text),
    bestTextSimilarity([candidate.title, ...semanticFacts], `${target.heading.text}\n${target.stableText}`),
  ), 0.45);
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
    const fullText = markdownSection(markdown, heading.text);
    const iterationIndex = fullText.search(/^####\s+.*迭代日志.*$/m);
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
    if (heading.level === 4 && /迭代日志/.test(heading.text)) return heading;
  }
  return matched;
}

function markdownSection(markdown: string, title: string): string {
  const matches = [...markdown.matchAll(/^(#{2,6})\s+(.+)$/gm)];
  const target = normalizeHeading(title);
  const index = matches.findIndex((match) => (
    match[1]?.length === 3 && normalizeHeading(match[2] || '') === target
  ));
  if (index < 0) return title;
  const start = matches[index]?.index || 0;
  const end = matches.slice(index + 1).find((match) => (match[1]?.length || 0) <= 3)?.index
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
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9_./\u3400-\u9fff-]+/g, ' ');
  const result = new Set(normalized.match(/[a-z0-9][a-z0-9_./-]+/g) || []);
  for (const word of normalized.match(/[a-z0-9][a-z0-9_-]+/g) || []) result.add(word);
  for (const chunk of normalized.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (let index = 0; index < chunk.length - 1; index += 1) result.add(chunk.slice(index, index + 2));
  }
  for (const generic of ['需求', '开发', '功能', '问题', '修复', '调整', '修改', '实现', '新增', '完成', '处理', '模块', '代码', '记录', '日志', '迭代']) {
    result.delete(generic);
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
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
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
