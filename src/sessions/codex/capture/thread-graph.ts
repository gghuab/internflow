import type { NormalizedCodexEvent } from './ledger-types.js';

export interface ThreadGraphResult {
  unresolvedParents: string[];
  cycles: string[];
}

export function resolveThreadGraph(events: NormalizedCodexEvent[]): ThreadGraphResult {
  const parents = new Map<string, string>();
  const sessions = new Set(events.map((event) => event.sessionId));
  for (const event of events) {
    if (event.parentSessionId && event.parentSessionId !== event.sessionId) {
      parents.set(event.sessionId, event.parentSessionId);
    }
  }
  const unresolvedParents = [...new Set(
    [...parents.values()].filter((parent) => !sessions.has(parent)),
  )].sort();
  const cycles = new Set<string>();
  for (const event of events) {
    event.rootSessionId = resolveRoot(event.sessionId, parents, cycles);
  }
  return { unresolvedParents, cycles: [...cycles].sort() };
}

function resolveRoot(sessionId: string, parents: Map<string, string>, cycles: Set<string>): string {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = sessionId;
  while (parents.has(current)) {
    if (seen.has(current)) {
      for (const item of path) cycles.add(item);
      return [...path].sort()[0] || sessionId;
    }
    seen.add(current);
    path.push(current);
    current = parents.get(current) || current;
  }
  return current;
}
