import type { JsonEvent } from '../projection/types.js';
import type { CaptureQuality, CaptureSnapshot, EvidenceLifecycleState, WorkEvidence } from '../../../core/contracts/index.js';

export type { CaptureQuality, CaptureSnapshot, WorkEvidence } from '../../../core/contracts/index.js';

export type EventDisposition = 'included' | 'duplicate' | 'replay' | 'unsupported' | 'invalid';
export type LifecycleState = EvidenceLifecycleState;

export interface SourceRef {
  file: string;
  byteStart: number;
  byteEnd: number;
  lineSha256: string;
}

export interface ReadJsonlRecord {
  event: JsonEvent;
  source: SourceRef;
}

export interface InvalidJsonlRecord {
  source: SourceRef;
  reason: 'invalid_json' | 'invalid_utf8' | 'invalid_shape' | 'incomplete_trailing_line';
}

export interface ReadJsonlResult {
  file: string;
  bytesRead: number;
  records: ReadJsonlRecord[];
  invalid: InvalidJsonlRecord[];
}

export interface NormalizedCodexEvent {
  occurrenceId: string;
  semanticFingerprint: string;
  sessionId: string;
  parentSessionId?: string;
  rootSessionId?: string;
  turnId?: string;
  callId?: string;
  timestamp: string;
  localDate: string;
  kind: string;
  representation: string;
  disposition: EventDisposition;
  lifecycle: LifecycleState;
  source: SourceRef;
  payloadPreview: string;
  payloadLength: number;
  payloadSha256: string;
  raw: JsonEvent;
}

export interface RuntimeCapture {
  snapshot: CaptureSnapshot;
  events: NormalizedCodexEvent[];
  recordsByFile: Map<string, ReadJsonlRecord[]>;
}
