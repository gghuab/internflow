import { describe, expect, it } from 'vitest';
import type { WorkEvidence } from '../src/core/contracts/index.js';
import {
  reduceVerifications,
  verificationAppliesToFiles,
} from '../src/work-items/policies/verification.js';

describe('work verification reducer', () => {
  it('collapses a failed attempt followed by a pass into a passed final result', () => {
    const result = reduceVerifications([
      evidence('e1', 1, '2026-07-16T10:00:00Z'),
      evidence('e2', 0, '2026-07-16T10:05:00Z'),
    ]);
    expect(result).toEqual([expect.objectContaining({
      normalizedCommand: 'npm test', outcome: 'passed', evidenceIds: ['e1', 'e2'],
    })]);
  });

  it('distinguishes file-scoped failures from global verification failures', () => {
    expect(verificationAppliesToFiles({
      command: 'eslint src/legacy.ts', normalizedCommand: 'eslint src/legacy.ts', outcome: 'failed',
      exitCode: 1, timestamp: '2026-07-16T10:00:00Z', evidenceIds: ['failure'],
      affectedFiles: ['src/legacy.ts'],
    }, ['src/api.ts'])).toBe(false);
    expect(verificationAppliesToFiles({
      command: 'npm test', normalizedCommand: 'npm test', outcome: 'failed',
      exitCode: 1, timestamp: '2026-07-16T10:00:00Z', evidenceIds: ['failure'],
    }, ['src/api.ts'])).toBe(true);
  });
});

function evidence(id: string, exitCode: number, timestamp: string): WorkEvidence {
  return {
    id, workItemKey: '/workspace|branch|root', kind: exitCode ? 'error' : 'verification',
    status: 'confirmed', timestamp, workspace: '/workspace', files: [], summary: 'npm test',
    sourceEventIds: [`event-${id}`], confidence: 'confirmed',
    verification: { command: 'npm test', exitCode, outcome: exitCode ? 'failed' : 'passed' },
  };
}
