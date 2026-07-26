import type { CaptureQuality, InvalidJsonlRecord, NormalizedCodexEvent } from './ledger-types.js';

export function evaluateCaptureQuality(
  events: NormalizedCodexEvent[],
  invalidLines: InvalidJsonlRecord[],
  options: {
    date: string;
    discoveredFiles: number;
    scannedBytes: number;
    validLines: number;
    unresolvedParents: string[];
    cycles: string[];
  },
): CaptureQuality {
  const target = events.filter((event) => event.localDate === options.date);
  const count = (value: NormalizedCodexEvent['disposition']) => (
    target.filter((event) => event.disposition === value).length
  );
  const included = count('included');
  const duplicate = count('duplicate');
  const replay = count('replay');
  const unsupported = count('unsupported');
  const invalid = count('invalid');
  const accounted = included + duplicate + replay + unsupported + invalid;
  const orphanToolOutputs = orphanOutputs(target);
  const unknownRelevantEventTypes = [...new Set(
    target.filter((event) => event.disposition === 'unsupported').map((event) => event.representation),
  )].sort();
  const reasons: string[] = [];
  if (invalidLines.length) reasons.push(`存在 ${invalidLines.length} 条无法解析的 JSONL 记录`);
  if (unsupported) reasons.push(`存在 ${unsupported} 条尚未适配的相关事件`);
  if (orphanToolOutputs) reasons.push(`存在 ${orphanToolOutputs} 条无法关联调用的工具输出`);
  if (options.unresolvedParents.length) reasons.push(`存在 ${options.unresolvedParents.length} 个缺失父会话`);
  if (options.cycles.length) reasons.push(`存在 ${options.cycles.length} 个循环父子关系`);
  const accountingDifference = target.length - accounted;
  if (accountingDifference) reasons.push(`事件记账差额为 ${accountingDifference}`);
  const coverage: CaptureQuality['coverage'] = accountingDifference || unsupported || options.cycles.length
    ? 'low'
    : invalidLines.length || orphanToolOutputs || options.unresolvedParents.length
      ? 'partial'
      : 'high';
  return {
    discoveredFiles: options.discoveredFiles,
    scannedBytes: options.scannedBytes,
    validLines: options.validLines,
    invalidLines: invalidLines.length,
    targetOccurrences: target.length,
    included,
    duplicate,
    replay,
    unsupported,
    invalid,
    rolledBack: target.filter((event) => event.lifecycle === 'rolled_back').length,
    aborted: target.filter((event) => event.lifecycle === 'aborted').length,
    orphanToolOutputs,
    unresolvedParents: options.unresolvedParents,
    unknownRelevantEventTypes,
    accountingDifference,
    coverage,
    reasons,
  };
}

function orphanOutputs(events: NormalizedCodexEvent[]): number {
  const calls = new Set(events.filter((event) => event.kind === 'tool_call' && event.callId).map((event) => event.callId));
  return events.filter((event) => event.kind === 'tool_output' && (!event.callId || !calls.has(event.callId))).length;
}
