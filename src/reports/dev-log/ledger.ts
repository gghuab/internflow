import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AppendRecord, DecisionAssessment, WorkEvidence } from '../../core/contracts/index.js';
import { withDecisionId } from '../../core/decision-audit.js';
import type { DevLogCandidate } from './types.js';

interface SyncedEvidence {
  evidenceId: string;
  workItemKey?: string;
  targetRef: string;
  documentRevision?: number;
  syncedAt: string;
}

interface SyncedSubject {
  subjectKey: string;
  targetRef: string;
  contentFingerprints: string[];
  lastRevision?: number;
  updatedAt: string;
}

interface LedgerData {
  version: 2;
  evidence: Record<string, SyncedEvidence>;
  subjects: Record<string, SyncedSubject>;
}

export class DevLogEvidenceLedger {
  constructor(readonly path: string) {}

  async pending(evidence: WorkEvidence[]): Promise<WorkEvidence[]> {
    const data = await this.read();
    return evidence.filter((item) => !data.evidence[item.id]);
  }

  async pendingCandidates(
    candidates: DevLogCandidate[],
    assessments: DecisionAssessment[] = [],
  ): Promise<DevLogCandidate[]> {
    const data = await this.read();
    return candidates.filter((candidate) => {
      const subject = data.subjects[candidate.subjectKey];
      const sameContent = Boolean(subject?.contentFingerprints.includes(candidate.contentFingerprint));
      const evidenceSynced = candidate.evidenceIds.every((id) => Boolean(data.evidence[id]));
      const pending = !sameContent && !evidenceSynced;
      const evidence = [{ kind: 'dev-log-candidate' as const, id: candidate.id }];
      assessments.push(withDecisionId({
        kind: 'assessment' as const,
        policyId: 'devlog.deduplication',
        policyVersion: '1.0.0',
        subject: evidence[0]!,
        outcome: pending ? 'pending' : 'already-synced',
        confidence: 'high' as const,
        gates: [],
        signals: [
          { key: 'same-content-fingerprint', value: sameContent, message: sameContent ? '相同内容指纹已经同步' : '内容指纹尚未同步' },
          { key: 'all-evidence-synced', value: evidenceSynced, message: evidenceSynced ? '全部证据已经同步' : '仍有新增证据' },
        ],
        reasons: [{
          code: pending ? 'devlog.deduplication.pending' : 'devlog.deduplication.already-synced',
          message: pending ? '候选包含尚未同步的新内容或新证据' : '候选内容已经完整同步，本次跳过',
          evidence,
        }],
        evidence,
        constraints: [],
      }));
      return pending;
    });
  }

  async subjectTargets(): Promise<Record<string, string>> {
    const data = await this.read();
    return Object.fromEntries(
      Object.values(data.subjects).map((subject) => [subject.subjectKey, subject.targetRef]),
    );
  }

  async markSynced(
    records: AppendRecord[],
    documentRevision?: number,
  ): Promise<void> {
    const data = await this.read();
    const syncedAt = new Date().toISOString();
    for (const record of records) {
      for (const evidenceId of record.evidenceIds || []) {
        data.evidence[evidenceId] = {
          evidenceId,
          targetRef: record.targetRef,
          ...(documentRevision !== undefined ? { documentRevision } : {}),
          syncedAt,
        };
      }
      if (record.subjectKey && record.contentFingerprint) {
        const existing = data.subjects[record.subjectKey];
        data.subjects[record.subjectKey] = {
          subjectKey: record.subjectKey,
          targetRef: record.targetRef,
          contentFingerprints: [...new Set([
            ...(existing?.contentFingerprints || []),
            record.contentFingerprint,
          ])],
          ...(documentRevision !== undefined ? { lastRevision: documentRevision } : {}),
          updatedAt: syncedAt,
        };
      }
    }
    await this.write(data);
  }

  private async read(): Promise<LedgerData> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as LedgerData | {
        version: 1;
        evidence: Record<string, SyncedEvidence>;
      };
      if (value?.version === 2 && value.evidence && value.subjects) return value;
      if (value?.version === 1 && value.evidence && typeof value.evidence === 'object') {
        return { version: 2, evidence: value.evidence, subjects: {} };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot read dev-log evidence ledger ${this.path}: ${String(error)}`);
      }
    }
    return { version: 2, evidence: {}, subjects: {} };
  }

  private async write(data: LedgerData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
