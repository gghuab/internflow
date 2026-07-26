import { existsSync } from 'node:fs';
import { createStarterConfig, loadConfig } from '../core/config.js';
import type { DecisionAudit } from '../core/contracts/index.js';
import { validateDecisionAudit } from '../core/decision-audit.js';
import { defaultConfigPath, expandHome } from '../core/paths.js';
import { ArtifactStore } from '../core/persistence/index.js';

export async function getDecisionAudits(options: {
  date: string;
  job?: string;
  policyId?: string;
  outcome?: string;
  configPath?: string;
}): Promise<{ ok: true; date: string; audits: DecisionAudit[] }> {
  const path = expandHome(options.configPath || defaultConfigPath());
  const config = existsSync(path) ? await loadConfig(path) : createStarterConfig();
  const artifacts = new ArtifactStore({
    ...(config.artifacts?.dailyDirectory ? { dailyDirectory: config.artifacts.dailyDirectory } : {}),
    ...(config.artifacts?.devLogDirectory ? { devLogDirectory: config.artifacts.devLogDirectory } : {}),
  });
  const paths = await artifacts.listDecisionAudits(options.date, options.job);
  const audits = await Promise.all(paths.map(async (auditPath) => (
    validateDecisionAudit(await artifacts.readJson(auditPath))
  )));
  return {
    ok: true,
    date: options.date,
    audits: audits.flatMap((audit) => {
      const assessments = audit.assessments.filter((assessment) => (
        (!options.policyId || assessment.policyId === options.policyId)
        && (!options.outcome || assessment.outcome === options.outcome)
      ));
      return assessments.length ? [{ ...audit, assessments }] : [];
    }),
  };
}
