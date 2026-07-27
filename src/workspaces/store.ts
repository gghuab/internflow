import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireStateLock } from '../core/persistence/state-lock.js';
import { expandHome } from '../core/paths.js';
import type {
  WorkspaceCandidate,
  WorkspaceEntry,
  WorkspaceState,
  WorkspaceSubject,
} from '../core/contracts/index.js';
import { PERIOD_LINK_THRESHOLD, linkScore } from '../reports/period/build.js';
import { stableHash } from '../work-items/index.js';

export interface WorkspaceApplyResult {
  state: WorkspaceState;
  path: string;
  entriesAdded: number;
  subjectsCreated: number;
  subjectsUpdated: number;
}

export class WorkspaceStore {
  readonly directory: string;
  readonly path: string;

  constructor(readonly workspaceId: string, directory: string) {
    this.directory = expandHome(directory);
    this.path = join(this.directory, 'workspace.json');
  }

  async read(): Promise<WorkspaceState> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!isWorkspaceState(value) || value.workspaceId !== this.workspaceId) {
        throw new Error('unexpected structure or workspace identity');
      }
      return value;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return emptyWorkspace(this.workspaceId);
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid Workspace state ${this.path}: ${error.message}`);
      }
      if (error instanceof Error && error.message === 'unexpected structure or workspace identity') {
        throw new Error(`Invalid Workspace state ${this.path}: ${error.message}.`);
      }
      throw error;
    }
  }

  async apply(
    candidates: WorkspaceCandidate[],
    options: { dryRun?: boolean; now?: string } = {},
  ): Promise<WorkspaceApplyResult> {
    if (options.dryRun) {
      const result = projectWorkspaceState(
        await this.read(),
        candidates,
        options.now || new Date().toISOString(),
      );
      return { ...result, path: this.path };
    }

    const release = await acquireStateLock(this.path);
    try {
      const state = await this.read();
      const result = projectWorkspaceState(
        state,
        candidates,
        options.now || new Date().toISOString(),
      );
      if (result.entriesAdded) await this.write(result.state);
      return { ...result, path: this.path };
    } finally {
      await release();
    }
  }

  private async write(state: WorkspaceState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      // ponytail: 单文件原子状态优先；只有真实体积成为瓶颈时再拆 append log 和索引。
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export function projectWorkspaceState(
  source: WorkspaceState,
  candidates: WorkspaceCandidate[],
  now: string,
): Omit<WorkspaceApplyResult, 'path'> {
  const state = structuredClone(source);
  const fingerprints = new Set(state.entries.map((entry) => entry.contentFingerprint));
  const entriesBySubject = new Map<string, WorkspaceEntry[]>();
  for (const entry of state.entries) {
    const values = entriesBySubject.get(entry.subjectId) || [];
    values.push(entry);
    entriesBySubject.set(entry.subjectId, values);
  }

  let entriesAdded = 0;
  let subjectsCreated = 0;
  const updated = new Set<string>();

  for (const candidate of candidates) {
    if (fingerprints.has(candidate.contentFingerprint)) continue;
    const matched = matchSubject(state.subjects, entriesBySubject, candidate);
    let subject = matched.subject;
    if (!subject) {
      subject = createSubject(state.workspaceId, candidate);
      state.subjects.push(subject);
      entriesBySubject.set(subject.id, []);
      subjectsCreated += 1;
    } else {
      updated.add(subject.id);
    }

    const entry: WorkspaceEntry = {
      ...candidate,
      id: stableHash(`${subject.id}|${candidate.contentFingerprint}`).slice(0, 24),
      subjectId: subject.id,
      createdAt: now,
      match: {
        method: matched.method,
        score: matched.score,
      },
    };
    state.entries.push(entry);
    entriesBySubject.get(subject.id)?.push(entry);
    fingerprints.add(candidate.contentFingerprint);
    updateSubject(subject, candidate, entry.id);
    entriesAdded += 1;
  }

  if (entriesAdded) {
    state.revision += 1;
    state.updatedAt = now;
    state.subjects.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)
      || left.id.localeCompare(right.id));
  }
  return {
    state,
    entriesAdded,
    subjectsCreated,
    subjectsUpdated: updated.size,
  };
}

function matchSubject(
  subjects: WorkspaceSubject[],
  entriesBySubject: Map<string, WorkspaceEntry[]>,
  candidate: WorkspaceCandidate,
): {
  subject: WorkspaceSubject | null;
  method: WorkspaceEntry['match']['method'];
  score: number;
} {
  const exact = subjects.find((subject) =>
    subject.repositoryKey === candidate.repositoryKey
    && subject.subjectKeys.includes(candidate.subjectKey));
  if (exact) return { subject: exact, method: 'subject-key', score: 100 };

  const alternatives = subjects
    .filter((subject) =>
      subject.repositoryKey === candidate.repositoryKey
      // 跨日评分不能反向合并同一天已被 WorkItem 层分开的两个主题。
      && !(entriesBySubject.get(subject.id) || []).some((entry) => entry.date === candidate.date))
    .map((subject) => ({
      subject,
      score: Math.max(
        0,
        ...(entriesBySubject.get(subject.id) || []).map((entry) => linkScore(entry, candidate)),
      ),
    }))
    .sort((left, right) => right.score - left.score || left.subject.id.localeCompare(right.subject.id));
  const best = alternatives[0];
  if (best && best.score >= PERIOD_LINK_THRESHOLD) {
    return { subject: best.subject, method: 'cross-day', score: best.score };
  }
  return { subject: null, method: 'new', score: best?.score || 0 };
}

function createSubject(workspaceId: string, candidate: WorkspaceCandidate): WorkspaceSubject {
  const latestVerification = candidate.verifications.at(-1);
  return {
    id: stableHash(`${workspaceId}|${candidate.repositoryKey}|${candidate.date}|${candidate.workItemId}`)
      .slice(0, 20),
    title: candidate.title,
    repositoryKey: candidate.repositoryKey,
    status: candidate.status,
    subjectKeys: [candidate.subjectKey],
    branches: candidate.branch ? [candidate.branch] : [],
    commits: [...candidate.commits],
    firstSeenAt: candidate.date,
    lastSeenAt: candidate.date,
    evidenceIds: [...candidate.evidenceIds],
    entryIds: [],
    current: {
      goal: candidate.goal,
      outcomes: [...candidate.outcomes],
      blockers: [...candidate.blockers],
      latestVerification: latestVerification
        ? `${latestVerification.command}: ${latestVerification.outcome}`
        : null,
    },
  };
}

function updateSubject(
  subject: WorkspaceSubject,
  candidate: WorkspaceCandidate,
  entryId: string,
): void {
  subject.subjectKeys = unique([...subject.subjectKeys, candidate.subjectKey]);
  subject.branches = unique([...subject.branches, ...(candidate.branch ? [candidate.branch] : [])]);
  subject.commits = unique([...subject.commits, ...candidate.commits]);
  subject.evidenceIds = unique([...subject.evidenceIds, ...candidate.evidenceIds]);
  subject.entryIds = unique([...subject.entryIds, entryId]);
  subject.firstSeenAt = candidate.date < subject.firstSeenAt ? candidate.date : subject.firstSeenAt;
  if (candidate.date < subject.lastSeenAt) return;

  const latestVerification = candidate.verifications.at(-1);
  subject.lastSeenAt = candidate.date;
  subject.title = candidate.title;
  subject.status = candidate.status;
  subject.current = {
    goal: candidate.goal,
    outcomes: [...candidate.outcomes],
    blockers: [...candidate.blockers],
    latestVerification: latestVerification
      ? `${latestVerification.command}: ${latestVerification.outcome}`
      : null,
  };
}

function emptyWorkspace(workspaceId: string): WorkspaceState {
  return {
    version: 1,
    workspaceId,
    revision: 0,
    updatedAt: null,
    subjects: [],
    entries: [],
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<WorkspaceState>;
  return state.version === 1
    && typeof state.workspaceId === 'string'
    && Number.isInteger(state.revision)
    && (state.updatedAt === null || typeof state.updatedAt === 'string')
    && Array.isArray(state.subjects)
    && state.subjects.every((subject) => Boolean(
      subject
      && typeof subject.id === 'string'
      && typeof subject.repositoryKey === 'string'
      && Array.isArray(subject.subjectKeys)
      && Array.isArray(subject.entryIds),
    ))
    && Array.isArray(state.entries)
    && state.entries.every((entry) => Boolean(
      entry
      && typeof entry.id === 'string'
      && typeof entry.subjectId === 'string'
      && typeof entry.contentFingerprint === 'string'
      && typeof entry.date === 'string'
      && Array.isArray(entry.evidenceIds),
    ));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
