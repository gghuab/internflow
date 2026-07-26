import type { GeneratorConfig } from '../../core/config.js';
import type {
  ActivityBatch,
  GeneratorPlugin,
  OutputArtifact,
  RunContext,
} from '../../core/contracts/index.js';
import { buildWorkspaceCandidates } from '../../workspaces/index.js';

export class LocalGenerator implements GeneratorPlugin {
  readonly name = 'local' as const;

  async generate(
    context: RunContext,
    config: GeneratorConfig,
    batch: ActivityBatch,
  ): Promise<OutputArtifact> {
    if (config.type !== 'local') throw new Error('LocalGenerator received non-local config.');
    if (context.job.template !== 'workspace') {
      throw new Error(`Local generator does not support template: ${context.job.template}`);
    }
    return {
      kind: 'workspace',
      candidates: buildWorkspaceCandidates(batch),
    };
  }
}
