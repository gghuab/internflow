import type { JobConfig } from '../config.js';

export interface RunContext {
  jobName: string;
  job: JobConfig;
  date: string;
  timezone: string;
  dryRun: boolean;
  force: boolean;
  modelOverride?: string;
}

export interface RunResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  job: string;
  date: string;
  dryRun: boolean;
  sourceCount: number;
  activityCount: number;
  operationCount?: number;
  sourceSessionCount?: number;
  filteredSessionCount?: number;
  sessionCount?: number;
  inputPath?: string;
  currentPath?: string;
  operationsPath?: string;
  generator?: { provider: string; model: string | null };
  updates?: Array<Record<string, unknown>>;
  outputs: Array<Record<string, unknown>>;
  decisionAuditPath?: string;
  decisionSummary?: {
    included: number;
    excluded: number;
    blocked: number;
    lowConfidence: number;
  };
}
