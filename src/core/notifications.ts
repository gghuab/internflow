import { runCommand } from './process.js';

const DISPLAY_NOTIFICATION_SCRIPT = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run`;

export type NotificationRunner = (
  executable: string,
  args: string[],
) => Promise<void>;

export type NotificationResult =
  | { sent: true }
  | { sent: false; reason: 'unsupported_platform' }
  | { sent: false; reason: 'notification_failed'; error: string };

export interface FailureNotificationOptions {
  title?: string;
  maxMessageLength?: number;
  osascriptPath?: string;
  platform?: NodeJS.Platform;
  runner?: NotificationRunner;
}

export async function notifyMacOsFailure(
  message: string,
  options: FailureNotificationOptions = {},
): Promise<NotificationResult> {
  if ((options.platform || process.platform) !== 'darwin') {
    return { sent: false, reason: 'unsupported_platform' };
  }

  const limit = options.maxMessageLength ?? 160;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`maxMessageLength must be a positive integer, received ${limit}.`);
  }

  const title = options.title || 'InternFlow 运行失败';
  const executable = options.osascriptPath || '/usr/bin/osascript';
  const runner = options.runner || defaultNotificationRunner;
  try {
    // 文本通过 argv 传递而不是拼入 AppleScript，避免引号或换行改变脚本语义。
    await runner(executable, [
      '-e',
      DISPLAY_NOTIFICATION_SCRIPT,
      '--',
      title,
      message.slice(0, limit),
    ]);
    return { sent: true };
  } catch (error) {
    // 通知只是失败兜底，绝不能覆盖原始任务错误。
    return {
      sent: false,
      reason: 'notification_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function defaultNotificationRunner(executable: string, args: string[]): Promise<void> {
  await runCommand(executable, args, {
    timeoutMs: 10_000,
    sensitiveOutput: true,
  });
}
