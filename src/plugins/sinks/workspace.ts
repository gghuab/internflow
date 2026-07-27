import type { SinkConfig } from '../../core/config.js';
import type {
  OutputArtifact,
  RunContext,
  SinkPlugin,
} from '../../core/contracts/index.js';
import {
  WorkspaceStore,
  writeWorkspaceMarkdownViews,
} from '../../workspaces/index.js';

type WorkspaceConfig = Extract<SinkConfig, { type: 'workspace' }>;

export class WorkspaceSink implements SinkPlugin {
  readonly name = 'workspace' as const;

  async apply(
    context: RunContext,
    config: SinkConfig,
    artifact: OutputArtifact,
  ): Promise<Record<string, unknown>> {
    const workspace = asWorkspaceConfig(config);
    if (artifact.kind !== 'workspace') {
      throw new Error('Workspace sink requires a Workspace artifact.');
    }
    const store = new WorkspaceStore(workspace.id, workspace.directory);
    const result = await store.apply(
      artifact.candidates,
      { dryRun: context.dryRun },
    );
    const views = context.dryRun
      ? {
          indexPath: `${store.directory}/views/index.md`,
          subjectPaths: result.state.subjects.map(
            (subject) => `${store.directory}/views/subjects/${subject.id}.md`,
          ),
        }
      : await writeWorkspaceMarkdownViews(store.directory, result.state);
    return {
      sink: this.name,
      workspaceId: workspace.id,
      path: result.path,
      viewIndexPath: views.indexPath,
      subjectViewCount: views.subjectPaths.length,
      revision: result.state.revision,
      entriesAdded: result.entriesAdded,
      subjectsCreated: result.subjectsCreated,
      subjectsUpdated: result.subjectsUpdated,
      preview: context.dryRun,
      ...(result.entriesAdded ? {} : { skipped: true, reason: 'workspace_already_current' }),
    };
  }

  async doctor(config: SinkConfig): Promise<{ ok: boolean; message: string }> {
    const workspace = asWorkspaceConfig(config);
    const store = new WorkspaceStore(workspace.id, workspace.directory);
    return { ok: true, message: `Workspace state: ${store.path}` };
  }
}

function asWorkspaceConfig(config: SinkConfig): WorkspaceConfig {
  if (config.type !== 'workspace') throw new Error('WorkspaceSink received non-workspace config.');
  return config;
}
