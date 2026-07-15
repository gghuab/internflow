import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/core/state.js';

const execFileAsync = promisify(execFile);

describe('StateStore', () => {
  it('blocks automatic retries while a previous sink write is uncertain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-state-'));
    const store = new StateStore(join(directory, 'state.json'));

    expect(await store.status('job:date:sink')).toBeNull();
    await store.begin('job:date:sink', 'hash-1');
    expect(await store.status('job:date:sink')).toBe('pending');
    await expect(store.begin('job:date:sink', 'hash-1')).rejects.toThrow(
      'has an uncertain previous write',
    );

    await store.complete('job:date:sink', 'hash-1');
    expect(await store.status('job:date:sink')).toBe('applied');
  });

  it('allows force to retry pending state but never resets applied state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-state-force-'));
    const path = join(directory, 'state.json');
    const store = new StateStore(path);

    await store.begin('job:date:sink', 'hash-1');
    await store.begin('job:date:sink', 'hash-2', true);
    let state = JSON.parse(await readFile(path, 'utf8'));
    expect(state.sinks['job:date:sink']).toMatchObject({ status: 'pending', hash: 'hash-2' });

    await store.complete('job:date:sink', 'hash-2');
    await store.begin('job:date:sink', 'hash-3', true);
    state = JSON.parse(await readFile(path, 'utf8'));
    expect(state.sinks['job:date:sink']).toMatchObject({ status: 'applied', hash: 'hash-2' });
  });

  it('serializes read-modify-write updates from separate processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'internflow-state-concurrent-'));
    const path = join(directory, 'state.json');
    const gate = join(directory, 'start');
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/core/state.ts')).href;
    const workers = Array.from({ length: 8 }, (_, index) => {
      const ready = join(directory, `ready-${index}`);
      const script = `
        import { existsSync } from 'node:fs';
        import { writeFile } from 'node:fs/promises';
        import { setTimeout as delay } from 'node:timers/promises';
        import { StateStore } from ${JSON.stringify(moduleUrl)};
        await writeFile(${JSON.stringify(ready)}, '');
        while (!existsSync(${JSON.stringify(gate)})) await delay(5);
        await new StateStore(${JSON.stringify(path)}).begin(${JSON.stringify(`key-${index}`)}, ${JSON.stringify(`hash-${index}`)});
      `;
      return {
        ready,
        done: execFileAsync(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '--eval', script],
          { cwd: process.cwd(), timeout: 15_000 },
        ),
      };
    });

    await Promise.all(workers.map(({ ready }) => waitForFile(ready)));
    await writeFile(gate, '');
    await Promise.all(workers.map(({ done }) => done));

    const state = JSON.parse(await readFile(path, 'utf8'));
    expect(Object.keys(state.sinks).sort()).toEqual(
      Array.from({ length: workers.length }, (_, index) => `key-${index}`).sort(),
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.lock`)).toBe(false);
  }, 20_000);
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
