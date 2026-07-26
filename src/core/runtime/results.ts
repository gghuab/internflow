import type { RunResult } from '../contracts/index.js';

export function skippedResult(
  job: string,
  date: string,
  dryRun: boolean,
  reason?: string,
): RunResult {
  return {
    ok: true,
    skipped: true,
    ...(reason ? { reason } : {}),
    job,
    date,
    dryRun,
    sourceCount: 0,
    activityCount: 0,
    outputs: [],
  };
}

export function alreadyAppliedOutput(sink: string): Record<string, unknown> {
  return { sink, skipped: true, reason: 'already_applied' };
}
