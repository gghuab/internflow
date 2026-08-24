import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ArtifactStore,
  writeTextArtifact,
} from '../src/core/persistence/artifacts.js';
import type { CaptureSnapshot } from '../src/core/contracts/index.js';
import { buildDecisionAudit, withDecisionId } from '../src/core/decision-audit.js';

describe('ArtifactStore', () => {
  it('persists daily input and the untouched model draft with legacy filenames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-artifacts-'));
    const store = new ArtifactStore({ rootDirectory: root });
    const input = { date: '2026-07-15', captureSnapshotId: 'snapshot', items: [] };
    const draft = '# 2026-07-15\n\nmodel output';

    const inputPath = await store.saveDailyInput('2026-07-15', input);
    const draftPath = await store.saveDailyReportDraft('2026-07-15', draft);

    expect(inputPath).toBe(join(root, 'input-2026-07-15.json'));
    expect(JSON.parse(await readFile(inputPath, 'utf8'))).toEqual(input);
    expect(draftPath).toBe(join(root, 'codex-report-2026-07-15.ai.md'));
    expect(await readFile(draftPath, 'utf8')).toBe(draft);
    expect((await stat(inputPath)).mode & 0o777).toBe(0o600);
  });

  it('persists dev-log snapshots, normalized operations, and separate result files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-dev-artifacts-'));
    const store = new ArtifactStore({ rootDirectory: root });
    const input = { date: '2026-07-15', captureSnapshotId: 'snapshot', candidates: [] };
    const operations = [{ section: 'requirement' as const, targetRef: 'h1', markdown: 'content' }];
    const snapshot = { headings: [{
      ref: 'h1', blockId: 'block-1', level: 2, text: '一、需求开发记录',
      section: 'requirement' as const,
    }] };

    const inputPath = await store.saveDevLogInput('2026-07-15', input);
    const currentPath = await store.saveDevLogCurrent('2026-07-15', '\n# Current doc\n\n');
    const operationsPath = await store.saveDevLogOperations('2026-07-15', operations, snapshot);
    const resultPath = await store.saveDevLogResult({ ok: true, date: '2026-07-15' });
    const dryRunResultPath = await store.saveDevLogResult(
      { ok: true, dryRun: true },
      { dryRun: true },
    );

    expect(inputPath).toBe(join(root, 'dev-log', 'input-2026-07-15.json'));
    expect(JSON.parse(await readFile(inputPath, 'utf8'))).toEqual(input);
    expect(await readFile(currentPath, 'utf8')).toBe('# Current doc\n');
    expect(JSON.parse(await readFile(operationsPath, 'utf8'))).toEqual({ operations: [{
      section: 'requirement', targetHeadingId: 'block-1',
      targetHeading: '一、需求开发记录', markdown: 'content',
    }] });
    expect(resultPath).toBe(join(root, 'dev-log', 'last-result.json'));
    expect(dryRunResultPath).toBe(join(root, 'dev-log', 'last-dry-run-result.json'));
  });

  it('persists inspectable work-layer views with their capture snapshot id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-work-artifacts-'));
    const store = new ArtifactStore({ rootDirectory: root });
    const snapshot: CaptureSnapshot = {
      id: 'snapshot', date: '2026-07-15', timezone: 'Asia/Shanghai', asOf: '2026-07-16T00:00:00Z',
      finalized: true, lateEventCount: 0, events: [], evidence: [],
      quality: {
        discoveredFiles: 1, scannedBytes: 1, validLines: 1, invalidLines: 0, targetOccurrences: 0,
        included: 0, duplicate: 0, replay: 0, unsupported: 0, invalid: 0, rolledBack: 0,
        aborted: 0, orphanToolOutputs: 0, unresolvedParents: [], unknownRelevantEventTypes: [],
        accountingDifference: 0, coverage: 'high', reasons: [],
      },
    };
    const paths = await store.saveWorkLayer('2026-07-15', {
      date: '2026-07-15', timezone: 'Asia/Shanghai', sourceCount: 1, filteredCount: 0,
      activities: [], captureSnapshot: snapshot,
      workItems: [],
      dailyView: {
        items: [], longestWorkItemId: null, longestReason: '无', longestTiedIds: [],
        excludedUnreliableCount: 0, deepDiveCandidateIds: [], takeawayCandidateIds: [],
        presentationPlan: [],
        visualPlan: [],
        quality: { coverage: 'high', reasons: [] },
      },
    });
    expect(paths).toEqual([
      join(root, 'work-facts-2026-07-15.json'),
      join(root, 'work-items-2026-07-15.json'),
      join(root, 'daily-view-2026-07-15.json'),
    ]);
    expect(JSON.parse(await readFile(paths[0]!, 'utf8'))).toMatchObject({
      version: 2, snapshotId: 'snapshot', finalized: true, facts: [],
    });
    expect(JSON.parse(await readFile(paths[1]!, 'utf8')).snapshotId).toBe('snapshot');
    expect((await stat(paths[0]!)).mode & 0o777).toBe(0o600);

    const snapshotPath = join(root, 'cache', '2026-07-15.snapshot.json');
    await mkdir(join(root, 'cache'));
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    const auditPath = await store.saveCaptureAudit('2026-07-15', {
      date: '2026-07-15', timezone: 'Asia/Shanghai', sourceCount: 0, activities: [],
      captureSnapshot: snapshot, captureSnapshotPath: snapshotPath,
    });
    expect(auditPath).not.toBeNull();
    expect((await stat(auditPath!)).ino).toBe((await stat(snapshotPath)).ino);
  });

  it('rejects invalid dates before they can escape the artifact directory', () => {
    const store = new ArtifactStore({ rootDirectory: '/tmp/internflow-artifacts' });

    expect(() => store.dailyInputPath('../../secret')).toThrow('Expected YYYY-MM-DD');
    expect(() => store.devLogPaths('2026-02-30')).toThrow('Invalid calendar date');
    expect(() => store.decisionAuditPath('2026-07-15', '../../job', 'audit')).toThrow('Invalid decision audit job');
  });

  it('persists content-addressed decision audits without overwriting history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-decisions-'));
    const store = new ArtifactStore({ rootDirectory: root });
    const assessment = withDecisionId({
      kind: 'gate' as const,
      policyId: 'capture.coverage', policyVersion: '1.0.0',
      subject: { kind: 'capture' as const, id: 'snapshot' }, outcome: 'accept', confidence: 'high' as const,
      gates: [], signals: [], reasons: [{ code: 'capture.coverage.clean', message: '账本完整', evidence: [] }],
      evidence: [], constraints: [],
    });
    const audit = buildDecisionAudit({
      job: 'daily-report', date: '2026-07-15', timezone: 'Asia/Shanghai', snapshotId: 'snapshot',
      inputFingerprint: 'input', generatedAt: '2026-07-15T23:30:00+08:00', assessments: [assessment],
    });

    const first = await store.saveDecisionAudit(audit);
    const second = await store.saveDecisionAudit({ ...audit, generatedAt: '2026-07-15T23:31:00+08:00' });

    expect(first).toBe(second);
    expect(await store.listDecisionAudits('2026-07-15', 'daily-report')).toEqual([first]);
    expect(await store.readDecisionAudit('2026-07-15', 'daily-report', audit.id)).toMatchObject({ id: audit.id });
    expect((await stat(first)).mode & 0o777).toBe(0o600);
  });

  it('atomically replaces an existing artifact without leaving temporary files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'internflow-atomic-artifact-'));
    const path = join(root, 'artifact.md');

    await writeTextArtifact(path, 'first');
    await writeTextArtifact(path, 'second');

    expect(await readFile(path, 'utf8')).toBe('second');
    expect(await readdir(root)).toEqual(['artifact.md']);
  });
});
