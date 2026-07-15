import type { GeneratorConfig, JobConfig, SinkConfig, SourceConfig } from './config.js';

export interface CommandRecord {
  command: string;
  cwd: string;
  exitCode: number | null;
  output: string;
}

export interface Activity {
  id: string;
  title: string;
  cwd: string;
  gitBranch: string;
  startedAt: string;
  endedAt: string;
  activeMinutes: number | null;
  durationReliable: boolean;
  firstUserMessage: string;
  userMessages: string[];
  assistantMessages: string[];
  changedFiles: string[];
  commands: CommandRecord[];
}

export interface ActivityBatch {
  date: string;
  timezone: string;
  sourceCount: number;
  filteredCount: number;
  activities: Activity[];
}

export interface HeadingReference {
  ref: string;
  blockId: string;
  level: number;
  text: string;
  section: 'requirement' | 'bugfix' | 'insight' | null;
}

export interface SinkSnapshot {
  markdown?: string;
  headings?: HeadingReference[];
  revisionId?: number;
}

export interface AppendRecord {
  section: 'requirement' | 'bugfix' | 'insight';
  targetRef: string;
  markdown: string;
}

export type OutputArtifact =
  | { kind: 'markdown'; markdown: string }
  | { kind: 'records'; records: AppendRecord[] };

export interface RunContext {
  jobName: string;
  job: JobConfig;
  date: string;
  timezone: string;
  dryRun: boolean;
  force: boolean;
  modelOverride?: string;
}

export interface SourcePlugin {
  name: SourceConfig['type'];
  collect(context: RunContext, config: SourceConfig): Promise<ActivityBatch>;
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

export interface RunResult {
  ok: boolean;
  skipped: boolean;
  job: string;
  date: string;
  dryRun: boolean;
  sourceCount: number;
  activityCount: number;
  outputs: Array<Record<string, unknown>>;
}
