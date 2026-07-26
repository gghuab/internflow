import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { InvalidJsonlRecord, ReadJsonlRecord, ReadJsonlResult, SourceRef } from '../capture/ledger-types.js';
import { isRecord } from '../support/json.js';
import type { JsonEvent } from '../projection/types.js';

export async function readJsonlFile(file: string): Promise<ReadJsonlResult> {
  const records: ReadJsonlRecord[] = [];
  const invalid: InvalidJsonlRecord[] = [];
  let carry = Buffer.alloc(0);
  let carryStart = 0;
  let bytesRead = 0;

  for await (const value of createReadStream(file)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let lineStart = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0x0a) continue;
      const rawLine = data.subarray(lineStart, index);
      const byteStart = carryStart + lineStart;
      parseLine(file, rawLine, byteStart, carryStart + index + 1, false, records, invalid);
      lineStart = index + 1;
    }
    carry = data.subarray(lineStart);
    carryStart += lineStart;
    bytesRead += chunk.length;
  }

  if (carry.length) {
    parseLine(file, carry, carryStart, carryStart + carry.length, true, records, invalid);
  }
  return { file, bytesRead, records, invalid };
}

function parseLine(
  file: string,
  input: Buffer,
  byteStart: number,
  byteEnd: number,
  trailing: boolean,
  records: ReadJsonlRecord[],
  invalid: InvalidJsonlRecord[],
): void {
  const rawLine = input.at(-1) === 0x0d ? input.subarray(0, -1) : input;
  if (!rawLine.length) return;
  const source: SourceRef = {
    file,
    byteStart,
    byteEnd,
    lineSha256: hash(rawLine),
  };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(rawLine);
  } catch {
    invalid.push({ source, reason: 'invalid_utf8' });
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid.push({ source, reason: trailing ? 'incomplete_trailing_line' : 'invalid_json' });
    return;
  }
  if (!isRecord(value)) {
    invalid.push({ source, reason: 'invalid_shape' });
    return;
  }
  records.push({ event: value as JsonEvent, source });
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
