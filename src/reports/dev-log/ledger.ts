import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  AppendRecord,
  DecisionAssessment,
  HeadingReference,
  WorkEvidence,
} from '../../core/contracts/index.js';
import { withDecisionId } from '../../core/decision-audit.js';
import type { DevLogSubjectBinding } from './document-index.js';
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
  targetBlockId?: string;
  targetHeading?: string;
  contentFingerprints: string[];
  lastRevision?: number;
  updatedAt: string;
}

interface LedgerData {
  version: 3;
  semanticVersion: '2.0.0';
  evidence: Record<string, SyncedEvidence>;
  subjects: Record<string, SyncedSubject>;
}

const EMPTY_LEDGER = (): LedgerData => ({
  version: 3,
  semanticVersion: '2.0.0',
  evidence: {},
  subjects: {},
});

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
      // 同一证据在语义策略升级后可能得到新的标题或分类；内容指纹变化时必须允许重放。
      const pending = !sameContent;
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
      Object.values(data.subjects).flatMap((subject) => (
        subject.targetBlockId ? [[subject.subjectKey, subject.targetBlockId]] : []
      )),
    );
  }

  async subjectBindings(): Promise<Record<string, DevLogSubjectBinding>> {
    const data = await this.read();
    return Object.fromEntries(
      Object.values(data.subjects).flatMap((subject) => (
        subject.targetBlockId || subject.targetHeading
          ? [[subject.subjectKey, {
            ...(subject.targetBlockId ? { blockId: subject.targetBlockId } : {}),
            ...(subject.targetHeading ? { headingText: subject.targetHeading } : {}),
          }]]
          : []
      )),
    );
  }

  async markSynced(
    records: AppendRecord[],
    documentRevision?: number,
    headings: HeadingReference[] = [],
  ): Promise<void> {
    const data = await this.read();
    const syncedAt = new Date().toISOString();
    const headingsByRef = new Map(headings.map((heading) => [heading.ref, heading]));
    for (const record of records) {
      for (const evidenceId of record.evidenceIds || []) {
        data.evidence[evidenceId] = {
          evidenceId,
          targetRef: record.targetRef,
          ...(documentRevision !== undefined ? { documentRevision } : {}),
          syncedAt,
        };
      }
      const bindSubject = record.bindSubject !== false && record.section !== 'overview';
      if (bindSubject && record.subjectKey && record.contentFingerprint) {
        const existing = data.subjects[record.subjectKey];
        const target = headingsByRef.get(record.targetRef);
        const subjectHeading = target ? enclosingSubjectHeading(headings, target) : undefined;
        const targetBlockId = record.operation !== 'create' && record.operation !== 'replace'
          ? subjectHeading?.blockId || existing?.targetBlockId
          : undefined;
        const targetHeading = record.subjectHeading || subjectHeading?.text || existing?.targetHeading;
        data.subjects[record.subjectKey] = {
          subjectKey: record.subjectKey,
          targetRef: record.targetRef,
          ...(targetBlockId ? { targetBlockId } : {}),
          ...(targetHeading ? { targetHeading } : {}),
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
      const value = JSON.parse(await readFile(this.path, 'utf8')) as {
        version?: number;
        semanticVersion?: string;
        evidence?: Record<string, SyncedEvidence>;
        subjects?: Record<string, SyncedSubject>;
      };
      if (value?.version === 3 && value.semanticVersion === '2.0.0' && value.evidence && value.subjects) {
        return value as LedgerData;
      }
      // v1/v2 使用“分支即需求”和“Bug 可改写为需求”的旧语义，不能继承其绑定与去重结果。
      if (value?.version === 1 || value?.version === 2 || value?.version === 3) return EMPTY_LEDGER();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot read dev-log evidence ledger ${this.path}: ${String(error)}`);
      }
    }
    return EMPTY_LEDGER();
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

function enclosingSubjectHeading(
  headings: HeadingReference[],
  target: HeadingReference,
): HeadingReference | undefined {
  if (target.level === 3) return target;
  const index = headings.indexOf(target);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const heading = headings[cursor];
    if (!heading || heading.level < 3) return undefined;
    if (heading.level === 3) return heading;
  }
  return undefined;
}
