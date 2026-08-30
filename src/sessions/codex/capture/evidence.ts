import { createHash } from 'node:crypto';
import { dirname, extname, relative } from 'node:path';
import { evidenceId } from './identity.js';
import { isRecord, numberValue, stringValue, textFromContent } from '../support/json.js';
import type { NormalizedCodexEvent, WorkEvidence } from './ledger-types.js';
import { isInjectedContext, redact, truncate, userAuthoredMessage } from '../support/privacy.js';

const VERIFY_COMMAND_PATTERN = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|build|lint)\b|\bnpx\s+(?:vitest|jest|tsc|eslint)\b|(?:^|[;&|\n]\s*)(?:uv\s+run(?:\s+--with\s+\S+)*\s+)?pytest\b|\bexec\s+(?:vitest|jest|tsc|eslint)\b|(?:^|[;&|\n]\s*)(?:vitest|jest|tsc|eslint)\b)/i;
const DELIVERY_PATTERN = /\bgit\s+(?:commit|push)\b|\bgh\s+pr\s+create\b|\bglab\s+mr\s+create\b/i;

export function buildWorkEvidence(events: NormalizedCodexEvent[]): WorkEvidence[] {
  const confirmed = events.filter((event) => (
    event.disposition === 'included'
    && event.lifecycle === 'confirmed'
    && event.localDate
  ));
  const metadata = sessionMetadata(events);
  const effectiveTurns = effectiveTurnIds(confirmed);
  const outputs = new Map<string, NormalizedCodexEvent>();
  for (const event of confirmed) {
    if (event.callId && ['tool_output', 'command_result', 'mcp_result'].includes(event.kind)) {
      outputs.set(event.callId, event);
    }
  }
  const result: WorkEvidence[] = [];
  for (const event of confirmed) {
    const meta = metadata.get(event.sessionId) || { workspace: '', branch: '' };
    const rootSessionId = event.rootSessionId || event.sessionId;
    // 一个 Codex 会话可能连续处理多个互不相关的需求。turn 是最小可靠任务边界；
    // 分支只保留为上下文，不能再把整条分支压成一个需求。
    const effectiveTurnId = effectiveTurns.get(`${rootSessionId}|${event.turnId || ''}`) || event.turnId;
    const workItemKey = [meta.workspace, meta.branch, rootSessionId, effectiveTurnId ? `turn:${effectiveTurnId}` : '']
      .filter(Boolean).join('|');
    if (event.kind === 'message') {
      const message = messageValue(event);
      if (!message || isInjectedContext(message.text)) continue;
      if (message.role === 'user') {
        result.push(createEvidence(event, workItemKey, meta, 'request', message.text, [], 'confirmed'));
      } else if (/(决定|采用|方案|结论|原因|建议|实现为|修改为)/.test(message.text)) {
        result.push(createEvidence(event, workItemKey, meta, 'decision', message.text, [], 'inferred'));
      }
      continue;
    }
    if (event.kind === 'patch_result') {
      const changes = isRecord(event.raw.payload?.changes) ? event.raw.payload?.changes : {};
      const files = Object.keys(changes).map((file) => workspaceRelative(file, meta.workspace));
      result.push(createEvidence(event, workItemKey, meta, 'change', `修改 ${files.join('、')}`, files, 'confirmed'));
      continue;
    }
    if (event.kind !== 'tool_call') continue;
    const command = toolCommand(event);
    const output = event.callId ? outputs.get(event.callId) : undefined;
    const outputText = output ? toolOutput(output) : '';
    const files = changedFiles(outputText, meta.workspace);
    const sourceEvents = output ? [event, output] : [event];
    if (isPatchTool(event, command)) {
      const codeExcerpts = codeExcerptsFromPatch(event, meta.workspace);
      const changed = [...new Set([...files, ...codeExcerpts.map((item) => item.file)])];
      const summary = changed.length ? `修改 ${changed.join('、')}` : '执行代码变更';
      const change = createEvidenceGroup(sourceEvents, workItemKey, meta, 'change', summary, changed, 'confirmed');
      if (codeExcerpts.length) change.codeExcerpts = codeExcerpts;
      result.push(change);
    }
    if (isVerificationCommand(command)) {
      const exitCode = exitCodeFromText(outputText);
      // 验证输出中的诊断文件用于判断失败是否属于当前改动，不冒充代码变更。
      const verificationFiles = [...new Set([...files, ...diagnosticFiles(outputText, meta.workspace)])];
      const summary = `${command}${exitCode === null ? '（结果未确认）' : exitCode === 0 ? '（通过）' : `（失败，退出码 ${exitCode}）`}`;
      const verification = createEvidenceGroup(
        sourceEvents,
        workItemKey,
        meta,
        exitCode !== null && exitCode !== 0 ? 'error' : 'verification',
        summary,
        verificationFiles,
        exitCode === null ? 'unknown' : 'confirmed',
      );
      verification.verification = {
        command,
        exitCode,
        outcome: exitCode === null ? 'unknown' : exitCode === 0 ? 'passed' : 'failed',
      };
      result.push(verification);
    }
    if (DELIVERY_PATTERN.test(command)) {
      result.push(createEvidenceGroup(sourceEvents, workItemKey, meta, 'delivery', command, files, output ? 'confirmed' : 'unknown'));
    }
  }
  return uniqueEvidence(result);
}

function effectiveTurnIds(events: NormalizedCodexEvent[]): Map<string, string> {
  const result = new Map<string, string>();
  const lastIntentByRoot = new Map<string, string>();
  for (const event of events) {
    if (!event.turnId || event.kind !== 'message') continue;
    const message = messageValue(event);
    if (message?.role !== 'user' || !message.text || isInjectedContext(message.text)) continue;
    const root = event.rootSessionId || event.sessionId;
    const key = `${root}|${event.turnId}`;
    if (result.has(key)) continue;
    const previous = lastIntentByRoot.get(root);
    if (previous && isContinuationRequest(message.text)) {
      result.set(key, previous);
    } else {
      result.set(key, event.turnId);
      lastIntentByRoot.set(root, event.turnId);
    }
  }
  return result;
}

function isContinuationRequest(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return true;
  if (/^[{[]/.test(text)) {
    try {
      JSON.parse(text);
      return true;
    } catch {
      // 带说明的 JSON 请求仍应作为新意图处理。
    }
  }
  return /^(?:好(?:的)?|可以|行|没问题|开始(?:修改|处理|执行)?|执行|继续|改一下|改吧|做吧|就这样|按(?:这个|上面(?:说的)?))(?:吧|了|，?不要问我(?:了)?|，?都可以执行)*[。.!！]*$/i.test(text)
    || /^可以执行[，,]?不要问我[，,]?都可以执行[。.!！]*$/i.test(text);
}

interface SessionMeta {
  workspace: string;
  branch: string;
  repository?: string;
  commit?: string;
}

function sessionMetadata(events: NormalizedCodexEvent[]): Map<string, SessionMeta> {
  const result = new Map<string, SessionMeta>();
  for (const event of events) {
    if (event.kind !== 'session_metadata') continue;
    const payload = event.raw.payload || {};
    const git = isRecord(payload.git) ? payload.git : {};
    const workspace = redact(stringValue(payload.cwd));
    result.set(event.sessionId, {
      workspace,
      branch: redact(stringValue(git.branch)),
      ...(stringValue(git.repository_url) ? { repository: redact(stringValue(git.repository_url)) } : {}),
      ...(stringValue(git.commit_hash) ? { commit: redact(stringValue(git.commit_hash)) } : {}),
    });
  }
  return result;
}

function createEvidence(
  event: NormalizedCodexEvent,
  workItemKey: string,
  meta: SessionMeta,
  kind: WorkEvidence['kind'],
  summary: string,
  files: string[],
  confidence: WorkEvidence['confidence'],
): WorkEvidence {
  return createEvidenceGroup([event], workItemKey, meta, kind, summary, files, confidence);
}

function createEvidenceGroup(
  events: NormalizedCodexEvent[],
  workItemKey: string,
  meta: SessionMeta,
  kind: WorkEvidence['kind'],
  summary: string,
  files: string[],
  confidence: WorkEvidence['confidence'],
): WorkEvidence {
  const ids = events.map((event) => event.occurrenceId);
  const first = events[0];
  if (!first) throw new Error('Cannot create evidence without source events.');
  return {
    id: evidenceId(kind, ids),
    workItemKey,
    ...(first.rootSessionId || first.sessionId ? { rootSessionId: first.rootSessionId || first.sessionId } : {}),
    ...(first.turnId ? { turnId: first.turnId } : {}),
    kind,
    status: first.lifecycle,
    timestamp: first.timestamp,
    ...(meta.repository ? { repository: meta.repository } : {}),
    workspace: meta.workspace,
    ...(meta.branch ? { branch: meta.branch } : {}),
    ...(meta.commit ? { commit: meta.commit } : {}),
    files: [...new Set(files.filter(Boolean))],
    summary: truncate(redact(summary), 4000),
    sourceEventIds: ids,
    confidence,
  };
}

function messageValue(event: NormalizedCodexEvent): { role: 'user' | 'assistant'; text: string } | null {
  const payload = event.raw.payload || {};
  if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
    const text = redact(textFromContent(payload.content));
    return {
      role: payload.role,
      text: payload.role === 'user' ? userAuthoredMessage(text) : text,
    };
  }
  if (payload.type === 'user_message') {
    return { role: 'user', text: userAuthoredMessage(redact(stringValue(payload.message))) };
  }
  if (payload.type === 'agent_message') return { role: 'assistant', text: redact(stringValue(payload.message)) };
  return null;
}

function toolCommand(event: NormalizedCodexEvent): string {
  const payload = event.raw.payload || {};
  if (payload.type === 'tool_search_call') {
    const argumentsValue = toolSearchArguments(payload.arguments);
    return redact(`tool_search ${stringValue(argumentsValue.query)}`).trim();
  }
  const name = stringValue(payload.name) || 'tool';
  const input = stringValue(payload.input || payload.arguments);
  if (name === 'exec_command') {
    try {
      const args = JSON.parse(input) as { cmd?: unknown };
      return redact(stringValue(args.cmd));
    } catch {
      return redact(input);
    }
  }
  if (name === 'exec' || name === 'functions.exec') {
    const nested = nestedExecCommand(input);
    if (nested) return redact(nested);
  }
  return redact(`${name} ${input}`).trim();
}

function nestedExecCommand(input: string): string {
  const match = input.match(/["']cmd["']\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)/s)
    || input.match(/\bcmd\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)/s);
  const literal = match?.[1];
  if (!literal) return '';
  if (literal.startsWith('`')) return literal.slice(1, -1);
  if (literal.startsWith('"')) {
    try { return JSON.parse(literal) as string; } catch { return literal.slice(1, -1); }
  }
  return literal.slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, '\n');
}

function toolOutput(event: NormalizedCodexEvent): string {
  const payload = event.raw.payload || {};
  if (payload.type === 'tool_search_output') {
    return redact(toolSearchOutputSummary(payload.tools));
  }
  const value = payload.output ?? payload.aggregated_output ?? payload.result;
  return redact(typeof value === 'string' ? value : JSON.stringify(value || ''));
}

function toolSearchArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return { query: value };
  }
}

function toolSearchOutputSummary(value: unknown): string {
  const names: string[] = [];
  const visit = (item: unknown): void => {
    if (names.length >= 100) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!isRecord(item)) return;
    const name = stringValue(item.name);
    if (name) names.push(name);
    if (item.tools) visit(item.tools);
  };
  visit(value);
  return names.length ? `loaded tools: ${[...new Set(names)].join(', ')}` : '';
}

function isPatchTool(event: NormalizedCodexEvent, command: string): boolean {
  const name = stringValue(event.raw.payload?.name);
  return /(?:apply_patch|patch)/i.test(name) || /(?:apply_patch|diff --git)/i.test(command);
}

function isVerificationCommand(command: string): boolean {
  if (/\b(?:apply_patch|tools\.apply_patch)\b|\b(?:const|let|var)\s+patch\s*=/.test(command)) return false;
  return VERIFY_COMMAND_PATTERN.test(command);
}

function codeExcerptsFromPatch(event: NormalizedCodexEvent, workspace: string) {
  const input = patchInput(event);
  if (!input) return [];
  const byFile = new Map<string, string[]>();
  let currentFile = '';
  for (const line of input.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = line.match(/^\*\*\* (?:Update|Add) File:\s+(.+)$/)
      || line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (marker) {
      currentFile = workspaceRelative(marker[2] || marker[1] || '', workspace);
      if (currentFile && !byFile.has(currentFile)) byFile.set(currentFile, []);
      continue;
    }
    if (!currentFile || !line.startsWith('+') || line.startsWith('+++')) continue;
    const values = byFile.get(currentFile);
    if (values && values.length < 40) values.push(line.slice(1));
  }
  let remaining = 6000;
  return [...byFile.entries()].flatMap(([file, lines]) => {
    if (!lines.length || remaining <= 0) return [];
    const full = redact(lines.join('\n'));
    const content = full.slice(0, remaining);
    remaining -= content.length;
    return [{
      file,
      language: languageFromPath(file),
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      sourceEventId: event.occurrenceId,
      truncated: full.length > content.length || lines.length >= 40,
    }];
  });
}

function patchInput(event: NormalizedCodexEvent): string {
  const raw = stringValue(event.raw.payload?.input || event.raw.payload?.arguments);
  if (!raw) return '';
  const assigned = raw.match(/\b(?:const|let|var)\s+patch\s*=\s*("(?:\\.|[^"\\])*")/s)?.[1];
  if (assigned) {
    try { return JSON.parse(assigned) as string; } catch { /* fall through */ }
  }
  if (!raw.trimStart().startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(raw) as { patch?: unknown; input?: unknown };
    return stringValue(parsed.patch || parsed.input);
  } catch {
    return raw;
  }
}

function languageFromPath(file: string): string {
  const extension = extname(file).slice(1).toLowerCase();
  return ({ ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', py: 'python', rs: 'rust', go: 'go', md: 'markdown' } as Record<string, string>)[extension]
    || extension
    || 'text';
}

function changedFiles(output: string, workspace: string): string[] {
  const files: string[] = [];
  for (const match of output.matchAll(/\b(?:modified|new file|deleted):\s+([^\n]+)/gi)) {
    if (match[1]) files.push(workspaceRelative(match[1].trim(), workspace));
  }
  for (const match of output.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    if (match[2]) files.push(workspaceRelative(match[2].trim(), workspace));
  }
  for (const match of output.matchAll(/^([ MADRCU?!]{2})\s+(.+)$/gm)) {
    const status = match[1] || '';
    const path = match[2]?.trim() || '';
    if (status.trim() && plausibleFilePath(path)) files.push(workspaceRelative(path, workspace));
  }
  return [...new Set(files)];
}

function diagnosticFiles(output: string, workspace: string): string[] {
  const files: string[] = [];
  const extension = String.raw`(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|less|py|go|rs|java|md|yaml|yml|sh)`;
  const inline = new RegExp(
    String.raw`^\s*([^\n()]+?\.${extension})(?:(?:\(|:)\d+(?:[, :]\d+)?\)?)[^\n]*(?:error|warning|错误|失败)`,
    'gim',
  );
  for (const match of output.matchAll(inline)) {
    if (match[1]) files.push(workspaceRelative(match[1].trim(), workspace));
  }
  const stylish = new RegExp(
    String.raw`^\s*([^\n]+?\.${extension})\s*\n\s*\d+:\d+\s+(?:error|warning)\b`,
    'gim',
  );
  for (const match of output.matchAll(stylish)) {
    if (match[1]) files.push(workspaceRelative(match[1].trim(), workspace));
  }
  return [...new Set(files.filter(plausibleFilePath))];
}

function plausibleFilePath(value: string): boolean {
  return !/^[\[{"'}]/.test(value) && (/[/\\]/.test(value) || /\.[a-z0-9]{1,10}$/i.test(value));
}

function workspaceRelative(file: string, workspace: string): string {
  if (!workspace || !file.startsWith('/')) return file;
  const value = relative(workspace, file);
  return value.startsWith('..') ? file : value;
}

function exitCodeFromText(output: string): number | null {
  const match = output.match(/(?:Process exited with code|Exit code:|exit_code["']?\s*[:=])\s*(-?\d+)/i);
  return match?.[1] ? Number(match[1]) : null;
}

function uniqueEvidence(values: WorkEvidence[]): WorkEvidence[] {
  const seen = new Set<string>();
  return values.filter((value) => !seen.has(value.id) && Boolean(seen.add(value.id)));
}
