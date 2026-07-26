import { basename, relative } from 'node:path';
import type { SourceConfig } from '../../../core/config.js';
import type { Activity, CommandRecord, RunContext } from '../../../core/contracts/index.js';
import { clipSessionToDate } from './activity.js';
import { isRecord, numberValue, stringValue, textFromContent } from '../support/json.js';
import { isInjectedContext, redact, truncate, userAuthoredMessage } from '../support/privacy.js';
import {
  collectActivityTimestamp,
  detectReplayBursts,
  isReplayBurstEvent,
  isTargetDateEvent,
  localDate,
} from '../support/time.js';
import type { CaptureMetrics, JsonEvent, ParsedSession, TurnCheckpoint } from './types.js';

const PRECISE_TEXT_LIMIT = 20_000;
const MESSAGE_DUPLICATE_WINDOW_MS = 2000;

export function parseSessionEvents(
  file: string,
  events: JsonEvent[],
  titleIndex: Map<string, string>,
  context: RunContext,
  config: SourceConfig,
): Activity | null {
  const replayBursts = detectReplayBursts(events, context.date, context.timezone);
  const includeAssistantMessages = config.includeAssistantMessages ?? true;
  const includeToolOutput = config.includeToolOutput ?? true;
  const session = createParsedSession(file, replayBursts.length > 0);

  for (const event of events) {
    updateSessionBounds(session, event);
    const payload = event.payload || {};
    const eventDate = event.timestamp ? localDate(event.timestamp, context.timezone) : '';

    if (event.type === 'session_meta' && eventDate <= context.date) {
      applySessionMetadata(session, payload, titleIndex);
    }
    if (eventDate && eventDate < context.date) {
      capturePreviousContext(session, event, payload);
    }
    if (!isTargetDateEvent(event, context.date, context.timezone)) continue;

    session.capture.rawEventCount += 1;
    const relevant = isRelevantEvent(event, payload);
    if (relevant) session.capture.relevantEventCount += 1;

    if (applyLifecycleEvent(session, event, payload)) continue;
    if (shouldDropReplayEvent(event, payload, replayBursts)) {
      if (relevant) session.capture.replayDroppedCount += 1;
      continue;
    }

    if (event.type === 'response_item' && payload.type === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const rawMessage = redact(textFromContent(payload.content));
      const message = captureText(session, role === 'user' ? userAuthoredMessage(rawMessage) : rawMessage);
      if (!message || isInjectedContext(message)) continue;
      if (role === 'assistant' && !includeAssistantMessages) continue;
      if (addMessage(session, role, message, event)) session.capture.capturedEventCount += 1;
      continue;
    }

    if (event.type === 'event_msg' && payload.type === 'user_message') {
      const message = captureText(session, userAuthoredMessage(redact(stringValue(payload.message))));
      if (!message || isInjectedContext(message)) continue;
      if (addMessage(session, 'user', message, event)) session.capture.capturedEventCount += 1;
      continue;
    }

    if (event.type === 'event_msg' && payload.type === 'agent_message') {
      if (!includeAssistantMessages) continue;
      const message = captureText(session, redact(stringValue(payload.message)));
      if (message && addMessage(session, 'assistant', message, event)) {
        session.capture.capturedEventCount += 1;
      }
      continue;
    }

    if (event.type === 'response_item' && payload.type === 'function_call') {
      const command = parseFunctionCallCommand(payload);
      if (!command) {
        markUnhandled(session, event, payload);
        continue;
      }
      addCommand(session, command, stringValue(payload.call_id), event);
      continue;
    }

    if (event.type === 'response_item' && payload.type === 'tool_search_call') {
      addCommand(session, parseToolSearchCall(payload, session.cwd), stringValue(payload.call_id), event);
      continue;
    }

    if (event.type === 'response_item' && payload.type === 'function_call_output') {
      applyToolOutput(session, payload, includeToolOutput, event);
      continue;
    }

    if (event.type === 'response_item' && payload.type === 'tool_search_output') {
      applyToolOutput(session, payload, includeToolOutput, event);
      continue;
    }

    if (event.type === 'response_item' && payload.type === 'custom_tool_call') {
      const command = parseCustomToolCall(payload, session.cwd);
      addCommand(session, command, stringValue(payload.call_id), event);
      continue;
    }

    if (event.type === 'response_item' && payload.type === 'custom_tool_call_output') {
      applyToolOutput(session, payload, includeToolOutput, event);
      continue;
    }

    if (event.type === 'event_msg' && payload.type === 'exec_command_end') {
      const commandText = redact(Array.isArray(payload.command) ? payload.command.join(' ') : '');
      const fullOutput = captureText(
        session,
        redact(stringValue(payload.aggregated_output || payload.stdout || payload.stderr)),
      );
      const command: CommandRecord = {
        command: commandText,
        cwd: redact(stringValue(payload.cwd)),
        exitCode: numberValue(payload.exit_code),
        output: includeToolOutput ? fullOutput : '',
      };
      addCommand(session, command, stringValue(payload.call_id), event);
      collectChangedFiles(fullOutput, session.changedFiles);
      if (command.exitCode !== null && command.exitCode !== 0) {
        session.errors.push(captureText(session, `${commandText}\n${fullOutput}`, 1200));
      }
      continue;
    }

    if (event.type === 'event_msg' && payload.type === 'patch_apply_end') {
      const changes = isRecord(payload.changes) ? payload.changes : {};
      for (const path of Object.keys(changes)) session.changedFiles.add(relativeToWorkspace(path, session.cwd));
      collectActivityTimestamp(event, session);
      session.capture.capturedEventCount += 1;
      continue;
    }

    if (event.type === 'event_msg' && payload.type === 'mcp_tool_call_end') {
      const invocation = isRecord(payload.invocation) ? payload.invocation : {};
      const server = stringValue(invocation.server);
      const tool = stringValue(invocation.tool);
      const output = captureText(session, redact(safeStringify(payload.result)));
      addCommand(session, {
        command: [server, tool].filter(Boolean).join('.') || 'mcp_tool_call',
        cwd: session.cwd,
        exitCode: mcpResultIsError(payload.result) ? 1 : 0,
        output: includeToolOutput ? output : '',
      }, stringValue(payload.call_id), event);
      continue;
    }

    if (event.type === 'event_msg' && payload.type === 'web_search_end') {
      addCommand(session, {
        command: `web_search ${redact(stringValue(payload.query))}`.trim(),
        cwd: session.cwd,
        exitCode: 0,
        output: '',
      }, stringValue(payload.call_id), event);
      continue;
    }

    if (relevant) markUnhandled(session, event, payload);
  }

  if (!session.id) session.id = inferSessionId(file);
  if (replayBursts.length && session.userMessages.length) session.title = inferTitle(session);
  if (!session.title) session.title = titleIndex.get(session.id) || inferTitle(session);
  session.title = redact(session.title);
  if (!session.rootSessionId) session.rootSessionId = session.parentSessionId || session.id;
  return clipSessionToDate(session, context.date, context.timezone);
}

function createParsedSession(
  file: string,
  hadReplayBurst: boolean,
): ParsedSession {
  return {
    file,
    id: '',
    title: '',
    cwd: '',
    gitBranch: '',
    gitSha: '',
    startedAt: '',
    endedAt: '',
    userMessages: [],
    assistantMessages: [],
    commands: [],
    changedFiles: new Set<string>(),
    errors: [],
    activityTimestamps: [],
    hadReplayBurst,
    commandByCallId: new Map<string, number>(),
    parentSessionId: '',
    rootSessionId: '',
    previousUserMessage: '',
    previousAssistantMessage: '',
    messageSeenAt: new Map<string, number>(),
    turnCheckpoints: [],
    capture: createCaptureMetrics(),
  };
}

function createCaptureMetrics(): CaptureMetrics {
  return {
    mode: 'precise',
    rawEventCount: 0,
    relevantEventCount: 0,
    capturedEventCount: 0,
    duplicateCount: 0,
    replayDroppedCount: 0,
    rollbackCount: 0,
    abortedTurnCount: 0,
    compactionCount: 0,
    truncatedCount: 0,
    unhandledEventTypes: new Set<string>(),
    reasons: new Set<string>(),
  };
}

function updateSessionBounds(session: ParsedSession, event: JsonEvent): void {
  if (!event.timestamp) return;
  if (!session.startedAt) session.startedAt = event.timestamp;
  session.endedAt = event.timestamp;
}

function applySessionMetadata(
  session: ParsedSession,
  payload: Record<string, unknown>,
  titleIndex: Map<string, string>,
): void {
  const id = stringValue(payload.id);
  const source = isRecord(payload.source) ? payload.source : {};
  const subagent = isRecord(source.subagent) ? source.subagent : {};
  const spawn = isRecord(subagent.thread_spawn) ? subagent.thread_spawn : {};
  const parentSessionId = stringValue(payload.parent_thread_id || spawn.parent_thread_id);
  if (parentSessionId) session.parentSessionId = parentSessionId;
  const replayedParentMetadata = session.parentSessionId
    && id === session.parentSessionId
    && session.id
    && session.id !== id;
  if (!replayedParentMetadata) session.id = id || session.id;
  session.rootSessionId = parentSessionId || session.rootSessionId || id;
  session.cwd = redact(stringValue(payload.cwd)) || session.cwd;
  const git = isRecord(payload.git) ? payload.git : {};
  session.gitBranch = redact(stringValue(git.branch)) || session.gitBranch;
  session.gitSha = redact(stringValue(git.commit_hash)) || session.gitSha;
  session.title = titleIndex.get(session.id) || session.title;
}

function capturePreviousContext(
  session: ParsedSession,
  event: JsonEvent,
  payload: Record<string, unknown>,
): void {
  if (event.type !== 'response_item' || payload.type !== 'message') return;
  const rawMessage = redact(textFromContent(payload.content));
  const message = truncate(
    payload.role === 'user' ? userAuthoredMessage(rawMessage) : rawMessage,
    4000,
  );
  if (!message || isInjectedContext(message)) return;
  if (payload.role === 'user') session.previousUserMessage = message;
  if (payload.role === 'assistant') session.previousAssistantMessage = message;
}

function applyLifecycleEvent(
  session: ParsedSession,
  event: JsonEvent,
  payload: Record<string, unknown>,
): boolean {
  if (event.type === 'compacted' || (event.type === 'event_msg' && payload.type === 'context_compacted')) {
    session.capture.compactionCount += 1;
    session.capture.capturedEventCount += 1;
    session.capture.reasons.add('会话发生过上下文压缩');
    return true;
  }
  if (event.type === 'event_msg' && payload.type === 'turn_aborted') {
    session.capture.abortedTurnCount += 1;
    session.capture.capturedEventCount += 1;
    session.capture.reasons.add('存在被中断的轮次');
    collectActivityTimestamp(event, session);
    return true;
  }
  if (event.type === 'event_msg' && payload.type === 'thread_rolled_back') {
    const count = Math.max(1, numberValue(payload.num_turns) || 1);
    rollbackTurns(session, count);
    session.capture.rollbackCount += count;
    session.capture.capturedEventCount += 1;
    session.capture.reasons.add('已排除被回滚的轮次');
    return true;
  }
  return false;
}

function shouldDropReplayEvent(
  event: JsonEvent,
  payload: Record<string, unknown>,
  replayBursts: Array<{ start: number; end: number }>,
): boolean {
  if (!isReplayBurstEvent(event, replayBursts)) return false;
  return event.type === 'response_item'
    || (event.type === 'event_msg' && ['user_message', 'agent_message', 'exec_command_end', 'patch_apply_end'].includes(String(payload.type)));
}

function addMessage(
  session: ParsedSession,
  role: 'user' | 'assistant',
  message: string,
  event: JsonEvent,
): boolean {
  const time = Date.parse(event.timestamp || '');
  const key = `${role}\n${message}`;
  const previous = session.messageSeenAt.get(key);
  if (previous !== undefined && Number.isFinite(time) && Math.abs(time - previous) <= MESSAGE_DUPLICATE_WINDOW_MS) {
    session.capture.duplicateCount += 1;
    return false;
  }
  if (Number.isFinite(time)) session.messageSeenAt.set(key, time);
  if (role === 'user') session.turnCheckpoints.push(createTurnCheckpoint(session));
  if (role === 'user') session.userMessages.push(message);
  else session.assistantMessages.push(message);
  collectActivityTimestamp(event, session);
  return true;
}

function createTurnCheckpoint(session: ParsedSession): TurnCheckpoint {
  return {
    userMessageCount: session.userMessages.length,
    assistantMessageCount: session.assistantMessages.length,
    commandCount: session.commands.length,
    errorCount: session.errors.length,
    timestampCount: session.activityTimestamps.length,
    changedFiles: new Set(session.changedFiles),
    messageSeenAt: new Map(session.messageSeenAt),
    commandByCallId: new Map(session.commandByCallId),
  };
}

function rollbackTurns(session: ParsedSession, count: number): void {
  let checkpoint: TurnCheckpoint | undefined;
  for (let index = 0; index < count; index += 1) checkpoint = session.turnCheckpoints.pop() || checkpoint;
  if (!checkpoint) return;
  session.userMessages.length = checkpoint.userMessageCount;
  session.assistantMessages.length = checkpoint.assistantMessageCount;
  session.commands.length = checkpoint.commandCount;
  session.errors.length = checkpoint.errorCount;
  session.activityTimestamps.length = checkpoint.timestampCount;
  session.changedFiles = new Set(checkpoint.changedFiles);
  session.messageSeenAt = new Map(checkpoint.messageSeenAt);
  session.commandByCallId = new Map(checkpoint.commandByCallId);
}

function addCommand(
  session: ParsedSession,
  command: CommandRecord,
  callId: string,
  event: JsonEvent,
): void {
  session.commands.push(command);
  if (callId) session.commandByCallId.set(callId, session.commands.length - 1);
  collectActivityTimestamp(event, session);
  session.capture.capturedEventCount += 1;
}

function applyToolOutput(
  session: ParsedSession,
  payload: Record<string, unknown>,
  includeToolOutput: boolean,
  event: JsonEvent,
): void {
  const index = session.commandByCallId.get(stringValue(payload.call_id));
  const command = index === undefined ? undefined : session.commands[index];
  const output = captureText(session, redact(toolOutputText(payload)));
  if (command) {
    if (includeToolOutput) command.output = output;
    command.exitCode ??= toolOutputExitCode(payload, output);
    collectChangedFiles(output, session.changedFiles);
    if (command.exitCode !== null && command.exitCode !== 0) session.errors.push(output.slice(0, 1200));
  } else {
    session.capture.unhandledEventTypes.add('orphan_tool_output');
    session.capture.reasons.add('存在无法关联到工具调用的输出');
  }
  collectActivityTimestamp(event, session);
  session.capture.capturedEventCount += 1;
}

function parseToolSearchCall(payload: Record<string, unknown>, cwd: string): CommandRecord {
  const rawArguments = payload.arguments;
  let argumentsValue: unknown = rawArguments;
  if (typeof rawArguments === 'string') {
    try { argumentsValue = JSON.parse(rawArguments); } catch { /* 保留原始字符串 */ }
  }
  const query = isRecord(argumentsValue)
    ? stringValue(argumentsValue.query)
    : stringValue(argumentsValue);
  return {
    command: `tool_search ${redact(query)}`.trim(),
    cwd,
    exitCode: null,
    output: '',
  };
}

function toolOutputText(payload: Record<string, unknown>): string {
  if (payload.type !== 'tool_search_output') {
    return stringValue(payload.output) || safeStringify(payload.output);
  }
  const names: string[] = [];
  collectToolNames(payload.tools, names);
  return names.length ? `loaded tools: ${[...new Set(names)].slice(0, 100).join(', ')}` : '';
}

function collectToolNames(value: unknown, names: string[]): void {
  if (names.length >= 100) return;
  if (Array.isArray(value)) {
    for (const item of value) collectToolNames(item, names);
    return;
  }
  if (!isRecord(value)) return;
  const name = stringValue(value.name);
  if (name) names.push(name);
  if (value.tools) collectToolNames(value.tools, names);
}

function toolOutputExitCode(payload: Record<string, unknown>, output: string): number | null {
  if (payload.type === 'tool_search_output') {
    const status = stringValue(payload.status);
    if (status === 'completed') return 0;
    if (status === 'failed') return 1;
  }
  return exitCodeFromOutput(output);
}

function parseFunctionCallCommand(payload: Record<string, unknown>): CommandRecord | null {
  const name = stringValue(payload.name);
  try {
    const args = JSON.parse(stringValue(payload.arguments) || '{}') as Record<string, unknown>;
    if (name === 'exec_command') {
      return {
        command: redact(stringValue(args.cmd)),
        cwd: redact(stringValue(args.workdir)),
        exitCode: null,
        output: '',
      };
    }
    return {
      command: `${name || 'function_call'} ${compactToolInput(args)}`.trim(),
      cwd: '',
      exitCode: null,
      output: '',
    };
  } catch {
    return null;
  }
}

function parseCustomToolCall(payload: Record<string, unknown>, cwd: string): CommandRecord {
  const name = redact(stringValue(payload.name)) || 'custom_tool_call';
  const input = stringValue(payload.input);
  return {
    command: `${name} ${compactToolInput(input)}`.trim(),
    cwd,
    exitCode: null,
    output: '',
  };
}

function compactToolInput(value: unknown): string {
  const text = typeof value === 'string' ? value : safeStringify(value);
  return redact(text).replace(/\s+/g, ' ').trim().slice(0, 600);
}

function captureText(session: ParsedSession, value: string, overrideLimit?: number): string {
  const limit = overrideLimit || PRECISE_TEXT_LIMIT;
  const clean = value.replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (clean.length <= limit) return clean;
  session.capture.truncatedCount += 1;
  session.capture.reasons.add('部分超长消息或工具输出已截断');
  return `${clean.slice(0, limit)}\n...[truncated ${clean.length - limit} chars]`;
}

function isRelevantEvent(event: JsonEvent, payload: Record<string, unknown>): boolean {
  if (event.type === 'compacted') return true;
  if (event.type === 'response_item') {
    if (payload.type === 'message') return payload.role === 'user' || payload.role === 'assistant';
    return [
      'function_call', 'function_call_output',
      'custom_tool_call', 'custom_tool_call_output',
      'tool_search_call', 'tool_search_output',
    ].includes(String(payload.type));
  }
  if (event.type !== 'event_msg') return false;
  return [
    'user_message', 'agent_message', 'exec_command_end', 'patch_apply_end', 'mcp_tool_call_end',
    'web_search_end', 'turn_aborted', 'thread_rolled_back', 'context_compacted',
  ].includes(String(payload.type));
}

function markUnhandled(session: ParsedSession, event: JsonEvent, payload: Record<string, unknown>): void {
  const key = `${event.type || 'unknown'}:${String(payload.type || 'unknown')}`;
  session.capture.unhandledEventTypes.add(key);
  session.capture.reasons.add('存在尚未识别的相关事件类型');
}

function collectChangedFiles(output: string, files: Set<string>): void {
  for (const match of output.matchAll(/\b(?:modified|new file|deleted):\s+([^\n]+)/gi)) {
    if (match[1]) files.add(match[1].trim());
  }
  for (const match of output.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    if (match[2]) files.add(match[2].trim());
  }
  for (const match of output.matchAll(/^([ MADRCU?]{1,2})\s+(.+)$/gm)) {
    const filePath = match[2]?.trim();
    if (filePath && !filePath.startsWith('.codegraph')) files.add(filePath);
  }
}

function relativeToWorkspace(path: string, cwd: string): string {
  if (!cwd || !path.startsWith('/')) return path;
  const value = relative(cwd, path);
  return value.startsWith('..') ? path : value;
}

function exitCodeFromOutput(output: string): number | null {
  const match = output.match(/(?:Process exited with code|Exit code:)\s*(-?\d+)/i);
  return match?.[1] ? Number(match[1]) : null;
}

function mcpResultIsError(result: unknown): boolean {
  const record = isRecord(result) ? result : {};
  if ('Err' in record) return true;
  const ok = isRecord(record.Ok) ? record.Ok : {};
  return ok.isError === true;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return value === undefined ? '' : JSON.stringify(value);
  } catch {
    return String(value || '');
  }
}

function inferTitle(session: Pick<ParsedSession, 'userMessages' | 'commands'>): string {
  const first = session.userMessages[0] || session.commands[0]?.command || 'Codex 会话';
  return first.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 32) || 'Codex 会话';
}

function inferSessionId(file: string): string {
  const match = file.match(/(019e[0-9a-f-]+)/);
  return match?.[1] || basename(file, '.jsonl');
}
