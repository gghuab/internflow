import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CaptureSnapshot } from '../../../core/contracts/index.js';

export async function loadCaptureSnapshot(path: string): Promise<CaptureSnapshot | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as CaptureSnapshot;
    return value && typeof value.id === 'string' && Array.isArray(value.evidence) ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

export async function saveCaptureSnapshot(path: string, snapshot: CaptureSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
