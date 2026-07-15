import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDirectory } from './paths.js';

const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

export async function acquireRunLock(jobName: string, date: string): Promise<() => Promise<void>> {
  const directory = join(stateDirectory(), 'locks');
  await mkdir(directory, { recursive: true });
  const safeName = jobName.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const path = join(directory, `${safeName}-${date}.lock`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      return async () => {
        await handle.close();
        await rm(path, { force: true });
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const detail = await stat(path).catch(() => null);
      if (detail && Date.now() - detail.mtimeMs > STALE_LOCK_MS && attempt === 0) {
        await rm(path, { force: true });
        continue;
      }
      throw new Error(`Job ${jobName} is already running for ${date}.`);
    }
  }
  throw new Error(`Cannot acquire run lock for ${jobName}.`);
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

