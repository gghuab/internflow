import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStarterConfig, writeConfig } from '../src/core/config.js';
import { buildDecisionAudit, withDecisionId } from '../src/core/decision-audit.js';
import { ArtifactStore } from '../src/core/persistence/index.js';
import { getDecisionAudits } from '../src/web/decision-audits.js';

describe('decision audit web query', () => {
  it('reads configured artifacts and filters by policy and outcome', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-audit-web-'));
    const configPath = join(directory, 'config.yaml');
    const artifactDirectory = join(directory, 'artifacts');
    const config = createStarterConfig();
    config.artifacts = { dailyDirectory: artifactDirectory };
    await writeConfig(config, configPath);
    const store = new ArtifactStore({ dailyDirectory: artifactDirectory });
    const evidence = [{ kind: 'job' as const, id: 'daily-report' }];
    const assessment = withDecisionId({
      kind: 'assessment' as const,
      policyId: 'daily.visual-need', policyVersion: '1.0.0', subject: evidence[0]!,
      outcome: 'flowchart', confidence: 'high' as const, gates: [], signals: [],
      reasons: [{ code: 'daily.visual-need.flowchart', message: '跨模块流程适合画图', evidence }],
      evidence, constraints: [],
    });
    await store.saveDecisionAudit(buildDecisionAudit({
      job: 'daily-report', date: '2026-07-16', timezone: 'Asia/Shanghai',
      inputFingerprint: 'input', assessments: [assessment],
    }));

    const result = await getDecisionAudits({
      date: '2026-07-16', job: 'daily-report', policyId: 'daily.visual-need',
      outcome: 'flowchart', configPath,
    });
    expect(result.audits).toHaveLength(1);
    expect(result.audits[0]?.assessments).toEqual([assessment]);
    expect((await getDecisionAudits({
      date: '2026-07-16', policyId: 'devlog.routing', configPath,
    })).audits).toEqual([]);
  });
});
