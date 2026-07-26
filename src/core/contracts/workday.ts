import type { VerifiedCodeExcerpt } from './capture.js';

export type WorkItemKind =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'research'
  | 'tooling'
  | 'docs'
  | 'operations';

export type WorkItemStatus = 'completed' | 'in_progress' | 'blocked' | 'investigated';

export interface WorkVerification {
  command: string;
  normalizedCommand: string;
  outcome: 'passed' | 'failed' | 'unknown';
  exitCode: number | null;
  timestamp: string;
  evidenceIds: string[];
  /** 验证输出明确指向的文件；为空时只能保守地视为全局验证。 */
  affectedFiles?: string[];
}

export interface WorkChange {
  files: string[];
  summary: string;
  excerpts: VerifiedCodeExcerpt[];
  evidenceIds: string[];
}

export interface WorkItem {
  id: string;
  subjectKey: string;
  repositoryKey: string;
  branch?: string;
  commits?: string[];
  kind: WorkItemKind;
  status: WorkItemStatus;
  title: string;
  goal: string;
  actions: string[];
  outcomes: string[];
  decisions: string[];
  changes: WorkChange[];
  verifications: WorkVerification[];
  blockers: string[];
  startedAt: string;
  endedAt: string;
  activeMinutes: number | null;
  durationReliable: boolean;
  sessionIds: string[];
  evidenceIds: string[];
  confidence: 'confirmed' | 'partial';
}

export interface DailyReportView {
  items: WorkItem[];
  longestWorkItemId: string | null;
  longestReason: string;
  longestTiedIds: string[];
  excludedUnreliableCount: number;
  deepDiveCandidateIds: string[];
  takeawayCandidateIds: string[];
  visualPlan: VisualPlanItem[];
  quality: { coverage: 'high' | 'partial' | 'low'; reasons: string[] };
}

export type VisualMode = 'inline' | 'flowchart' | 'sequence' | 'state';

export interface VisualPlanItem {
  workItemId: string | null;
  mode: VisualMode;
  assessmentId: string;
}

export interface DevLogCandidate {
  id: string;
  subjectKey: string;
  section: 'requirement' | 'bugfix' | 'insight';
  operation: 'create' | 'append';
  title: string;
  repositoryKey?: string;
  branch?: string;
  commits?: string[];
  startedAt?: string;
  status: WorkItemStatus;
  facts: string[];
  files: string[];
  excerpts: VerifiedCodeExcerpt[];
  verificationSummary: string;
  evidenceIds: string[];
  contentFingerprint: string;
}

export interface ResolvedDevLogCandidate extends DevLogCandidate {
  allowedTargetRefs: string[];
  routingAssessmentId: string;
}

export type PeriodUnit = 'week' | 'month';

export interface PeriodEntry {
  date: string;
  workItemId: string;
  subjectKey: string;
  title: string;
  goal: string;
  kind: WorkItemKind;
  status: WorkItemStatus;
  repositoryKey: string;
  branch?: string;
  actions: string[];
  outcomes: string[];
  decisions: string[];
  changedFiles: string[];
  verifications: WorkVerification[];
  blockers: string[];
  activeMinutes: number | null;
  durationReliable: boolean;
  sessionIds: string[];
  evidenceIds: string[];
  factCount: number;
}

export interface PeriodGroup {
  id: string;
  title: string;
  repositoryKey: string;
  branch?: string;
  dates: string[];
  entries: PeriodEntry[];
  status: WorkItemStatus;
  activeMinutes: number | null;
  durationReliable: boolean;
  evidenceIds: string[];
  factCount: number;
}

export interface PeriodReportView {
  unit: PeriodUnit;
  startDate: string;
  endDate: string;
  dates: string[];
  snapshotIds: string[];
  groups: PeriodGroup[];
  quality: { coverage: 'high' | 'partial' | 'low'; reasons: string[] };
}
