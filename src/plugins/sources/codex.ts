import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import type { SourceConfig } from '../../core/config.js';
import { expandHome } from '../../core/paths.js';
import type { Activity, ActivityBatch, CommandRecord, RunContext, SourcePlugin } from '../../core/types.js';

const ACTIVE_GAP_CAP_MS = 15 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 1800;
const MAX_OUTPUT_LENGTH = 900;

interface JsonEvent {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface MutableActivity extends Activity {
  activityTimes: number[];
  changedFileSet: Set<string>;
  commandByCallId: Map<string, number>;
  workspaceRoot: string;
}

const CODE_PATTERN = /(```|\b(?:function|const|class|interface|type|import|export|async|await)\b|\.(?:ts|tsx|js|jsx|json|md|css|scss|py|go|rs|java|sql|yaml|yml)\b)/i;
const DEVELOPMENT_PATTERN = /(开发|代码|组件|页面|接口|服务|构建|调试|错误|逻辑|测试|验证|提交|分支|合并|工作流|脚本|自动化|bug|debug|build|deploy|service|api|component|function|code|project|git|eslint|typescript|node)/i;
const DEVELOPMENT_COMMAND = /\b(?:git|rg|sed|node|npm|pnpm|yarn|tsc|eslint|prettier|jest|vitest|pytest|make|docker)\b/i;

export class CodexSource implements SourcePlugin {
  readonly name = 'codex' as const;

  async collect(context: RunContext, config: SourceConfig): Promise<ActivityBatch> {
    const sessionsDir = expandHome(config.sessionsDir || join(homedir(), '.codex', 'sessions'));
    const indexPath = expandHome(config.sessionIndex || join(homedir(), '.codex', 'session_index.jsonl'));
    const titleIndex = await loadTitleIndex(indexPath);
    const files = await discoverSessionFiles(sessionsDir, context.date);
    const parsed = await Promise.all(files.map((file) => parseSession(file, titleIndex, context, config)));
    const sourceActivities = parsed.filter((item): item is Activity => item !== null);
    const activities = sourceActivities.filter((activity) => isReportable(activity, config));

    return {
      date: context.date,
      timezone: context.timezone,
      sourceCount: sourceActivities.length,
      filteredCount: sourceActivities.length - activities.length,
      activities,
    };
  }
}

async function discoverSessionFiles(root: string, date: string): Promise<string[]> {
  const files = new Set<string>();
  for (const offset of [-1, 0, 1]) {
    const candidateDate = addDays(date, offset);
    const [year, month, day] = candidateDate.split('-');
    if (!year || !month || !day) continue;
    const directory = join(root, year, month, day);
    if (!existsSync(directory)) continue;
    for (const name of await readdir(directory)) {
      if (name.endsWith('.jsonl')) files.add(join(directory, name));
    }
  }
  return [...files].sort();
}

async function loadTitleIndex(path: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!existsSync(path)) return result;
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const value = parseJsonLine(line) as { id?: string; thread_name?: string } | null;
    if (value?.id && value.thread_name) result.set(value.id, redact(value.thread_name));
  }
  return result;
}

async function parseSession(
  file: string,
  titleIndex: Map<string, string>,
  context: RunContext,
  config: SourceConfig,
): Promise<Activity | null> {
  const events = (await readFile(file, 'utf8'))
    .split('\n')
    .map((line) => parseJsonLine(line) as JsonEvent | null)
    .filter((event): event is JsonEvent => event !== null)
    .filter((event) => event.timestamp && localDate(event.timestamp, context.timezone) === context.date);

  if (!events.length) return null;
  const firstTime = Date.parse(events[0]?.timestamp || '');
  const replayBurst = detectReplayBurst(events, firstTime);
  const activity: MutableActivity = {
    id: '',
    title: '',
    cwd: '',
    gitBranch: '',
    startedAt: events[0]?.timestamp || '',
    endedAt: events.at(-1)?.timestamp || '',
    activeMinutes: null,
    durationReliable: !replayBurst,
    firstUserMessage: '',
    userMessages: [],
    assistantMessages: [],
    changedFiles: [],
    commands: [],
    activityTimes: [],
    changedFileSet: new Set<string>(),
    commandByCallId: new Map<string, number>(),
    workspaceRoot: '',
  };

  for (const event of events) {
    if (replayBurst && eventTime(event) <= firstTime + 1000) continue;
    collectEvent(event, activity, file, config);
  }

  activity.id ||= inferSessionId(file);
  activity.title ||= titleIndex.get(activity.id) || inferTitle(activity);
  activity.userMessages = unique(activity.userMessages).slice(0, 8);
  activity.assistantMessages = unique(activity.assistantMessages).slice(-5);
  activity.commands = uniqueCommands(activity.commands).slice(-16);
  activity.changedFiles = [...activity.changedFileSet].slice(0, 24);
  activity.firstUserMessage = activity.userMessages[0] || '';
  activity.activeMinutes = activity.durationReliable ? activeMinutes(activity.activityTimes) : null;

  const {
    activityTimes: _times,
    changedFileSet: _files,
    commandByCallId: _calls,
    workspaceRoot: _workspace,
    ...result
  } = activity;
  return result.userMessages.length || result.commands.length || result.changedFiles.length ? result : null;
}

function collectEvent(
  event: JsonEvent,
  activity: MutableActivity,
  file: string,
  config: SourceConfig,
): void {
  const payload = event.payload || {};
  const timestamp = eventTime(event);

  if (event.type === 'session_meta') {
    activity.id = stringValue(payload.id) || activity.id;
    activity.workspaceRoot = stringValue(payload.cwd) || activity.workspaceRoot;
    activity.cwd = normalizeHomePath(activity.workspaceRoot) || activity.cwd;
    const git = isRecord(payload.git) ? payload.git : {};
    activity.gitBranch = stringValue(git.branch) || activity.gitBranch;
    return;
  }

  if (event.type === 'response_item' && payload.type === 'message') {
    const text = truncate(redact(textFromContent(payload.content)), MAX_MESSAGE_LENGTH);
    if (!text || isInjectedContext(text)) return;
    if (payload.role === 'user') activity.userMessages.push(text);
    if (payload.role === 'assistant' && config.includeAssistantMessages === true) {
      activity.assistantMessages.push(text);
    }
    activity.activityTimes.push(timestamp);
    return;
  }

  if (event.type === 'event_msg' && payload.type === 'user_message') {
    const text = truncate(redact(stringValue(payload.message)), MAX_MESSAGE_LENGTH);
    if (!text || isInjectedContext(text)) return;
    activity.userMessages.push(text);
    activity.activityTimes.push(timestamp);
    return;
  }

  if (event.type === 'response_item' && payload.type === 'function_call') {
    const command = parseLegacyCommand(payload);
    if (command) {
      activity.commands.push(command);
      activity.activityTimes.push(timestamp);
    }
    return;
  }

  if (event.type === 'response_item' && payload.type === 'custom_tool_call') {
    const callId = stringValue(payload.call_id);
    const command: CommandRecord = {
      command: stringValue(payload.name) || 'custom_tool_call',
      cwd: activity.cwd,
      exitCode: null,
      output: '',
    };
    activity.commands.push(command);
    if (callId) activity.commandByCallId.set(callId, activity.commands.length - 1);
    activity.activityTimes.push(timestamp);
    return;
  }

  if (event.type === 'response_item' && payload.type === 'custom_tool_call_output') {
    const index = activity.commandByCallId.get(stringValue(payload.call_id));
    const command = index === undefined ? undefined : activity.commands[index];
    if (command && config.includeToolOutput === true) {
      command.output = truncate(redact(stringValue(payload.output)), MAX_OUTPUT_LENGTH);
    }
    activity.activityTimes.push(timestamp);
    return;
  }

  if (event.type === 'event_msg' && payload.type === 'exec_command_end') {
    const output = truncate(
      redact(stringValue(payload.aggregated_output || payload.stdout || payload.stderr)),
      MAX_OUTPUT_LENGTH,
    );
    activity.commands.push({
      command: redact(Array.isArray(payload.command) ? payload.command.join(' ') : stringValue(payload.command)),
      cwd: normalizeHomePath(stringValue(payload.cwd)) || activity.cwd,
      exitCode: numberValue(payload.exit_code),
      output: config.includeToolOutput === true ? output : '',
    });
    collectChangedFiles(output, activity.changedFileSet, activity.workspaceRoot);
    activity.activityTimes.push(timestamp);
    return;
  }

  if (event.type === 'event_msg' && payload.type === 'patch_apply_end') {
    const changes = isRecord(payload.changes) ? payload.changes : {};
    for (const path of Object.keys(changes)) {
      activity.changedFileSet.add(relativeToWorkspace(path, activity.workspaceRoot));
    }
    activity.activityTimes.push(timestamp);
  }

  if (!activity.id) activity.id = inferSessionId(file);
}

function isReportable(activity: Activity, config: SourceConfig): boolean {
  const text = [
    activity.title,
    activity.cwd,
    activity.firstUserMessage,
    ...activity.userMessages,
    ...activity.changedFiles,
    ...activity.commands.map((command) => command.command),
  ].join('\n');

  const exclude = compilePatterns(config.exclude || []);
  if (exclude.some((pattern) => pattern.test(text))) return false;
  const include = compilePatterns(config.include || []);
  if (include.length) return include.some((pattern) => pattern.test(text));

  const hasCode = CODE_PATTERN.test(text) || activity.changedFiles.length > 0;
  const hasDevelopment = DEVELOPMENT_PATTERN.test(text);
  const hasCommand = activity.commands.some((command) => DEVELOPMENT_COMMAND.test(command.command));
  return (hasCode && hasDevelopment) || activity.changedFiles.length > 0 || (hasDevelopment && hasCommand);
}

function detectReplayBurst(events: JsonEvent[], firstTime: number): boolean {
  if (!Number.isFinite(firstTime)) return false;
  let userMessages = 0;
  let toolCalls = 0;
  for (const event of events) {
    if (eventTime(event) - firstTime > 1000) break;
    const payload = event.payload || {};
    if (
      (event.type === 'event_msg' && payload.type === 'user_message') ||
      (event.type === 'response_item' && payload.type === 'message' && payload.role === 'user')
    ) userMessages += 1;
    if (event.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(String(payload.type))) {
      toolCalls += 1;
    }
  }
  return userMessages > 5 || toolCalls > 30;
}

function activeMinutes(times: number[]): number | null {
  const sorted = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b);
  if (sorted.length < 2) return null;
  let total = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    total += Math.min((sorted[index] ?? 0) - (sorted[index - 1] ?? 0), ACTIVE_GAP_CAP_MS);
  }
  return Math.max(1, Math.round(total / 60000));
}

function parseLegacyCommand(payload: Record<string, unknown>): CommandRecord | null {
  if (payload.name !== 'exec_command') return null;
  try {
    const args = JSON.parse(stringValue(payload.arguments)) as Record<string, unknown>;
    return {
      command: redact(stringValue(args.cmd)),
      cwd: normalizeHomePath(stringValue(args.workdir)),
      exitCode: null,
      output: '',
    };
  } catch {
    return null;
  }
}

function collectChangedFiles(output: string, files: Set<string>, cwd: string): void {
  for (const match of output.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    if (match[2]) files.add(relativeToWorkspace(match[2], cwd));
  }
  for (const match of output.matchAll(/^([ MADRCU?]{1,2})\s+(.+)$/gm)) {
    if (match[2]) files.add(relativeToWorkspace(match[2].trim(), cwd));
  }
}

function relativeToWorkspace(path: string, cwd: string): string {
  if (!cwd || !path.startsWith('/')) return path;
  const value = relative(cwd, path);
  return value.startsWith('..') ? normalizeHomePath(path) : value;
}

function localDate(timestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function addDays(date: string, offset: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => isRecord(item) ? stringValue(item.text || item.content || (isRecord(item.input_text) ? item.input_text.text : '')) : '')
    .filter(Boolean)
    .join('\n');
}

function isInjectedContext(text: string): boolean {
  const value = text.trim();
  return value.startsWith('# AGENTS.md instructions') ||
    value.startsWith('<environment_context>') ||
    value.startsWith('<INSTRUCTIONS>') ||
    value.startsWith('<skill>') ||
    value.startsWith('<turn_aborted>');
}

function redact(value: string): string {
  return value
    .replace(
      /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gi,
      '-----BEGIN $1-----\n[REDACTED]\n-----END $1-----',
    )
    .replace(/(^|\r?\n)([ \t]*(?:set-)?cookie[ \t]*:[ \t]*)[^\r\n]*/gim, '$1$2[REDACTED]')
    .replace(
      /(^|\r?\n)([ \t]*authorization[ \t]*:[ \t]*)(?:Bearer|Basic)\s+[^\r\n]+/gim,
      '$1$2[REDACTED]',
    )
    .replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi,
      '$1[REDACTED]:[REDACTED]@',
    )
    .replace(
      /(["'](?:[A-Za-z0-9_.-]*(?:token|secret|password|api[_-]?key|access[_-]?key|private[_-]?key)|authorization|cookie|passphrase|signature)["']\s*:\s*)(["'])(?:\\.|(?!\2)[^\\\r\n])*\2/gi,
      '$1$2[REDACTED]$2',
    )
    .replace(
      /([?&](?:access[_-]?token|refresh[_-]?token|api[_-]?key|token|key|secret|password|signature)=)[^&#\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(
      /\b([A-Z][A-Z0-9_]*_(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY))\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/g,
      '$1=[REDACTED]',
    )
    .replace(
      /\b(token|secret|password|cookie|api[_-]?key|authorization)\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi,
      '[REDACTED]',
    );
}

function normalizeHomePath(value: string): string {
  const home = homedir();
  return value === home ? '~' : value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\u001b\[[0-9;]*m/g, '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}\n...[truncated]`;
}

function inferTitle(activity: MutableActivity): string {
  return (activity.userMessages[0] || activity.commands[0]?.command || 'Codex session')
    .split('\n')[0]
    ?.replace(/^#+\s*/, '')
    .slice(0, 60) || 'Codex session';
}

function inferSessionId(file: string): string {
  return basename(file, '.jsonl').replace(/^rollout-[^-]+-[^-]+-/, '') || basename(file);
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, 'i');
    } catch (error) {
      throw new Error(`Invalid source filter pattern ${JSON.stringify(pattern)}: ${String(error)}`);
    }
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueCommands(commands: CommandRecord[]): CommandRecord[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = `${command.command}\n${command.cwd}`;
    if (!key.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseJsonLine(line: string): unknown | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function eventTime(event: JsonEvent): number {
  const value = Date.parse(event.timestamp || '');
  return Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
