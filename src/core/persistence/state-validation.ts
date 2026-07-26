import { createHash } from 'node:crypto';
import type { OutputArtifact } from '../contracts/index.js';
import type { StoredRunArtifact } from './state-types.js';

export function artifactHash(artifact: OutputArtifact): string {
  return createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
}

export function parseStoredArtifact(
  source: string,
  path: string,
  expectedJob: string,
  expectedDate: string,
): StoredRunArtifact {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid InternFlow artifact ${path}: ${String(error)}`);
  }
  if (!isStoredRunArtifact(value)) {
    throw new Error(`Invalid InternFlow artifact ${path}: unexpected structure.`);
  }
  if (value.job !== expectedJob || value.date !== expectedDate) {
    throw new Error(`Invalid InternFlow artifact ${path}: run identity does not match its path.`);
  }
  if (value.hash !== artifactHash(value.artifact)) {
    throw new Error(`Invalid InternFlow artifact ${path}: content hash mismatch.`);
  }
  return value;
}

export function validateRunIdentity(job: string, date: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(job)) {
    throw new Error(`Invalid InternFlow artifact job: ${job}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid InternFlow artifact date: ${date}`);
  }
}

function isStoredRunArtifact(value: unknown): value is StoredRunArtifact {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredRunArtifact>;
  return candidate.version === 1
    && typeof candidate.job === 'string'
    && typeof candidate.date === 'string'
    && typeof candidate.createdAt === 'string'
    && typeof candidate.hash === 'string'
    && Number.isInteger(candidate.sourceCount)
    && Number(candidate.sourceCount) >= 0
    && Number.isInteger(candidate.activityCount)
    && Number(candidate.activityCount) >= 0
    && isOutputArtifact(candidate.artifact)
    && Boolean(candidate.snapshots && typeof candidate.snapshots === 'object' && !Array.isArray(candidate.snapshots))
    && (candidate.generationSnapshot === null
      || Boolean(candidate.generationSnapshot && typeof candidate.generationSnapshot === 'object'));
}

function isOutputArtifact(value: unknown): value is OutputArtifact {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false;
  if (value.kind === 'markdown') {
    return 'markdown' in value && typeof value.markdown === 'string';
  }
  if (value.kind !== 'records' || !('records' in value) || !Array.isArray(value.records)) return false;
  return value.records.every((record) => Boolean(
    record
    && typeof record === 'object'
    && 'section' in record
    && ['requirement', 'bugfix', 'insight'].includes(String(record.section))
    && 'targetRef' in record
    && typeof record.targetRef === 'string'
    && 'markdown' in record
    && typeof record.markdown === 'string',
  ));
}
