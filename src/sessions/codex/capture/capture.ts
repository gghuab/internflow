import { createHash } from 'node:crypto';
import { discoverSessionFiles } from '../storage/files.js';
import { buildWorkEvidence } from './evidence.js';
import type { InvalidJsonlRecord, RuntimeCapture } from './ledger-types.js';
import { reduceLifecycle } from './lifecycle.js';
import { normalizeFileEvents } from './normalize.js';
import { evaluateCaptureQuality } from './quality.js';
import { readJsonlFile } from '../storage/reader.js';
import { resolveThreadGraph } from './thread-graph.js';
import { localDate } from '../support/time.js';
import { loadCaptureSnapshot, saveCaptureSnapshot } from '../storage/cache.js';
import { stringValue } from '../support/json.js';
import type { ReadJsonlRecord } from './ledger-types.js';

export async function captureCodexDay(
  root: string,
  date: string,
  timezone: string,
  now = new Date(),
  options: { cacheFile?: string; files?: string[]; finalizationCutoff?: string } = {},
): Promise<RuntimeCapture> {
  const files = options.files || await discoverSessionFiles(root, date);
  const reads = await mapWithConcurrency(files, 4, async (file) => {
    const read = await readJsonlFile(file);
    const validLines = read.records.length;
    read.records = selectCaptureRecords(read.records, date, timezone);
    return { read, validLines };
  });
  const recordsByFile = new Map(reads.map(({ read }) => [read.file, read.records]));
  const invalid = reads.flatMap(({ read }) => read.invalid);
  const events = reads.flatMap(({ read }) => normalizeFileEvents(read.file, read.records, timezone));
  const graph = resolveThreadGraph(events);
  reduceLifecycle(events, date, timezone);
  const quality = evaluateCaptureQuality(events, invalid, {
    date,
    discoveredFiles: files.length,
    scannedBytes: reads.reduce((total, item) => total + item.read.bytesRead, 0),
    validLines: reads.reduce((total, item) => total + item.validLines, 0),
    unresolvedParents: graph.unresolvedParents,
    cycles: graph.cycles,
  });
  const evidence = buildWorkEvidence(events.filter((event) => event.localDate === date));
  const finalizationBasis = finalizationBasisFor(
    date,
    timezone,
    now,
    10,
    options.finalizationCutoff,
  );
  const finalized = finalizationBasis !== null;
  const asOf = now.toISOString();
  const snapshotMaterial = events
    .filter((event) => event.localDate === date)
    .map((event) => `${event.occurrenceId}:${event.disposition}:${event.lifecycle}`)
    .sort().join('\n');
  const id = createHash('sha256').update(`${date}\n${timezone}\n${snapshotMaterial}`).digest('hex');
  const previous = options.cacheFile ? await loadCaptureSnapshot(options.cacheFile) : null;
  const previousEvidence = new Set(previous?.evidence.map((item) => item.id) || []);
  const lateEventCount = previous?.finalized && previous.id !== id
    ? evidence.filter((item) => !previousEvidence.has(item.id)).length
    : 0;
  const snapshot = {
      id,
      date,
      timezone,
      asOf,
      finalized,
      ...(finalized ? { finalizedAt: asOf } : {}),
      ...(finalizationBasis ? { finalizationBasis } : {}),
      lateEventCount,
      quality,
      events: events
        .filter((event) => event.localDate === date)
        .map((event) => ({
          occurrenceId: event.occurrenceId,
          semanticFingerprint: event.semanticFingerprint,
          sessionId: event.sessionId,
          ...(event.parentSessionId ? { parentSessionId: event.parentSessionId } : {}),
          ...(event.rootSessionId ? { rootSessionId: event.rootSessionId } : {}),
          ...(event.turnId ? { turnId: event.turnId } : {}),
          ...(event.callId ? { callId: event.callId } : {}),
          timestamp: event.timestamp,
          kind: event.kind,
          representation: event.representation,
          disposition: event.disposition,
          lifecycle: event.lifecycle,
          source: event.source,
          payloadLength: event.payloadLength,
          payloadSha256: event.payloadSha256,
        })),
      evidence,
    };
  if (options.cacheFile) await saveCaptureSnapshot(options.cacheFile, snapshot);
  return {
    snapshot,
    events,
    recordsByFile,
  };
}

function selectCaptureRecords(
  records: ReadJsonlRecord[],
  date: string,
  timezone: string,
): ReadJsonlRecord[] {
  const kept: ReadJsonlRecord[] = [];
  let previousUser: ReadJsonlRecord | undefined;
  let previousAssistant: ReadJsonlRecord | undefined;
  for (const record of records) {
    const event = record.event;
    const timestamp = stringValue(event.timestamp);
    const eventDate = timestamp && Number.isFinite(Date.parse(timestamp))
      ? localDate(timestamp, timezone)
      : '';
    if (event.type === 'session_meta' && (!eventDate || eventDate <= date)) {
      kept.push(record);
      continue;
    }
    if (eventDate === date) {
      kept.push(record);
      continue;
    }
    if (!eventDate || eventDate >= date) continue;
    const payload = event.payload || {};
    if (payload.type === 'message' && payload.role === 'user' || payload.type === 'user_message') {
      previousUser = record;
    }
    if (payload.type === 'message' && payload.role === 'assistant' || payload.type === 'agent_message') {
      previousAssistant = record;
    }
  }
  if (previousUser) kept.push(previousUser);
  if (previousAssistant) kept.push(previousAssistant);
  return kept.sort((left, right) => left.source.byteStart - right.source.byteStart);
}

function finalizationBasisFor(
  date: string,
  timezone: string,
  now: Date,
  graceMinutes: number,
  cutoff?: string,
): 'calendar-day' | 'configured-cutoff' | null {
  const nowDate = localDate(now.toISOString(), timezone);
  const localMinute = localMinuteOfDay(now, timezone);
  if (nowDate === date && cutoff && localMinute >= minuteOfDay(cutoff)) {
    // 用户明确把该时间视为工作日结束；迟到事件仍会使缓存失效并被重新记账。
    return 'configured-cutoff';
  }
  if (nowDate <= date) return null;
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDate = next.toISOString().slice(0, 10);
  if (nowDate > nextDate) return 'calendar-day';
  return localMinute >= graceMinutes ? 'calendar-day' : null;
}

function localMinuteOfDay(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const number = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return number('hour') * 60 + number('minute');
}

function minuteOfDay(time: string): number {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return hour * 60 + minute;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}
