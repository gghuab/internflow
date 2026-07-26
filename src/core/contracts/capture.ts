export interface VerifiedCodeExcerpt {
  file: string;
  language: string;
  content: string;
  sha256: string;
  sourceEventId: string;
  truncated: boolean;
}

export interface CaptureSummary {
  mode: 'precise';
  coverage: 'high' | 'partial' | 'low';
  rawEventCount: number;
  relevantEventCount: number;
  capturedEventCount: number;
  duplicateCount: number;
  replayDroppedCount: number;
  rollbackCount: number;
  abortedTurnCount: number;
  compactionCount: number;
  truncatedCount: number;
  unhandledEventTypes: string[];
  reasons: string[];
}

export type EvidenceLifecycleState = 'confirmed' | 'rolled_back' | 'aborted';

export interface WorkEvidence {
  id: string;
  workItemKey: string;
  kind: 'request' | 'decision' | 'change' | 'verification' | 'delivery' | 'error';
  status: EvidenceLifecycleState;
  timestamp: string;
  repository?: string;
  workspace: string;
  branch?: string;
  commit?: string;
  files: string[];
  summary: string;
  sourceEventIds: string[];
  confidence: 'confirmed' | 'inferred' | 'unknown';
  verification?: {
    command: string;
    exitCode: number | null;
    outcome: 'passed' | 'failed' | 'unknown';
  };
  codeExcerpts?: VerifiedCodeExcerpt[];
}

export interface WorkFactIndex {
  version: 2;
  date: string;
  timezone: string;
  snapshotId: string;
  asOf: string;
  finalized: boolean;
  finalizedAt?: string;
  finalizationBasis?: 'calendar-day' | 'configured-cutoff';
  quality: CaptureQuality;
  facts: WorkEvidence[];
}

export interface CaptureQuality {
  discoveredFiles: number;
  scannedBytes: number;
  validLines: number;
  invalidLines: number;
  targetOccurrences: number;
  included: number;
  duplicate: number;
  replay: number;
  unsupported: number;
  invalid: number;
  rolledBack: number;
  aborted: number;
  orphanToolOutputs: number;
  unresolvedParents: string[];
  unknownRelevantEventTypes: string[];
  accountingDifference: number;
  coverage: 'high' | 'partial' | 'low';
  reasons: string[];
}

export interface CaptureEventAudit {
  occurrenceId: string;
  semanticFingerprint: string;
  sessionId: string;
  parentSessionId?: string;
  rootSessionId?: string;
  turnId?: string;
  callId?: string;
  timestamp: string;
  kind: string;
  representation: string;
  disposition: 'included' | 'duplicate' | 'replay' | 'unsupported' | 'invalid';
  lifecycle: EvidenceLifecycleState;
  source: {
    file: string;
    byteStart: number;
    byteEnd: number;
    lineSha256: string;
  };
  payloadLength: number;
  payloadSha256: string;
}

export interface CaptureSnapshot {
  id: string;
  date: string;
  timezone: string;
  asOf: string;
  finalized: boolean;
  finalizedAt?: string;
  finalizationBasis?: 'calendar-day' | 'configured-cutoff';
  lateEventCount: number;
  quality: CaptureQuality;
  events: CaptureEventAudit[];
  evidence: WorkEvidence[];
}
