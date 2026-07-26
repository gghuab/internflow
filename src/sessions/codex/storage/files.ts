import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseJsonLine } from '../support/json.js';
import { redact } from '../support/privacy.js';

export async function discoverSessionFiles(
  root: string | string[],
  date: string,
): Promise<string[]> {
  const roots = Array.isArray(root) ? root : [root];
  const result = new Map<string, string>();
  for (const current of roots) {
    for (const file of await discoverAllSessionFiles(current, date)) {
      // 归档切换期间同一 rollout 可能短暂存在于两个目录，活动目录优先。
      const key = roots.length > 1 ? basename(file) : file;
      if (!result.has(key)) result.set(key, file);
    }
  }
  return [...result.values()].sort();
}

async function discoverAllSessionFiles(root: string, date: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  }
  // 含目标日期事件的文件，其最后修改时间必然不早于该事件；额外留 24 小时时区余量。
  const earliestMtime = Date.parse(`${date}T00:00:00Z`) - 24 * 60 * 60 * 1000;
  const candidates = await Promise.all(files.map(async (path) => ({ path, value: await stat(path) })));
  return candidates
    .filter((item) => item.value.mtimeMs >= earliestMtime)
    .map((item) => item.path)
    .sort();
}

export async function loadTitleIndex(path: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!existsSync(path)) return result;
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const value = parseJsonLine(line) as { id?: string; thread_name?: string } | null;
    if (value?.id && value.thread_name) result.set(value.id, redact(value.thread_name));
  }
  return result;
}
