import { numberValue, stringValue } from '../support/json.js';
import type { NormalizedCodexEvent } from './ledger-types.js';
import { detectReplayBursts, isReplayBurstEvent } from '../support/time.js';

const DUPLICATE_WINDOW_MS = 2000;

export function reduceLifecycle(
  events: NormalizedCodexEvent[],
  date: string,
  timezone: string,
): NormalizedCodexEvent[] {
  const bySession = new Map<string, NormalizedCodexEvent[]>();
  for (const event of events) {
    const values = bySession.get(event.sessionId) || [];
    values.push(event);
    bySession.set(event.sessionId, values);
  }
  for (const sessionEvents of bySession.values()) reduceSession(sessionEvents, date, timezone);
  return events;
}

function reduceSession(
  events: NormalizedCodexEvent[],
  date: string,
  timezone: string,
): void {
  const target = events
    .filter((event) => event.localDate === date)
    .sort(compareEvents);
  const bursts = detectReplayBursts(target.map((event) => event.raw), date, timezone);
  const seenMessages = new Map<string, NormalizedCodexEvent>();
  const turns: Array<{ id: string; events: NormalizedCodexEvent[] }> = [];
  let currentTurn: { id: string; events: NormalizedCodexEvent[] } | undefined;

  for (const event of target) {
    if (event.disposition === 'unsupported') continue;
    if (isReplayCandidate(event) && isReplayBurstEvent(event.raw, bursts)) {
      event.disposition = 'replay';
      continue;
    }
    if (event.kind === 'message' && isDuplicateMessage(event, seenMessages)) {
      event.disposition = 'duplicate';
      continue;
    }
    if (event.kind === 'rollback') {
      const count = Math.max(1, numberValue(event.raw.payload?.num_turns) || 1);
      const candidates = turns.filter((turn) => turn.events.some((item) => item.lifecycle === 'confirmed'));
      for (const turn of candidates.slice(-count)) {
        for (const item of turn.events) item.lifecycle = 'rolled_back';
      }
      currentTurn = undefined;
      continue;
    }
    if (event.kind === 'abort') {
      if (currentTurn) for (const item of currentTurn.events) item.lifecycle = 'aborted';
      currentTurn = undefined;
      continue;
    }
    if (isUserMessage(event)) {
      currentTurn = { id: `${event.sessionId}:turn:${turns.length + 1}`, events: [] };
      turns.push(currentTurn);
    }
    if (currentTurn && isWorkEvent(event)) {
      event.turnId = currentTurn.id;
      currentTurn.events.push(event);
    }
  }
}

function isDuplicateMessage(
  event: NormalizedCodexEvent,
  seen: Map<string, NormalizedCodexEvent>,
): boolean {
  const previous = seen.get(event.semanticFingerprint);
  seen.set(event.semanticFingerprint, event);
  if (!previous || previous.representation === event.representation) return false;
  const left = Date.parse(previous.timestamp);
  const right = Date.parse(event.timestamp);
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(right - left) <= DUPLICATE_WINDOW_MS;
}

function isReplayCandidate(event: NormalizedCodexEvent): boolean {
  return ['message', 'tool_call', 'tool_output', 'command_result', 'patch_result'].includes(event.kind);
}

function isWorkEvent(event: NormalizedCodexEvent): boolean {
  return !['session_metadata', 'telemetry', 'rollback', 'abort', 'context_compacted'].includes(event.kind);
}

function isUserMessage(event: NormalizedCodexEvent): boolean {
  const payload = event.raw.payload || {};
  return (payload.type === 'message' && payload.role === 'user') || payload.type === 'user_message';
}

function compareEvents(left: NormalizedCodexEvent, right: NormalizedCodexEvent): number {
  const time = String(left.timestamp).localeCompare(String(right.timestamp));
  if (time) return time;
  if (left.source.file !== right.source.file) return left.source.file.localeCompare(right.source.file);
  return left.source.byteStart - right.source.byteStart;
}
