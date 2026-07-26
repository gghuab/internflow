import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stateDirectory } from '../paths.js';
import { acquireStateLock } from './state-lock.js';
import type { SaveRunArtifact, SinkRunState, StateData, StoredRunArtifact } from './state-types.js';
import { artifactHash, parseStoredArtifact, validateRunIdentity } from './state-validation.js';

export class StateStore {
  readonly path: string;
  readonly runsPath: string;

  constructor(path = join(stateDirectory(), 'state.json')) {
    this.path = path;
    this.runsPath = join(dirname(path), 'runs');
  }

  async status(key: string): Promise<SinkRunState['status'] | null> {
    return (await this.sink(key))?.status || null;
  }

  async sink(key: string): Promise<SinkRunState | null> {
    const state = await this.read();
    return state.sinks[key] || null;
  }

  async begin(key: string, hash: string, force = false): Promise<'started' | 'applied'> {
    let result: 'started' | 'applied' = 'started';
    await this.update(async (state) => {
      const current = state.sinks[key];
      if (current) {
        // 已确认写入的记录永远不能通过 --force 重置，避免重复写入目标端。
        if (current.status === 'applied') {
          result = 'applied';
          return false;
        }
        if (current.hash !== hash) {
          throw new Error(
            `Sink ${key} belongs to artifact ${current.hash}, not ${hash}. Refusing to mix run artifacts.`,
          );
        }
        if (!force) {
          throw new Error(
            `Sink ${key} has an uncertain previous write. Inspect the destination, then rerun with --force only when safe.`,
          );
        }
      }
      state.sinks[key] = {
        status: 'pending',
        startedAt: new Date().toISOString(),
        hash,
      };
      return true;
    });
    return result;
  }

  async complete(key: string, hash: string): Promise<void> {
    await this.update(async (state) => {
      const current = state.sinks[key];
      if (!current) throw new Error(`Cannot complete sink ${key} before beginning its write.`);
      if (current.hash !== hash) {
        throw new Error(
          `Sink ${key} belongs to artifact ${current.hash}, not ${hash}. Refusing to complete it.`,
        );
      }
      if (current.status === 'applied') return false;
      state.sinks[key] = {
        status: 'applied',
        startedAt: current.startedAt,
        appliedAt: new Date().toISOString(),
        hash,
      };
      return true;
    });
  }

  async artifact(job: string, date: string): Promise<StoredRunArtifact | null> {
    const path = this.artifactPath(job, date);
    try {
      return parseStoredArtifact(await readFile(path, 'utf8'), path, job, date);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null;
      if (error instanceof Error && error.message.startsWith('Invalid InternFlow artifact')) throw error;
      throw new Error(`Cannot read InternFlow artifact ${path}: ${String(error)}`);
    }
  }

  async saveArtifact(input: SaveRunArtifact): Promise<StoredRunArtifact> {
    validateRunIdentity(input.job, input.date);
    const path = this.artifactPath(input.job, input.date);
    const stored: StoredRunArtifact = {
      version: 1,
      job: input.job,
      date: input.date,
      createdAt: new Date().toISOString(),
      hash: artifactHash(input.artifact),
      sourceCount: input.sourceCount,
      activityCount: input.activityCount,
      artifact: input.artifact,
      snapshots: input.snapshots,
      generationSnapshot: input.generationSnapshot || null,
    };

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      try {
        // hard-link 原子创建且不会覆盖既有产物，保证一次运行只能绑定一份内容。
        await link(temporary, path);
        return stored;
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
        const existing = await this.artifact(input.job, input.date);
        if (!existing) throw new Error(`InternFlow artifact disappeared while saving ${path}.`);
        if (existing.hash !== stored.hash) {
          throw new Error(
            `Run ${input.job}:${input.date} already has immutable artifact ${existing.hash}; refusing ${stored.hash}.`,
          );
        }
        return existing;
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async read(): Promise<StateData> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StateData>;
      return { version: 1, sinks: value.sinks || {} };
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return { version: 1, sinks: {} };
      throw new Error(`Cannot read InternFlow state ${this.path}: ${String(error)}`);
    }
  }

  private async update(mutator: (state: StateData) => Promise<boolean>): Promise<void> {
    const release = await acquireStateLock(this.path);
    try {
      const state = await this.read();
      if (await mutator(state)) await this.write(state);
    } finally {
      await release();
    }
  }

  private async write(state: StateData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private artifactPath(job: string, date: string): string {
    validateRunIdentity(job, date);
    return join(this.runsPath, job, date, 'artifact.json');
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
