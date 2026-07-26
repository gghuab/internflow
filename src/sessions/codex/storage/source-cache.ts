import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Activity, CaptureSnapshot, CaptureSummary } from '../../../core/contracts/index.js';
import { loadCaptureSnapshot, saveCaptureSnapshot } from './cache.js';
import { localDate } from '../support/time.js';

export interface SessionFileManifest {
  file: string;
  size: number;
  mtimeMs: number;
}

export interface CodexSourceCache {
  version: 2;
  date: string;
  timezone: string;
  configKey: string;
  manifest: SessionFileManifest[];
  snapshot: CaptureSnapshot;
  captureSummary: CaptureSummary;
  sourceActivities: Activity[];
}

export async function buildSessionManifest(files: string[]): Promise<SessionFileManifest[]> {
  return Promise.all(files.map(async (file) => {
    const value = await stat(file);
    return { file, size: value.size, mtimeMs: value.mtimeMs };
  }));
}

export async function loadCodexSourceCache(
  path: string,
  expected: Pick<CodexSourceCache, 'date' | 'timezone' | 'configKey'>,
): Promise<CodexSourceCache | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as StoredCodexSourceCache;
    if (value?.version !== 1 && value?.version !== 2) return null;
    if (value.date !== expected.date || value.timezone !== expected.timezone || value.configKey !== expected.configKey) return null;
    const snapshotPath = join(dirname(path), `${value.date}.snapshot.json`);
    const snapshot = value.version === 1
      ? value.snapshot
      : await loadCaptureSnapshot(snapshotPath);
    if (!snapshot?.finalized) return null;
    if (value.version === 2 && snapshot.id !== value.snapshotId) return null;
    if (value.version === 1 && !(await loadCaptureSnapshot(snapshotPath))) {
      await saveCaptureSnapshot(snapshotPath, snapshot);
    }
    return {
      version: 2,
      date: value.date,
      timezone: value.timezone,
      configKey: value.configKey,
      manifest: value.manifest,
      snapshot,
      captureSummary: value.captureSummary,
      sourceActivities: value.sourceActivities,
    };
  } catch {
    return null;
  }
}

export async function refreshSessionManifest(
  cached: SessionFileManifest[],
  current: SessionFileManifest[],
  date: string,
  timezone: string,
): Promise<SessionFileManifest[] | null> {
  const previousByFile = new Map(cached.map((item) => [item.file, item]));
  const currentByFile = new Map(current.map((item) => [item.file, item]));
  if (cached.some((item) => !currentByFile.has(item.file))) return null;
  for (const item of current) {
    const previous = previousByFile.get(item.file);
    if (!previous) {
      if (await rangeContainsDate(item.file, 0, date, timezone)) return null;
      continue;
    }
    if (item.size < previous.size) return null;
    if (item.size === previous.size) {
      if (item.mtimeMs !== previous.mtimeMs) return null;
      continue;
    }
    // Codex rollout 是追加日志；只检查新增尾部是否出现目标日期事件。
    if (await rangeContainsDate(item.file, previous.size, date, timezone)) return null;
  }
  return current;
}

export async function saveCodexSourceCache(path: string, value: CodexSourceCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const { snapshot, ...rest } = value;
    const stored: StoredCodexSourceCacheV2 = {
      ...rest,
      version: 2,
      snapshotId: snapshot.id,
    };
    await writeFile(temporary, `${JSON.stringify(stored)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

interface StoredCodexSourceCacheV1 extends Omit<CodexSourceCache, 'version'> {
  version: 1;
}

interface StoredCodexSourceCacheV2 extends Omit<CodexSourceCache, 'snapshot'> {
  snapshotId: string;
}

type StoredCodexSourceCache = StoredCodexSourceCacheV1 | StoredCodexSourceCacheV2;

async function rangeContainsDate(
  file: string,
  start: number,
  date: string,
  timezone: string,
): Promise<boolean> {
  const handle = createReadStream(file, { start });
  let text = '';
  for await (const chunk of handle) text += Buffer.from(chunk).toString('utf8');
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line) as { timestamp?: unknown };
      if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) continue;
      if (localDate(value.timestamp, timezone) === date) return true;
    } catch {
      // 追加区间出现非末尾坏行时不能证明没有目标事件，保守失效。
      if (index < lines.length - 1) return true;
    }
  }
  return false;
}
