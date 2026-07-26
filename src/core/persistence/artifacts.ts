import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertLocalDate } from '../calendar.js';
import type {
  ActivityBatch,
  ActivitySourceBatch,
  AppendRecord,
  DecisionAudit,
  SinkSnapshot,
  WorkFactIndex,
} from '../contracts/index.js';
import { validateDecisionAudit } from '../decision-audit.js';
import { expandHome, stateDirectory } from '../paths.js';

export interface ArtifactStoreOptions {
  dailyDirectory?: string;
  rootDirectory?: string;
  devLogDirectory?: string;
}

export interface DevLogArtifactPaths {
  input: string;
  current: string;
  operations: string;
  result: string;
}

export class ArtifactStore {
  readonly rootDirectory: string;
  readonly devLogDirectory: string;

  constructor(options: ArtifactStoreOptions = {}) {
    this.rootDirectory = expandHome(
      options.dailyDirectory || options.rootDirectory || join(stateDirectory(), 'artifacts'),
    );
    this.devLogDirectory = expandHome(
      options.devLogDirectory || join(this.rootDirectory, 'dev-log'),
    );
  }

  dailyInputPath(date: string): string {
    assertLocalDate(date);
    return join(this.rootDirectory, `input-${date}.json`);
  }

  dailyReportDraftPath(date: string): string {
    assertLocalDate(date);
    return join(this.rootDirectory, `codex-report-${date}.ai.md`);
  }

  captureAuditPath(date: string): string {
    assertLocalDate(date);
    return join(this.rootDirectory, `capture-audit-${date}.json`);
  }

  workItemsPath(date: string): string {
    assertLocalDate(date);
    return join(this.rootDirectory, `work-items-${date}.json`);
  }

  workFactsPath(date: string): string {
    assertLocalDate(date);
    return join(this.rootDirectory, `work-facts-${date}.json`);
  }

  dailyViewPath(date: string): string {
    assertLocalDate(date);
    return join(this.rootDirectory, `daily-view-${date}.json`);
  }

  periodViewPath(unit: 'week' | 'month', date: string): string {
    assertLocalDate(date);
    return join(this.rootDirectory, `${unit}-view-${date}.json`);
  }

  periodInputPath(unit: 'week' | 'month', date: string): string {
    assertLocalDate(date);
    return join(this.rootDirectory, `${unit}-input-${date}.json`);
  }

  periodReportDraftPath(unit: 'week' | 'month', date: string): string {
    assertLocalDate(date);
    return join(this.rootDirectory, `codex-${unit}-report-${date}.ai.md`);
  }

  devLogCandidatesPath(date: string): string {
    assertLocalDate(date);
    return join(this.devLogDirectory, `candidates-${date}.json`);
  }

  decisionAuditPath(date: string, job: string, auditId: string): string {
    assertLocalDate(date);
    assertSafeSegment(job, 'job');
    assertSafeSegment(auditId, 'audit id');
    return join(this.rootDirectory, 'decisions', date, `${job}-${auditId}.json`);
  }

  devLogPaths(date: string, dryRun = false): DevLogArtifactPaths {
    assertLocalDate(date);
    return {
      input: join(this.devLogDirectory, `input-${date}.json`),
      current: join(this.devLogDirectory, `current-${date}.md`),
      operations: join(this.devLogDirectory, `operations-${date}.json`),
      result: this.devLogResultPath(dryRun),
    };
  }

  devLogResultPath(dryRun = false): string {
    return join(
      this.devLogDirectory,
      dryRun ? 'last-dry-run-result.json' : 'last-result.json',
    );
  }

  async saveDailyInput(date: string, input: unknown): Promise<string> {
    return writeJsonArtifact(this.dailyInputPath(date), input);
  }

  async saveDailyReportDraft(date: string, markdown: string): Promise<string> {
    return writeTextArtifact(this.dailyReportDraftPath(date), markdown);
  }

  async saveCaptureAudit(date: string, input: ActivitySourceBatch): Promise<string | null> {
    if (!input.captureSnapshot) return null;
    const path = this.captureAuditPath(date);
    if (input.captureSnapshotPath) {
      return linkArtifact(input.captureSnapshotPath, path, input.captureSnapshot);
    }
    return writeJsonArtifact(path, input.captureSnapshot);
  }

  async saveWorkLayer(date: string, input: ActivityBatch): Promise<string[]> {
    const paths: string[] = [];
    if (input.captureSnapshot) {
      paths.push(await writeJsonArtifact(this.workFactsPath(date), {
        version: 2,
        date,
        timezone: input.timezone,
        snapshotId: input.captureSnapshot.id,
        asOf: input.captureSnapshot.asOf,
        finalized: input.captureSnapshot.finalized,
        ...(input.captureSnapshot.finalizedAt ? { finalizedAt: input.captureSnapshot.finalizedAt } : {}),
        ...(input.captureSnapshot.finalizationBasis
          ? { finalizationBasis: input.captureSnapshot.finalizationBasis }
          : {}),
        quality: input.captureSnapshot.quality,
        facts: input.captureSnapshot.evidence,
      }));
    }
    if (input.workItems) {
      paths.push(await writeJsonArtifact(this.workItemsPath(date), {
        snapshotId: input.captureSnapshot?.id,
        workItems: input.workItems,
      }));
    }
    if (input.dailyView) {
      paths.push(await writeJsonArtifact(this.dailyViewPath(date), {
        snapshotId: input.captureSnapshot?.id,
        dailyView: input.dailyView,
      }));
    }
    if (input.devLogCandidates) {
      paths.push(await writeJsonArtifact(this.devLogCandidatesPath(date), {
        snapshotId: input.captureSnapshot?.id,
        candidates: input.devLogCandidates,
      }));
    }
    return paths;
  }

  async savePeriodView(unit: 'week' | 'month', date: string, input: unknown): Promise<string> {
    return writeJsonArtifact(this.periodViewPath(unit, date), input);
  }

  async saveWorkFactIndex(date: string, input: WorkFactIndex): Promise<string> {
    return writeJsonArtifact(this.workFactsPath(date), input);
  }

  async savePeriodInput(unit: 'week' | 'month', date: string, input: unknown): Promise<string> {
    return writeJsonArtifact(this.periodInputPath(unit, date), input);
  }

  async savePeriodReportDraft(unit: 'week' | 'month', date: string, markdown: string): Promise<string> {
    return writeTextArtifact(this.periodReportDraftPath(unit, date), markdown);
  }

  async saveDecisionAudit(audit: DecisionAudit): Promise<string> {
    const validated = validateDecisionAudit(audit);
    const path = this.decisionAuditPath(validated.date, validated.job, validated.id);
    return writeImmutableJsonArtifact(path, validated);
  }

  async listDecisionAudits(date: string, job?: string): Promise<string[]> {
    assertLocalDate(date);
    if (job) assertSafeSegment(job, 'job');
    const directory = join(this.rootDirectory, 'decisions', date);
    try {
      return (await readdir(directory))
        .filter((name) => name.endsWith('.json') && (!job || name.startsWith(`${job}-`)))
        .sort()
        .map((name) => join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async readDecisionAudit(date: string, job: string, auditId: string): Promise<DecisionAudit> {
    const path = this.decisionAuditPath(date, job, auditId);
    return validateDecisionAudit(JSON.parse(await readFile(path, 'utf8')));
  }

  async readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, 'utf8'));
  }

  async saveDevLogInput(date: string, input: unknown): Promise<string> {
    return writeJsonArtifact(this.devLogPaths(date).input, input);
  }

  async saveDevLogCurrent(date: string, markdown: string): Promise<string> {
    // 正文快照统一只保留一个结尾换行，便于后续 diff 与审计。
    return writeTextArtifact(this.devLogPaths(date).current, `${markdown.trim()}\n`);
  }

  async saveDevLogOperations(
    date: string,
    operations: readonly AppendRecord[],
    snapshot?: SinkSnapshot,
  ): Promise<string> {
    const headings = new Map((snapshot?.headings || []).map((heading) => [heading.ref, heading]));
    const persistedOperations = operations.map((operation) => {
      const heading = headings.get(operation.targetRef);
      if (!heading) throw new Error(`Cannot persist unknown heading ref: ${operation.targetRef}`);
      return {
        section: operation.section,
        targetHeadingId: heading.blockId,
        targetHeading: heading.text,
        markdown: operation.markdown,
        ...(operation.evidenceIds?.length ? { evidenceIds: operation.evidenceIds } : {}),
        ...(operation.candidateId ? { candidateId: operation.candidateId } : {}),
        ...(operation.subjectKey ? { subjectKey: operation.subjectKey } : {}),
        ...(operation.contentFingerprint ? { contentFingerprint: operation.contentFingerprint } : {}),
      };
    });
    return writeJsonArtifact(this.devLogPaths(date).operations, { operations: persistedOperations });
  }

  async saveDevLogResult(
    result: unknown,
    options: { dryRun?: boolean } = {},
  ): Promise<string> {
    return writeJsonArtifact(this.devLogResultPath(Boolean(options.dryRun)), result);
  }
}

export async function writeJsonArtifact(path: string, value: unknown): Promise<string> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new Error(`Cannot serialize JSON artifact ${path}.`);
  }
  return writeTextArtifact(path, `${serialized}\n`);
}

async function writeImmutableJsonArtifact(path: string, value: unknown): Promise<string> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await link(temporary, path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = JSON.parse(await readFile(path, 'utf8')) as { id?: string };
      const next = value as { id?: string };
      if (!existing.id || existing.id !== next.id) {
        throw new Error(`Decision audit collision at ${path}.`);
      }
      return path;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function linkArtifact(source: string, path: string, fallback: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await link(source, temporary);
    await rename(temporary, path);
    return path;
  } catch (error) {
    await rm(temporary, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'ENOENT') throw error;
    return writeJsonArtifact(path, fallback);
  }
}

export async function writeTextArtifact(path: string, content: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // 先完整写入同目录临时文件，再原子替换，避免定时任务留下半截产物。
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    return path;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function assertSafeSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value)) {
    throw new Error(`Invalid decision audit ${label}: ${JSON.stringify(value)}`);
  }
}
