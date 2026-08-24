import { describe, expect, it, vi } from 'vitest';
import { notifyMacOsFailure } from '../src/core/notifications.js';

describe('notifyMacOsFailure', () => {
  it('does nothing outside macOS', async () => {
    const runner = vi.fn(async () => {});

    await expect(notifyMacOsFailure('failed', { platform: 'linux', runner })).resolves.toEqual({
      sent: false,
      reason: 'unsupported_platform',
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('passes untrusted text through argv and preserves the legacy 160-character limit', async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const runner = async (executable: string, args: string[]) => {
      calls.push({ executable, args });
    };
    const message = `failure "quoted"\n${'x'.repeat(200)}`;

    await expect(notifyMacOsFailure(message, {
      platform: 'darwin',
      title: 'Codex 需求开发记录同步失败',
      runner,
    })).resolves.toEqual({ sent: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe('/usr/bin/osascript');
    expect(calls[0]?.args.slice(-3, -2)).toEqual(['--']);
    expect(calls[0]?.args.at(-2)).toBe('Codex 需求开发记录同步失败');
    expect(calls[0]?.args.at(-1)).toBe(message.slice(0, 160));
  });

  it('reports notification failure without throwing over the original job error', async () => {
    const runner = async () => {
      throw new Error('osascript unavailable');
    };

    await expect(notifyMacOsFailure('original failure', {
      platform: 'darwin',
      runner,
    })).resolves.toEqual({
      sent: false,
      reason: 'notification_failed',
      error: 'osascript unavailable',
    });
  });
});
