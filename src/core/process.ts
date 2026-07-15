import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

export interface RunCommandOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  inheritStdio?: boolean;
  sensitiveOutput?: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const TERMINATE_GRACE_MS = 250;
const FORCE_KILL_GRACE_MS = 250;

export async function runCommand(
  executable: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: options.inheritStdio ? 'inherit' : 'pipe',
      // POSIX 上创建独立进程组，超时时可同时终止命令派生出的子进程。
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let hardStopTimer: NodeJS.Timeout | undefined;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (hardStopTimer) clearTimeout(hardStopTimer);
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };

    const resolveOnce = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };

    const signalProcess = (signal: NodeJS.Signals) => {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // 进程可能在建组前退出，继续尝试终止直接子进程。
        }
      }
      try {
        child.kill(signal);
      } catch {
        // close/error 事件或最终兜底计时器会完成 Promise。
      }
    };

    const timeoutError = () => {
      const command = options.sensitiveOutput ? executable : `${executable} ${args.join(' ')}`;
      return new Error(`${command} timed out after ${options.timeoutMs}ms`);
    };

    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        signalProcess('SIGTERM');
        forceKillTimer = setTimeout(() => {
          signalProcess('SIGKILL');
          hardStopTimer = setTimeout(() => {
            child.stdin?.destroy();
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
            rejectOnce(timeoutError());
          }, FORCE_KILL_GRACE_MS);
        }, TERMINATE_GRACE_MS);
      }, options.timeoutMs);
    }

    child.on('error', (error) => rejectOnce(error));
    child.on('close', (code) => {
      if (timedOut) {
        rejectOnce(timeoutError());
        return;
      }
      const result = { stdout, stderr, exitCode: code ?? 1 };
      if (result.exitCode !== 0) {
        const detail = options.sensitiveOutput ? '' : `\n${stderr || stdout}`;
        const command = options.sensitiveOutput ? executable : `${executable} ${args.join(' ')}`;
        rejectOnce(new Error(`${command} failed (${result.exitCode})${detail}`));
        return;
      }
      resolveOnce(result);
    });

    if (!options.inheritStdio) {
      if (options.input !== undefined) child.stdin?.end(options.input);
      else child.stdin?.end();
    }
  });
}

export async function resolveExecutable(name: string, configured?: string): Promise<string | null> {
  const requested = configured || name;
  const expanded = requested === '~'
    ? homedir()
    : requested.startsWith('~/')
      ? join(homedir(), requested.slice(2))
      : requested;
  const candidates = requested.includes('/')
    ? [expanded]
    : [
        ...String(process.env.PATH || '').split(delimiter).map((part) => join(part, requested)),
        join(homedir(), '.local', 'bin', requested),
        join(homedir(), '.local', 'node-v24', 'bin', requested),
        `/usr/local/bin/${requested}`,
        `/opt/homebrew/bin/${requested}`,
      ];

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 继续尝试下一个候选路径。
    }
  }
  return null;
}

export function executableDirectory(executable: string): string {
  return dirname(executable);
}
