import { loadConfig } from '../core/config.js';
import { defaultConfigPath } from '../core/paths.js';
import type { WorkspaceState } from '../core/contracts/index.js';
import { WorkspaceStore } from '../workspaces/index.js';

export interface WorkspaceView {
  jobName: string;
  enabled: boolean;
  schedule: string;
  state: WorkspaceState;
}

export async function getWorkspaceViews(options: {
  configPath?: string;
} = {}): Promise<{ ok: true; workspaces: WorkspaceView[] }> {
  const config = await loadConfig(options.configPath || defaultConfigPath());
  const views: WorkspaceView[] = [];
  for (const [jobName, job] of Object.entries(config.jobs)) {
    if (job.template !== 'workspace') continue;
    const sink = job.sinks.find((candidate) => candidate.type === 'workspace');
    if (!sink || sink.type !== 'workspace') continue;
    views.push({
      jobName,
      enabled: job.enabled,
      schedule: `${job.schedule.days.join(',')} ${job.schedule.time}`,
      state: await new WorkspaceStore(sink.id, sink.directory).read(),
    });
  }
  views.sort((left, right) => left.jobName.localeCompare(right.jobName));
  return { ok: true, workspaces: views };
}
