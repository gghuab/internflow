import type { OutputArtifact, SinkSnapshot } from '../contracts/index.js';

export interface SinkRunState {
  status: 'pending' | 'applied';
  startedAt: string;
  appliedAt?: string;
  hash: string;
}

export interface StoredRunArtifact {
  version: 1;
  job: string;
  date: string;
  createdAt: string;
  hash: string;
  sourceCount: number;
  activityCount: number;
  artifact: OutputArtifact;
  snapshots: Record<string, SinkSnapshot>;
  generationSnapshot: SinkSnapshot | null;
}

export interface SaveRunArtifact {
  job: string;
  date: string;
  sourceCount: number;
  activityCount: number;
  artifact: OutputArtifact;
  snapshots: Record<string, SinkSnapshot>;
  generationSnapshot?: SinkSnapshot;
}

export interface StateData {
  version: 1;
  sinks: Record<string, SinkRunState>;
}
