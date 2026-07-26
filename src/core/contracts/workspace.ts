import type { PeriodEntry, WorkItemStatus } from './workday.js';

export interface WorkspaceCandidate extends PeriodEntry {
  snapshotId: string;
  commits: string[];
  contentFingerprint: string;
}

export interface WorkspaceEntry extends WorkspaceCandidate {
  id: string;
  subjectId: string;
  createdAt: string;
  match: {
    method: 'subject-key' | 'cross-day' | 'new';
    score: number;
  };
}

export interface WorkspaceSubject {
  id: string;
  title: string;
  repositoryKey: string;
  status: WorkItemStatus;
  subjectKeys: string[];
  branches: string[];
  commits: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  evidenceIds: string[];
  entryIds: string[];
  current: {
    goal: string;
    outcomes: string[];
    blockers: string[];
    latestVerification: string | null;
  };
}

export interface WorkspaceState {
  version: 1;
  workspaceId: string;
  revision: number;
  updatedAt: string | null;
  subjects: WorkspaceSubject[];
  entries: WorkspaceEntry[];
}
