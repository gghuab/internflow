import type {
  ActivityBatch,
  CaptureSnapshot,
  DecisionAssessment,
  PeriodEntry,
  PeriodGroup,
  PeriodReportView,
  PeriodUnit,
  WorkEvidence,
  WorkFactIndex,
  WorkItem,
} from '../../core/contracts/index.js';
import { withDecisionId } from '../../core/decision-audit.js';
import type { ArtifactStore } from '../../core/persistence/index.js';
import { periodDates } from '../../core/calendar.js';
import { stableHash } from '../../work-items/index.js';
import { stableTopic } from '../../work-items/policies/identity.js';

/** 跨日关联阈值：单文件+特性分支不足以过线，需更强的双信号。 */
export const PERIOD_LINK_THRESHOLD = 55;

interface StoredItems { snapshotId?: string; workItems: WorkItem[] }
interface StoredDailyView {
  snapshotId?: string;
  dailyView: { items: WorkItem[]; quality: PeriodReportView['quality'] };
}

interface ClassifiedDay {
  date: string;
  /** included=有工作项；empty=无工作项但账本干净；degraded=有工作但 coverage 非 high */
  status: 'included' | 'empty' | 'degraded';
  facts: WorkFactIndex;
  items: WorkItem[];
  quality: PeriodReportView['quality'];
  reasons: string[];
}

export async function buildPeriodBatch(options: {
  unit: PeriodUnit;
  endDate: string;
  timezone: string;
  skipDates: readonly string[];
  artifacts: ArtifactStore;
  collectDay(date: string): Promise<ActivityBatch>;
  /** false 时不写回 v1→v2 迁移；正式 artifacts 由 runner 在非 dry-run 时落盘 */
  persist?: boolean;
}): Promise<ActivityBatch> {
  const persist = options.persist !== false;
  const dates = periodDates(options.unit, options.endDate, options.skipDates);
  const groups: PeriodGroup[] = [];
  const snapshotIds: string[] = [];
  const qualityReasons: string[] = [];
  let sourceCount = 0;
  let degraded = false;
  const decisionAssessments: DecisionAssessment[] = [];

  // 故意串行：任一时刻最多只在内存中展开一天的原始 JSONL。
  for (const date of dates) {
    const day = await loadDay(options.artifacts, date, options.collectDay, persist);
    decisionAssessments.push(periodDayAssessment(day));
    if (day.status === 'empty') {
      qualityReasons.push(`${date}：无工作项，已跳过`);
      snapshotIds.push(day.facts.snapshotId);
      continue;
    }
    if (day.status === 'degraded') {
      degraded = true;
      qualityReasons.push(...day.reasons.map((reason) => `${date}：${reason}`));
    }
    appendDay(groups, date, day.facts, day.items, decisionAssessments);
    snapshotIds.push(day.facts.snapshotId);
    qualityReasons.push(...(day.quality.reasons || []).map((reason) => `${date}：${reason}`));
    sourceCount += day.items.length;
  }

  const view = finishPeriod(options.unit, dates, groups, snapshotIds, qualityReasons, degraded);
  return {
    date: options.endDate,
    timezone: options.timezone,
    generatedAt: new Date().toISOString(),
    sourceCount,
    activities: [],
    filteredCount: 0,
    candidateRule: '周期报告读取 finalized 的逐日 WorkFacts；空日跳过，partial 软降级，账本差额硬失败',
    periodView: view,
    decisionAssessments,
  };
}

async function loadDay(
  artifacts: ArtifactStore,
  date: string,
  collectDay: (date: string) => Promise<ActivityBatch>,
  persist: boolean,
): Promise<ClassifiedDay> {
  const stored = await readStoredDay(artifacts, date, persist);
  if (stored) return stored;

  const batch = await collectDay(date);
  const fromBatch = classifyFromBatch(date, batch);
  if (fromBatch) return fromBatch;

  // 补采后尝试再读一次（非 dry-run 时 collectDay 已落盘）
  const afterCollect = await readStoredDay(artifacts, date, persist);
  if (afterCollect) return afterCollect;

  throw new Error(periodDayError(date, 'missing', [
    '补采后仍缺少可用的 finalized 工作日工件（work-facts / daily-view）',
  ]));
}

async function readStoredDay(
  artifacts: ArtifactStore,
  date: string,
  persist: boolean,
): Promise<ClassifiedDay | null> {
  try {
    let facts = await artifacts.readJson(artifacts.workFactsPath(date)) as WorkFactIndex | (Omit<WorkFactIndex, 'version' | 'asOf' | 'finalized' | 'quality'> & { version: 1 });
    // S15-A 的旧紧凑索引没有最终态字段；只从同 snapshotId 的审计快照补元数据，不重扫 JSONL。
    if (facts.version === 1) {
      const audit = await artifacts.readJson(artifacts.captureAuditPath(date)) as CaptureSnapshot;
      if (audit.id !== facts.snapshotId || audit.date !== date) {
        throw new Error(periodDayError(date, 'snapshot_mismatch', [
          'WorkFactIndex v1 与 capture audit 的 snapshotId/date 不一致',
        ]));
      }
      facts = {
        version: 2,
        date: facts.date,
        timezone: facts.timezone,
        snapshotId: facts.snapshotId,
        asOf: audit.asOf,
        finalized: audit.finalized,
        ...(audit.finalizedAt ? { finalizedAt: audit.finalizedAt } : {}),
        ...(audit.finalizationBasis ? { finalizationBasis: audit.finalizationBasis } : {}),
        quality: audit.quality,
        facts: facts.facts,
      };
      if (persist) await artifacts.saveWorkFactIndex(date, facts);
    }
    const storedItems = await artifacts.readJson(artifacts.workItemsPath(date)) as StoredItems;
    const daily = await artifacts.readJson(artifacts.dailyViewPath(date)) as StoredDailyView;
    if (
      facts.version !== 2
      || facts.date !== date
      || !Array.isArray(facts.facts)
      || !Array.isArray(storedItems.workItems)
      || !Array.isArray(daily.dailyView?.items)
    ) {
      return null;
    }
    if (storedItems.snapshotId !== facts.snapshotId || daily.snapshotId !== facts.snapshotId) {
      throw new Error(periodDayError(date, 'snapshot_mismatch', [
        `workItems/dailyView snapshotId 与 work-facts 不一致（facts=${facts.snapshotId}）`,
      ]));
    }
    // 周期投影以 DailyReportView 为权威输入（已含日报过滤）；workItems 仅做一致性校验。
    return classifyDay(date, facts, daily.dailyView.items, daily.dailyView.quality);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Period day ')) throw error;
    return null;
  }
}

function classifyFromBatch(date: string, batch: ActivityBatch): ClassifiedDay | null {
  const snapshot = batch.captureSnapshot;
  if (!snapshot || snapshot.date !== date) return null;
  const facts: WorkFactIndex = {
    version: 2,
    date,
    timezone: batch.timezone,
    snapshotId: snapshot.id,
    asOf: snapshot.asOf,
    finalized: snapshot.finalized,
    ...(snapshot.finalizedAt ? { finalizedAt: snapshot.finalizedAt } : {}),
    ...(snapshot.finalizationBasis ? { finalizationBasis: snapshot.finalizationBasis } : {}),
    quality: snapshot.quality,
    facts: snapshot.evidence,
  };
  const items = batch.dailyView?.items || [];
  const quality = batch.dailyView?.quality || {
    coverage: snapshot.quality.coverage,
    reasons: snapshot.quality.reasons || [],
  };
  return classifyDay(date, facts, items, quality);
}

function classifyDay(
  date: string,
  facts: WorkFactIndex,
  items: WorkItem[],
  quality: PeriodReportView['quality'],
): ClassifiedDay {
  if (!facts.finalized) {
    throw new Error(periodDayError(date, 'not_finalized', [
      '工作日尚未 finalized（可能未到 dayEndTime / 午夜宽限）',
      ...((facts.quality?.reasons) || []),
    ]));
  }
  const accountingDifference = facts.quality?.accountingDifference ?? 0;
  if (accountingDifference !== 0) {
    throw new Error(periodDayError(date, 'dirty_ledger', [
      `事件记账差额为 ${accountingDifference}，拒绝编入周期报告`,
      ...((facts.quality?.reasons) || []),
    ]));
  }

  const coverage = facts.quality?.coverage || quality.coverage || 'low';
  const reasons = [...new Set([
    ...(facts.quality?.reasons || []),
    ...(quality.reasons || []),
  ])];

  if (!items.length) {
    return {
      date,
      status: 'empty',
      facts,
      items: [],
      quality: { coverage: 'high', reasons },
      reasons: ['无日报工作项'],
    };
  }

  if (coverage !== 'high') {
    return {
      date,
      status: 'degraded',
      facts,
      items,
      quality: { coverage, reasons },
      reasons: reasons.length ? reasons : [`coverage=${coverage}`],
    };
  }

  return {
    date,
    status: 'included',
    facts,
    items,
    quality: { coverage: 'high', reasons },
    reasons: [],
  };
}

function periodDayError(
  date: string,
  code: 'missing' | 'not_finalized' | 'dirty_ledger' | 'snapshot_mismatch',
  details: string[],
): string {
  return `Period day ${date} rejected (${code}): ${details.filter(Boolean).join('；')}`;
}

export function projectPeriod(
  unit: PeriodUnit,
  dates: string[],
  days: Array<{ date: string; facts: WorkFactIndex; items: WorkItem[]; quality: PeriodReportView['quality'] }>,
  assessments: DecisionAssessment[] = [],
): PeriodReportView {
  const groups: PeriodGroup[] = [];
  const qualityReasons: string[] = [];
  let degraded = false;
  for (const day of days) {
    const classified = classifyDay(day.date, day.facts, day.items, day.quality);
    assessments.push(periodDayAssessment(classified));
    if (classified.status === 'empty') {
      qualityReasons.push(`${day.date}：无工作项，已跳过`);
      continue;
    }
    if (classified.status === 'degraded') {
      degraded = true;
      qualityReasons.push(...classified.reasons.map((reason) => `${day.date}：${reason}`));
    }
    appendDay(groups, day.date, day.facts, day.items, assessments);
    qualityReasons.push(...(day.quality.reasons || []).map((reason) => `${day.date}：${reason}`));
  }
  return finishPeriod(
    unit,
    dates,
    groups,
    days.map((day) => day.facts.snapshotId),
    qualityReasons,
    degraded,
  );
}

function appendDay(
  groups: PeriodGroup[],
  date: string,
  facts: WorkFactIndex,
  items: WorkItem[],
  assessments: DecisionAssessment[],
): void {
  const factsById = new Map(facts.facts.map((fact) => [fact.id, fact]));
  for (const item of items) {
    const entry = toEntry(date, item, factsById);
    const { target, assessment } = bestGroup(groups, entry);
    assessments.push(assessment);
    if (target) appendEntry(target, entry);
    else groups.push(newGroup(entry));
  }
}

function finishPeriod(
  unit: PeriodUnit,
  dates: string[],
  groups: PeriodGroup[],
  snapshotIds: string[],
  qualityReasons: string[],
  degraded: boolean,
): PeriodReportView {
  groups.sort((left, right) => right.dates.at(-1)!.localeCompare(left.dates.at(-1)!)
    || right.factCount - left.factCount
    || left.title.localeCompare(right.title));
  return {
    unit,
    startDate: dates[0] || '',
    endDate: dates.at(-1) || '',
    dates,
    snapshotIds,
    groups,
    quality: {
      coverage: degraded ? 'partial' : 'high',
      reasons: [...new Set(qualityReasons)],
    },
  };
}

function toEntry(date: string, item: WorkItem, factsById: Map<string, WorkEvidence>): PeriodEntry {
  const citedFacts = item.evidenceIds.map((id) => factsById.get(id)).filter(Boolean) as WorkEvidence[];
  const branch = mostCommon(citedFacts.map((fact) => fact.branch || '').filter(Boolean));
  return {
    date,
    workItemId: item.id,
    subjectKey: item.subjectKey,
    title: item.title,
    goal: item.goal,
    kind: item.kind,
    status: item.status,
    repositoryKey: item.repositoryKey,
    ...(branch ? { branch } : {}),
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
    factCount: citedFacts.length,
  };
}

function bestGroup(groups: PeriodGroup[], entry: PeriodEntry): {
  target: PeriodGroup | null;
  assessment: DecisionAssessment;
} {
  const alternatives = groups
    .filter((group) => group.repositoryKey === entry.repositoryKey && !group.dates.includes(entry.date))
    // 与组内任意一天的最强匹配，而不是只看最后一天，避免中间日文件集合收缩导致断链。
    .map((group) => ({ group, score: Math.max(...group.entries.map((candidate) => linkScore(candidate, entry))) }))
    .sort((left, right) => right.score - left.score || left.group.id.localeCompare(right.group.id));
  const best = alternatives[0];
  const target = best && best.score >= PERIOD_LINK_THRESHOLD ? best.group : null;
  const evidence = [{ kind: 'period-entry' as const, id: `${entry.date}:${entry.workItemId}` }];
  return {
    target,
    assessment: withDecisionId({
      kind: 'assessment' as const,
      policyId: 'period.link',
      policyVersion: '1.0.0',
      subject: evidence[0]!,
      outcome: target ? 'append' : 'create',
      confidence: target ? 'high' as const : 'medium' as const,
      gates: [],
      signals: alternatives.slice(0, 3).map((candidate, index) => ({
        key: `candidate-${index + 1}`,
        value: candidate.score,
        message: `候选组 ${candidate.group.id} 得分 ${candidate.score}`,
      })),
      reasons: [{
        code: target ? 'period.link.append' : 'period.link.create',
        message: target ? '最强候选通过跨日关联门槛' : '没有候选通过跨日双信号门槛，新建周期工作组',
        evidence,
      }],
      evidence,
      score: { value: best?.score || 0, threshold: PERIOD_LINK_THRESHOLD, direction: 'higher' as const, scale: { min: 0, max: 100 } },
      constraints: [],
    }),
  };
}

function periodDayAssessment(day: ClassifiedDay): DecisionAssessment {
  const evidence = [{ kind: 'period-entry' as const, id: day.date }];
  return withDecisionId({
    kind: 'gate' as const,
    policyId: 'period.day-admission',
    policyVersion: '1.0.0',
    subject: evidence[0]!,
    outcome: day.status,
    confidence: day.status === 'degraded' ? 'medium' as const : 'high' as const,
    gates: [
      { key: 'finalized', passed: day.facts.finalized, message: day.facts.finalized ? '工作日事实已最终化' : '工作日事实尚未最终化', evidence },
      { key: 'clean-ledger', passed: day.facts.quality.accountingDifference === 0, message: day.facts.quality.accountingDifference === 0 ? '事件账本完整' : `事件记账差额 ${day.facts.quality.accountingDifference}`, evidence },
    ],
    signals: [
      { key: 'coverage', value: day.quality.coverage, message: `采集覆盖度为 ${day.quality.coverage}` },
      { key: 'work-item-count', value: day.items.length, message: `${day.items.length} 个工作项` },
    ],
    reasons: [{ code: `period.day-admission.${day.status}`, message: day.reasons.join('；') || '工作日事实满足周期报告纳入条件', evidence }],
    evidence,
    constraints: [],
  });
}

export function linkScore(left: PeriodEntry, right: PeriodEntry): number {
  if (left.repositoryKey !== right.repositoryKey) return 0;
  if (left.subjectKey === right.subjectKey) return 100;

  const leftFiles = new Set(left.changedFiles);
  const sharedFiles = right.changedFiles.filter((file) => leftFiles.has(file)).length;
  const fileBase = Math.min(leftFiles.size, new Set(right.changedFiles).size);
  let fileScore = Math.min(40, sharedFiles * 8);
  if (fileBase) fileScore += Math.round((sharedFiles / fileBase) * 20);

  const sameStrongBranch = Boolean(
    strongBranch(left.branch) && left.branch && left.branch === right.branch,
  );
  const branchScore = sameStrongBranch ? 20 : 0;
  const sessionScore = left.sessionIds.some((id) => right.sessionIds.includes(id)) ? 10 : 0;

  const leftText = `${left.title} ${left.goal}`;
  const rightText = `${right.title} ${right.goal}`;
  const leftTopic = new Set(stableTopic(leftText).split('-').filter(Boolean));
  const topicTokens = stableTopic(rightText).split('-').filter((word) => leftTopic.has(word));
  const tokenOverlap = topicTokens.length;
  // 中文主题常被 stableTopic 收成整句；用双字重叠捕捉「缓存投影」这类子串延续。
  const bigramOverlap = cjkBigramOverlap(leftText, rightText);
  const topicOverlap = Math.max(tokenOverlap, bigramOverlap >= 2 ? Math.min(4, bigramOverlap) : 0);
  const topicScore = Math.min(20, topicOverlap * 5);

  let score = fileScore + branchScore + sessionScore + topicScore;

  // 多信号加成：共享文件且主题有重叠时抬一档，覆盖「同主题跨日推进」。
  if (sharedFiles > 0 && topicOverlap > 0) score += 10;

  // 双信号门禁：非 subjectKey 直连时，必须有共享文件，或「强分支 + 主题重叠」。
  // 防止「同 feature 分支改过同一个文件」把无关工作串成一条线。
  const dualSignal = sharedFiles > 0 || (sameStrongBranch && topicOverlap > 0);
  if (!dualSignal) score = Math.min(score, PERIOD_LINK_THRESHOLD - 1);

  return score;
}

function cjkBigramOverlap(left: string, right: string): number {
  const leftGrams = cjkBigrams(left);
  if (!leftGrams.size) return 0;
  let shared = 0;
  for (const gram of cjkBigrams(right)) {
    if (leftGrams.has(gram)) shared += 1;
  }
  return shared;
}

function cjkBigrams(value: string): Set<string> {
  const text = String(value || '').replace(/[^一-鿿]/g, '');
  const grams = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) {
    grams.add(text.slice(index, index + 2));
  }
  return grams;
}

function newGroup(entry: PeriodEntry): PeriodGroup {
  return {
    id: stableHash(`${entry.repositoryKey}|${entry.date}|${entry.workItemId}`).slice(0, 20),
    title: entry.title,
    repositoryKey: entry.repositoryKey,
    ...(entry.branch ? { branch: entry.branch } : {}),
    dates: [entry.date],
    entries: [entry],
    status: entry.status,
    activeMinutes: entry.durationReliable ? entry.activeMinutes : null,
    durationReliable: entry.durationReliable,
    evidenceIds: [...entry.evidenceIds],
    factCount: entry.factCount,
  };
}

function appendEntry(group: PeriodGroup, entry: PeriodEntry): void {
  group.dates.push(entry.date);
  group.entries.push(entry);
  group.title = entry.title;
  group.status = entry.status;
  group.durationReliable &&= entry.durationReliable;
  group.activeMinutes = group.durationReliable
    ? (group.activeMinutes || 0) + (entry.activeMinutes || 0)
    : null;
  group.evidenceIds = [...new Set([...group.evidenceIds, ...entry.evidenceIds])];
  group.factCount += entry.factCount;
}

function strongBranch(branch?: string): boolean {
  return Boolean(branch && !['main', 'master', 'develop', 'development', 'trunk'].includes(branch));
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}
