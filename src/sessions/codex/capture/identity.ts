import { createHash } from 'node:crypto';
import type { JsonEvent } from '../projection/types.js';
import { isRecord, stringValue, textFromContent } from '../support/json.js';

export function occurrenceId(file: string, byteStart: number, lineSha256: string): string {
  return digest(`${file}\n${byteStart}\n${lineSha256}`);
}

export function semanticFingerprint(event: JsonEvent): string {
  const payload = event.payload || {};
  const payloadType = stringValue(payload.type);
  if (payloadType === 'message') {
    return digest(`message\n${stringValue(payload.role)}\n${normalize(textFromContent(payload.content))}`);
  }
  if (payloadType === 'user_message' || payloadType === 'agent_message') {
    const role = payloadType === 'user_message' ? 'user' : 'assistant';
    return digest(`message\n${role}\n${normalize(stringValue(payload.message))}`);
  }
  const callId = stringValue(payload.call_id);
  if (callId) return digest(`${payloadType}\n${callId}`);
  return digest(`${event.type || ''}\n${payloadType}\n${stableStringify(payload)}`);
}

export function evidenceId(kind: string, eventIds: string[]): string {
  return digest(`${kind}\n${[...eventIds].sort().join('\n')}`);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value) || '';
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
