import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/core/process.js';

describe('runCommand', () => {
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

