import type { WorkItem } from '../types.js';

export function assertTraceability(
  item: WorkItem,
  validEvidenceIds: Set<string>,
  validEventIds: Set<string>,
  hasSnapshot: boolean,
): WorkItem {
  for (const id of item.evidenceIds) {
    if (!validEvidenceIds.has(id)) throw new Error(`WorkItem ${item.id} cites unknown evidence ${id}.`);
  }
  if (hasSnapshot) {
    for (const excerpt of item.changes.flatMap((change) => change.excerpts)) {
      if (!validEventIds.has(excerpt.sourceEventId)) {
        throw new Error(`WorkItem ${item.id} cites unknown source event ${excerpt.sourceEventId}.`);
      }
    }
  }
  return item;
}
