import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stateDirectory } from './paths.js';

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const INVALID_LOCK_STALE_MS = 30_000;

interface SinkRunState {
  status: 'pending' | 'applied';
  startedAt: string;
  appliedAt?: string;
  hash: string;
}

interface StateData {
  version: 1;
  sinks: Record<string, SinkRunState>;
}

export class StateStore {
  readonly path: string;

  constructor(path = join(stateDirectory(), 'state.json')) {
    this.path = path;
  }

  async status(key: string): Promise<SinkRunState['status'] | null> {
    const state = await this.read();
    return state.sinks[key]?.status || null;
  }

  async begin(key: string, hash: string, force = false): Promise<void> {
    await this.update(async (state) => {
      const current = state.sinks[key];
      // 已确认写入的记录永远不能通过 --force 重置，避免重复写入目标端。
      if (current?.status === 'applied') return false;
      if (current?.status === 'pending' && !force) {
        throw new Error(
          `Sink ${key} has an uncertain previous write. Inspect the destination, then rerun with --force only when safe.`,
        );
      }
      state.sinks[key] = {
        status: 'pending',
        startedAt: new Date().toISOString(),
        hash,
      };
      return true;
    });
  }

  async complete(key: string, hash: string): Promise<void> {
    await this.update(async (state) => {
      const current = state.sinks[key];
      state.sinks[key] = {
        status: 'applied',
        startedAt: current?.startedAt || new Date().toISOString(),
        appliedAt: new Date().toISOString(),
        hash,
      };
      return true;
    });
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
}

async function acquireStateLock(statePath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        );
      } catch (error) {
        await handle.close();
        await rm(lockPath, { force: true });
        throw error;
      }
      return async () => {
        try {
          await handle.close();
        } finally {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
      await removeAbandonedLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for InternFlow state lock ${lockPath}.`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function removeAbandonedLock(lockPath: string): Promise<void> {
  // 串行清理可避免多个等待者误删刚被其他进程获取的新锁。
  const cleanupPath = `${lockPath}.cleanup`;
  let cleanupHandle;
  try {
    cleanupHandle = await open(cleanupPath, 'wx', 0o600);
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) return;
    throw error;
  }

  try {
    const [content, detail] = await Promise.all([
      readFile(lockPath, 'utf8').catch(() => ''),
      stat(lockPath).catch(() => null),
    ]);
    if (!detail) return;

    const pid = parseLockPid(content);
    if (pid !== null) {
      if (!isProcessAlive(pid)) await rm(lockPath, { force: true });
      return;
    }
    if (Date.now() - detail.mtimeMs > INVALID_LOCK_STALE_MS) {
      await rm(lockPath, { force: true });
    }
  } finally {
    try {
      await cleanupHandle.close();
    } finally {
      await rm(cleanupPath, { force: true });
    }
  }
}

function parseLockPid(content: string): number | null {
  try {
    const value = JSON.parse(content) as { pid?: unknown };
    return Number.isInteger(value.pid) && Number(value.pid) > 0 ? Number(value.pid) : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, 'ESRCH');
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
