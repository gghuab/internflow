import type { JobConfig } from '../../config.js';
import type { ArtifactStore, StateStore } from '../../persistence/index.js';
import { createDailyStrategy } from './daily.js';
import { createDevLogStrategy } from './dev-log.js';
import { createPeriodStrategy } from './period.js';
import type { JobStrategy } from './types.js';

export function createJobStrategy(
  template: JobConfig['template'],
  options: {
    artifacts: ArtifactStore;
    state: StateStore;
    date: string;
    dryRun: boolean;
    model?: string;
    generatorType: string;
    generatorModel: string | null;
  },
): JobStrategy {
  const factories: Record<JobConfig['template'], () => JobStrategy> = {
    'daily-report': () => createDailyStrategy(options.artifacts, options.date),
    'weekly-report': () => createPeriodStrategy('week', options.artifacts, options.date, options.dryRun),
    'monthly-report': () => createPeriodStrategy('month', options.artifacts, options.date, options.dryRun),
    'dev-log': () => createDevLogStrategy(options),
  };
  return factories[template]();
}
