import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { occurrenceId, semanticFingerprint, stableStringify } from './identity.js';
import { isRecord, stringValue } from '../support/json.js';
import type { NormalizedCodexEvent, ReadJsonlRecord } from './ledger-types.js';
import { redact, truncate } from '../support/privacy.js';
import { localDate } from '../support/time.js';

const KNOWN_EVENT_MSG_TYPES = new Set([
  'user_message', 'agent_message', 'exec_command_end', 'patch_apply_end', 'mcp_tool_call_end',
  'web_search_end', 'turn_aborted', 'thread_rolled_back', 'context_compacted',
]);

export function normalizeFileEvents(
  file: string,
  records: ReadJsonlRecord[],
  timezone: string,
): NormalizedCodexEvent[] {
  const identity = fileIdentity(file, records);
  return records.map(({ event, source }) => {
    const payload = event.payload || {};
    const timestamp = stringValue(event.timestamp);
    const payloadText = stableStringify(payload);
    const kind = eventKind(event.type || '', stringValue(payload.type));
    const supported = isSupported(event.type || '', stringValue(payload.type));
    return {
      occurrenceId: occurrenceId(file, source.byteStart, source.lineSha256),
      semanticFingerprint: semanticFingerprint(event),
      sessionId: identity.sessionId,
      ...(identity.parentSessionId ? { parentSessionId: identity.parentSessionId } : {}),
      ...(stringValue(payload.call_id) ? { callId: stringValue(payload.call_id) } : {}),
      timestamp,
      localDate: validTimestamp(timestamp) ? localDate(timestamp, timezone) : '',
      kind,
      representation: `${event.type || 'unknown'}:${stringValue(payload.type) || 'unknown'}`,
      disposition: supported ? 'included' : 'unsupported',
      lifecycle: 'confirmed',
      source,
      payloadPreview: truncate(redact(payloadText), 4000),
      payloadLength: payloadText.length,
      payloadSha256: createHash('sha256').update(payloadText).digest('hex'),
      raw: event,
    };
  });
}

function fileIdentity(
  file: string,
  records: ReadJsonlRecord[],
): { sessionId: string; parentSessionId?: string } {
  for (const { event } of records) {
    if (event.type !== 'session_meta') continue;
    const payload = event.payload || {};
    const sessionId = stringValue(payload.id);
    if (!sessionId) continue;
    const source = isRecord(payload.source) ? payload.source : {};
    const subagent = isRecord(source.subagent) ? source.subagent : {};
    const spawn = isRecord(subagent.thread_spawn) ? subagent.thread_spawn : {};
    const parentSessionId = stringValue(payload.parent_thread_id || spawn.parent_thread_id);
    return { sessionId, ...(parentSessionId ? { parentSessionId } : {}) };
  }
  return { sessionId: basename(file, '.jsonl') };
}

function eventKind(type: string, payloadType: string): string {
  if (type === 'session_meta') return 'session_metadata';
  if (type === 'compacted' || payloadType === 'context_compacted') return 'context_compacted';
  if (payloadType === 'message' || payloadType === 'user_message' || payloadType === 'agent_message') return 'message';
  if (payloadType === 'reasoning') return 'telemetry';
  if (payloadType === 'tool_search_call') return 'tool_call';
  if (payloadType === 'tool_search_output') return 'tool_output';
  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') return 'tool_call';
  if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') return 'tool_output';
  if (payloadType === 'exec_command_end') return 'command_result';
  if (payloadType === 'patch_apply_end') return 'patch_result';
  if (payloadType === 'mcp_tool_call_end') return 'mcp_result';
  if (payloadType === 'web_search_end') return 'web_search_result';
  if (payloadType === 'thread_rolled_back') return 'rollback';
  if (payloadType === 'turn_aborted') return 'abort';
  return 'telemetry';
}

function isSupported(type: string, payloadType: string): boolean {
  if (type === 'response_item') {
    return [
      'message', 'agent_message', 'reasoning',
      'function_call', 'function_call_output',
      'custom_tool_call', 'custom_tool_call_output',
      'tool_search_call', 'tool_search_output',
    ]
      .includes(payloadType);
  }
  if (type === 'event_msg') {
    if (KNOWN_EVENT_MSG_TYPES.has(payloadType)) return true;
    // 普通进度和 token 统计是已知遥测；新增的工具/回滚类事件必须显式适配。
    return !/(message|call|tool|patch|rollback|abort|compact)/i.test(payloadType);
  }
  return true;
}

function validTimestamp(value: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}
