import type { CommandRecord } from '../../../core/contracts/index.js';

export interface JsonEvent {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export interface ReplayBurst {
  start: number;
  end: number;
}

export interface ParsedSession {
  file: string;
  id: string;
  title: string;
  cwd: string;
  gitBranch: string;
  gitSha: string;
  startedAt: string;
  endedAt: string;
  userMessages: string[];
  assistantMessages: string[];
  commands: CommandRecord[];
  changedFiles: Set<string>;
  errors: string[];
  activityTimestamps: string[];
  hadReplayBurst: boolean;
  commandByCallId: Map<string, number>;
  parentSessionId: string;
  rootSessionId: string;
  previousUserMessage: string;
  previousAssistantMessage: string;
  messageSeenAt: Map<string, number>;
  turnCheckpoints: TurnCheckpoint[];
  capture: CaptureMetrics;
}

export interface TurnCheckpoint {
  userMessageCount: number;
  assistantMessageCount: number;
  commandCount: number;
  errorCount: number;
  timestampCount: number;
  changedFiles: Set<string>;
  messageSeenAt: Map<string, number>;
  commandByCallId: Map<string, number>;
}

export interface CaptureMetrics {
  mode: 'precise';
  rawEventCount: number;
  relevantEventCount: number;
  capturedEventCount: number;
  duplicateCount: number;
  replayDroppedCount: number;
  rollbackCount: number;
  abortedTurnCount: number;
  compactionCount: number;
  truncatedCount: number;
  unhandledEventTypes: Set<string>;
  reasons: Set<string>;
}
