import type { GeneratorConfig, SinkConfig, SourceConfig } from '../config.js';
import type { ActivityBatch, ActivitySourceBatch } from './activity.js';
import type { RunContext } from './run.js';
import type {
  DevLogSection,
  DevLogTargetRole,
  DevLogWriteOperation,
} from './workday.js';

export interface HeadingReference {
  ref: string;
  blockId: string;
  level: number;
  text: string;
  section: DevLogSection | null;
}

export interface SinkSnapshot {
  markdown?: string;
  headings?: HeadingReference[];
  revisionId?: number;
}

export interface AppendRecord {
  section: DevLogSection;
  targetRef: string;
  markdown: string;
  operation?: DevLogWriteOperation;
  role?: DevLogTargetRole;
  evidenceIds?: string[];
  candidateId?: string;
  candidateIds?: string[];
  subjectKey?: string;
  subjectHeading?: string;
  bindSubject?: boolean;
  contentFingerprint?: string;
}

export type OutputArtifact =
  | { kind: 'markdown'; markdown: string; rawMarkdown?: string }
  | { kind: 'records'; records: AppendRecord[] };

export interface SourcePlugin {
  name: SourceConfig['type'];
  collect(context: RunContext, config: SourceConfig): Promise<ActivitySourceBatch>;
}

export interface GeneratorPlugin {
  name: GeneratorConfig['type'];
  generate(
    context: RunContext,
    config: GeneratorConfig,
    batch: ActivityBatch,
    snapshot?: SinkSnapshot,
  ): Promise<OutputArtifact>;
}

export interface SinkPlugin {
  name: SinkConfig['type'];
  inspect?(context: RunContext, config: SinkConfig): Promise<SinkSnapshot>;
  apply(
    context: RunContext,
    config: SinkConfig,
    artifact: OutputArtifact,
    snapshot?: SinkSnapshot,
  ): Promise<Record<string, unknown>>;
  doctor(config: SinkConfig): Promise<{ ok: boolean; message: string }>;
}
