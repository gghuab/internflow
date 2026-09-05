import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/core/process.js';

describe('runCommand', () => {
  it('injects credentials into one child process without mutating the parent environment', async () => {
    const variable = 'INTERNFLOW_TEST_CHILD_CREDENTIAL';
    delete process.env[variable];

    const result = await runCommand(process.execPath, [
      '-e',
      `process.stdout.write(process.env.${variable} || '')`,
    ], { env: { [variable]: 'child-only' } });

    expect(result.stdout).toBe('child-only');
    expect(process.env[variable]).toBeUndefined();
  });

  it('preserves the child failure when stdin closes before a large prompt is written', async () => {
    const input = 'x'.repeat(8 * 1024 * 1024);
    const command = runCommand(process.execPath, [
      '-e',
      'process.stderr.write("original failure\\n"); process.exit(7)',
    ], { input });

    await expect(command).rejects.toThrow(/failed \(7\)[\s\S]*original failure/);
  });

  it('reports a timeout and force-kills an unresponsive POSIX process group', async () => {
    const script = `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
        stdio: 'inherit',
      });
      setInterval(() => {}, 1000);
    `;

    const startedAt = Date.now();
    await expect(runCommand(process.execPath, ['-e', script], { timeoutMs: 300 }))
      .rejects.toThrow('timed out after 300ms');

    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
