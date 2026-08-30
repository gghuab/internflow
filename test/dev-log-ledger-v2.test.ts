import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DevLogEvidenceLedger } from '../src/reports/dev-log/ledger.js';
import type { DevLogCandidate } from '../src/reports/dev-log/types.js';

describe('dev log evidence ledger v3', () => {
  it('invalidates legacy semantic bindings so historical evidence can be reclassified', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-ledger-v1-'));
    const path = join(directory, 'ledger.json');
    await writeFile(path, JSON.stringify({ version: 1, evidence: {
      e1: { evidenceId: 'e1', targetRef: 'h1', syncedAt: '2026-07-15T10:00:00Z' },
    } }));
    const ledger = new DevLogEvidenceLedger(path);
    expect(await ledger.pendingCandidates([candidate({ evidenceIds: ['e1'] })])).toHaveLength(1);
  });

  it('persists subject bindings and content fingerprints only after markSynced', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-ledger-v2-'));
    const path = join(directory, 'ledger.json');
    const ledger = new DevLogEvidenceLedger(path);
    const value = candidate({});
    const assessments = [];
    expect(await ledger.pendingCandidates([value], assessments)).toHaveLength(1);
    expect(assessments).toContainEqual(expect.objectContaining({
      policyId: 'devlog.deduplication', outcome: 'pending',
    }));
    await ledger.markSynced([{
      section: 'requirement', targetRef: 'h1', markdown: '完成', evidenceIds: value.evidenceIds,
      candidateId: value.id, subjectKey: value.subjectKey, contentFingerprint: value.contentFingerprint,
    }], 42, [{
      ref: 'h1', blockId: 'block-1', level: 3, text: 'REQ-001｜功能实现', section: 'requirement',
    }]);
    const repeatedAssessments = [];
    expect(await ledger.pendingCandidates([value], repeatedAssessments)).toEqual([]);
    expect(repeatedAssessments).toContainEqual(expect.objectContaining({
      policyId: 'devlog.deduplication', outcome: 'already-synced',
    }));
    expect(await ledger.subjectTargets()).toEqual({ subject: 'block-1' });
    expect(await ledger.subjectBindings()).toEqual({
      subject: { blockId: 'block-1', headingText: 'REQ-001｜功能实现' },
    });
    const stored = JSON.parse(await readFile(path, 'utf8'));
    expect(stored.version).toBe(3);
    expect(stored.semanticVersion).toBe('2.0.0');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('keeps the deterministic heading binding when a create invalidates the old root ref', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-ledger-create-'));
    const ledger = new DevLogEvidenceLedger(join(directory, 'ledger.json'));
    const value = candidate({ subjectKey: 'new-subject', contentFingerprint: 'new-content' });

    await ledger.markSynced([{
      section: 'requirement',
      targetRef: 'root',
      markdown: '### REQ-006｜全新需求\n',
      operation: 'create',
      role: 'entry',
      evidenceIds: value.evidenceIds,
      candidateId: value.id,
      subjectKey: value.subjectKey,
      subjectHeading: 'REQ-006｜全新需求',
      bindSubject: true,
      contentFingerprint: value.contentFingerprint,
    }], 43, [{
      ref: 'root', blockId: 'requirement-root', level: 2, text: '二、需求开发记录', section: 'requirement',
    }]);

    expect(await ledger.subjectTargets()).toEqual({});
    expect(await ledger.subjectBindings()).toEqual({
      'new-subject': { headingText: 'REQ-006｜全新需求' },
    });
  });
});

function candidate(overrides: Partial<DevLogCandidate>): DevLogCandidate {
  return {
    id: 'candidate', subjectKey: 'subject', section: 'requirement', operation: 'append',
    title: '功能实现', status: 'completed', facts: ['完成实现'], files: ['src/app.ts'], excerpts: [],
    verificationSummary: 'npm test：通过', evidenceIds: ['e1'], contentFingerprint: 'fingerprint',
    ...overrides,
  };
}
