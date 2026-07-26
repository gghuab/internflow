import type { CaptureSnapshot, CaptureSummary, WorkEvidence } from './capture.js';
import type { DecisionAssessment } from './decision.js';
import type { DailyReportView, DevLogCandidate, PeriodReportView, ResolvedDevLogCandidate, WorkItem } from './workday.js';

export interface CommandRecord {
  command: string;
  cwd: string;
  exitCode: number | null;
  output: string;
}

export interface Activity {
  file: string;
  id: string;
  title: string;
  cwd: string;
  gitBranch: string;
  gitSha: string;
  startedAt: string;
  endedAt: string;
  originalStartedAt: string;
  originalEndedAt: string;
  activeMinutes: number | null;
  durationMinutes: number | null;
  observedSpanMinutes: number;
  durationReliable: boolean;
  hadReplayBurst: boolean;
  durationReason: string;
  targetDateActivityCount: number;
  firstUserMessage: string;
  userMessages: string[];
  assistantMessages: string[];
  changedFiles: string[];
  commands: CommandRecord[];
  commandCount: number;
  errors: string[];
  parentSessionId?: string;
  rootSessionId?: string;
  continuedFromPreviousDate?: boolean;
  previousContext?: {
    userMessage: string;
    assistantMessage: string;
  };
  capture?: CaptureSummary;
}

export interface ActivitySourceBatch {
  date: string;
  timezone: string;
  generatedAt?: string;
  workspace?: string;
  sourceCount: number;
  activities: Activity[];
  captureSummary?: CaptureSummary;
  captureSnapshot?: CaptureSnapshot;
  // 本地缓存存在时，审计产物可硬链接到唯一 Snapshot，避免复制整份账本。
  captureSnapshotPath?: string;
}

export interface ActivityBatch extends ActivitySourceBatch {
  filteredCount: number;
  sessions?: Activity[];
  candidateRule?: string;
  sourceSessionCount?: number;
  filteredSessionCount?: number;
  reportableSessionCount?: number;
  sessionCount?: number;
  workEvidence?: WorkEvidence[];
  workItems?: WorkItem[];
  dailyView?: DailyReportView;
  devLogCandidates?: DevLogCandidate[];
  resolvedDevLogCandidates?: ResolvedDevLogCandidate[];
  periodView?: PeriodReportView;
  /** 运行期收集，最终独立持久化；不嵌入 WorkItem 或报告正文。 */
  decisionAssessments?: DecisionAssessment[];
}
