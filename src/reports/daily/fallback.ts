import type { ActivityBatch } from '../../core/contracts/index.js';
import { fallbackDailyDraft, renderDailyReport } from './render.js';

export function buildFallbackDailyReport(batch: ActivityBatch): string {
  if (!batch.dailyView) throw new Error('Daily report fallback requires a WorkItem projection.');
  return renderDailyReport(batch, batch.dailyView, fallbackDailyDraft(batch.dailyView));
}
