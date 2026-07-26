import type { ArtifactStore } from '../../persistence/index.js';
import { workItemDailyInput } from '../../../reports/daily/input.js';
import type { JobStrategy } from './types.js';

export function createDailyStrategy(artifacts: ArtifactStore, date: string): JobStrategy {
  return {
    failureTitle: (jobName) => `InternFlow ${jobName} 运行失败`,
    async prepareBatch() {},
    async saveInput(batch) {
      const input = workItemDailyInput(batch);
      if (!input) throw new Error('Daily report requires a WorkItem projection.');
      await artifacts.saveDailyInput(date, input);
    },
    decorateEmptyResult: (result) => result,
    async prepareGeneration(_batch, snapshot) { return snapshot; },
    assertArtifact(artifact) {
      if (artifact.kind !== 'markdown') {
        throw new Error('Daily report generator returned non-Markdown output.');
      }
    },
    async saveGenerated(artifact) {
      if (artifact.kind !== 'markdown') return;
      await artifacts.saveDailyReportDraft(date, artifact.rawMarkdown ?? artifact.markdown);
    },
    async afterSinkApplied() {},
    decorateResult: (result) => result,
    async saveRunResult() {},
    async saveFailure() {},
  };
}
