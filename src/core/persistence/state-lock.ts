import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const INVALID_LOCK_STALE_MS = 30_000;

export async function acquireStateLock(statePath: string): Promise<() => Promise<void>> {
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
