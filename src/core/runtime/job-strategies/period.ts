import type { ArtifactStore } from '../../persistence/index.js';
import { buildPeriodBatch } from '../../../reports/period/index.js';
import type { JobStrategy } from './types.js';

export function createPeriodStrategy(
  unit: 'week' | 'month',
  artifacts: ArtifactStore,
  date: string,
  dryRun = false,
): JobStrategy {
  return {
    failureTitle: (jobName) => `InternFlow ${jobName} 运行失败`,
    async buildBatch({ context, collectDay }) {
      const batch = await buildPeriodBatch({
        unit,
        endDate: context.date,
        timezone: context.timezone,
        skipDates: context.job.skipDates,
        artifacts,
        collectDay,
        // dry-run 可读既有工件并在内存补采，但不写回 v1 迁移或正式 period 视图。
        persist: !dryRun && !context.dryRun,
      });
      if (!dryRun && !context.dryRun && batch.periodView) {
        await artifacts.savePeriodView(unit, date, batch.periodView);
      }
      return batch;
    },
    reportableCount: (batch) => batch.periodView?.groups.length || 0,
    async prepareBatch() {},
    async saveInput(batch) {
      if (dryRun) return;
      if (!batch.periodView) throw new Error('Period report requires a PeriodReportView.');
      await artifacts.savePeriodInput(unit, date, {
        unit,
        startDate: batch.periodView.startDate,
        endDate: batch.periodView.endDate,
        snapshotIds: batch.periodView.snapshotIds,
        groupCount: batch.periodView.groups.length,
        quality: batch.periodView.quality,
        periodViewPath: artifacts.periodViewPath(unit, date),
      });
    },
    decorateEmptyResult: (result) => result,
    async prepareGeneration(_batch, snapshot) { return snapshot; },
    assertArtifact(artifact) {
      if (artifact.kind !== 'markdown') throw new Error('Period report generator returned non-Markdown output.');
    },
    async saveGenerated(artifact) {
      if (dryRun) return;
      if (artifact.kind === 'markdown') {
        await artifacts.savePeriodReportDraft(unit, date, artifact.rawMarkdown ?? artifact.markdown);
      }
    },
    async afterSinkApplied() {},
    decorateResult: (result) => result,
    async saveRunResult() {},
    async saveFailure() {},
  };
}
