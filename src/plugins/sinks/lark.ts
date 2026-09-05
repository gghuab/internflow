import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SinkConfig } from '../../core/config.js';
import { expandHome, stateDirectory } from '../../core/paths.js';
import { resolveExecutable, runCommand } from '../../core/process.js';
import type {
  HeadingReference,
  OutputArtifact,
  RunContext,
  SinkPlugin,
  SinkSnapshot,
} from '../../core/contracts/index.js';
import { combinedReports } from './markdown.js';

type LarkConfig = Extract<SinkConfig, { type: 'lark' }>;

interface LarkResponse {
  ok?: boolean;
  data?: {
    document?: {
      content?: string;
      revision_id?: number;
      url?: string;
    };
    result?: string;
  };
  error?: unknown;
}

export class LarkSink implements SinkPlugin {
  readonly name = 'lark' as const;

  async inspect(_context: RunContext, config: SinkConfig): Promise<SinkSnapshot> {
    const lark = asLarkConfig(config);
    // 日报覆盖与普通追加不依赖远端正文；仅需求记录生成前需要结构快照。
    if (lark.mode !== 'section-append') return {};
    const { executable, env } = await larkCliRuntime(lark);
    let markdown: string;
    if (lark.reader === 'larkparser') {
      try {
        markdown = await fetchDocumentWithLarkParser(lark);
      } catch {
        // larkparser 偶发网络失败时，回退到写入端 CLI 读取，避免整次任务在生成前中断。
        markdown = (await fetchDocument(executable, lark, 'full', 'markdown', env)).content;
      }
    } else {
      markdown = (await fetchDocument(executable, lark, 'full', 'markdown', env)).content;
    }
    const outline = await fetchDocument(executable, lark, 'outline', 'xml', env);
    return {
      markdown,
      headings: parseOutline(outline.content),
      revisionId: outline.revisionId,
    };
  }

  async apply(
    context: RunContext,
    config: SinkConfig,
    artifact: OutputArtifact,
    snapshot?: SinkSnapshot,
  ): Promise<Record<string, unknown>> {
    const lark = asLarkConfig(config);
    if (lark.mode === 'append') {
      const { executable, env } = await larkCliRuntime(lark);
      if (artifact.kind !== 'markdown') throw new Error('Lark append mode requires a Markdown artifact.');
      const current = await fetchDocument(executable, lark, 'outline', 'xml', env);
      if (!context.dryRun) {
        await updateDocument(
          executable,
          lark,
          'append',
          '',
          prepareLarkMarkdown(artifact.markdown),
          current.revisionId,
          env,
        );
      }
      return { sink: this.name, mode: lark.mode, applied: !context.dryRun, revisionId: current.revisionId };
    }

    if (lark.mode === 'history-replace') {
      if (artifact.kind !== 'markdown') {
        throw new Error('Lark history-replace mode requires a Markdown artifact.');
      }
      const archive = context.job.sinks.find((sink) => sink.type === 'markdown' && sink.archive);
      if (!archive || archive.type !== 'markdown') {
        throw new Error('Lark history-replace requires an archive-enabled Markdown sink.');
      }
      const directory = expandHome(archive.directory);
      await mkdir(directory, { recursive: true });
      const combined = await combinedReports(directory, {
        date: context.date,
        markdown: artifact.markdown,
      });
      if (!context.dryRun) {
        const parser = await resolveLarkParserWriter(lark);
        if (parser) {
          await syncDocumentHistoryWithLarkParser(parser, lark, context, combined);
        } else {
          await replaceDocument(await requireLarkCli(lark), lark, context, combined);
        }
      }
      return {
        sink: this.name,
        mode: lark.mode,
        applied: !context.dryRun,
        reportCount: (combined.match(/^# \d{4}-\d{2}-\d{2}(?: 工作日报)?$/gm) || []).length,
      };
    }

    const { executable, env } = await larkCliRuntime(lark);
    if (artifact.kind !== 'records') throw new Error('Lark section-append mode requires records.');
    if (!snapshot?.headings) throw new Error('Lark section-append requires an inspected heading snapshot.');
    if (artifact.records.length === 0) {
      return {
        sink: this.name,
        mode: lark.mode,
        skipped: true,
        reason: 'ai_proposed_no_append_operations',
        updates: [],
      };
    }
    const headings = new Map(snapshot.headings.map((heading) => [heading.ref, heading]));
    const resolvedRecords = artifact.records.map((record) => {
      const heading = headings.get(record.targetRef);
      if (!heading || heading.level < 2 || heading.level > 5 || heading.section !== record.section) {
        throw new Error(`Unknown or mismatched heading ref: ${record.targetRef}`);
      }
      return { record, heading };
    });

    // 生成期间文档可能被人工编辑。首次写入前重新校验标题，避免旧引用写到错误章节。
    const currentOutline = await fetchDocument(executable, lark, 'outline', 'xml', env);
    assertHeadingsUnchanged(snapshot.headings, parseOutline(currentOutline.content));

    const updates: Array<Record<string, unknown>> = [];
    for (const { record, heading } of resolvedRecords) {
      const section = await fetchSection(executable, lark, heading.blockId, env);
      const operation = record.operation || 'append';
      const preparedMarkdown = prepareLarkMarkdown(record.markdown);
      const firstHeading = firstMarkdownHeading(preparedMarkdown);
      if ((operation === 'append' || operation === 'create')
        && firstHeading
        && sectionContainsHeading(section.content, firstHeading.level, firstHeading.text)) {
        updates.push({
          targetRef: record.targetRef,
          operation,
          anchorBlockId: heading.blockId,
          applied: false,
          alreadyApplied: true,
        });
        continue;
      }

      const response = context.dryRun
        ? null
        : operation === 'replace'
          ? await replaceSection(executable, lark, heading, section, preparedMarkdown, env)
          : await updateDocument(
            executable,
            lark,
            'block_insert_after',
            lastBlockId(section.content, heading.blockId),
            preparedMarkdown,
            section.revisionId,
            env,
          );
      updates.push({
        targetRef: record.targetRef,
        operation,
        anchorBlockId: operation === 'replace'
          ? heading.blockId
          : lastBlockId(section.content, heading.blockId),
        applied: !context.dryRun,
        response,
      });
    }
    return { sink: this.name, mode: lark.mode, updates };
  }

  async doctor(config: SinkConfig): Promise<{ ok: boolean; message: string }> {
    const lark = asLarkConfig(config);
    if (await resolveLarkParserWriter(lark)) {
      return { ok: true, message: 'larkparser/lark-cli credential bridge ready.' };
    }
    const executable = await resolveExecutable('lark-cli', lark.executable);
    if (!executable) return { ok: false, message: 'lark-cli was not found.' };
    if (lark.reader === 'larkparser') {
      const parser = await resolveExecutable('larkparser', lark.parserExecutable);
      if (!parser) return { ok: false, message: 'larkparser was not found.' };
    }
    try {
      await runCommand(executable, [...profileArgs(lark), 'doctor', '--offline'], { timeoutMs: 30_000 });
      return { ok: true, message: `lark-cli ready${lark.profile ? ` (profile: ${lark.profile})` : ''}.` };
    } catch (error) {
      return { ok: false, message: `lark-cli check failed: ${String(error)}` };
    }
  }
}

export async function resolveLarkParserWriter(
  config: SinkConfig,
): Promise<{ executable: string; larkCli: string } | null> {
  if (config.type !== 'lark' || config.identity !== 'user') return null;
  if (config.mode !== 'history-replace' && config.reader !== 'larkparser') return null;
  // 显式指定 lark-cli 时保持原行为；同时指定 parserExecutable 才切换写入端。
  if (config.executable && !config.parserExecutable) return null;
  const [executable, larkCli] = await Promise.all([
    resolveExecutable('larkparser', config.parserExecutable),
    resolveExecutable('lark-cli', config.executable),
  ]);
  return executable && larkCli ? { executable, larkCli } : null;
}

export async function verifyLarkParserWriter(config: SinkConfig): Promise<boolean> {
  const writer = await resolveLarkParserWriter(config);
  if (!writer || config.type !== 'lark') return false;
  const auth = await larkCliExternalAuthEnvironment();
  const document = await fetchDocument(writer.larkCli, config, 'full', 'markdown', auth);
  return document.content.length > 0;
}

export function isLarkIdentityAvailable(output: string, identity: LarkConfig['identity']): boolean {
  try {
    const status = JSON.parse(output) as {
      identities?: Record<string, { available?: boolean }>;
    };
    return status.identities?.[identity]?.available === true;
  } catch {
    return false;
  }
}

async function fetchDocumentWithLarkParser(config: LarkConfig): Promise<string> {
  const executable = await resolveExecutable('larkparser', config.parserExecutable);
  if (!executable) throw new Error('larkparser was not found. Run `internflow doctor`.');
  const result = await runCommand(executable, [
    'fetch',
    larkParserDocumentUrl(config.document),
    '--mode',
    'fast',
  ], { timeoutMs: 3 * 60_000, sensitiveOutput: true });
  return result.stdout.trim();
}

function larkParserDocumentUrl(document: string): string {
  if (/^https?:\/\//.test(document)) return document;
  return `https://bytedance.larkoffice.com/docx/${document}`;
}

async function replaceDocument(
  executable: string,
  config: LarkConfig,
  context: RunContext,
  markdown: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const runDirectory = join(stateDirectory(), 'runs', context.jobName, context.date);
  await mkdir(runDirectory, { recursive: true });
  const markdownPath = join(runDirectory, 'combined.md');
  const content = [
    `<title>${escapeXmlText(config.title || 'Codex 日报')}</title>`,
    '',
    prepareLarkMarkdown(markdown),
  ].join('\n');
  await writeFile(markdownPath, content, { encoding: 'utf8', mode: 0o600 });
  const chunks = splitHistoryMarkdown(content);
  const chunkDelayMs = larkChunkDelayMs();
  for (const [index, chunk] of chunks.entries()) {
    const command = index === 0 ? 'overwrite' : 'append';
    const result = await runCommand(executable, [
      ...profileArgs(config),
      'docs',
      '+update',
      '--as',
      config.identity,
      '--doc',
      config.document,
      '--command',
      command,
      '--doc-format',
      'markdown',
      '--content',
      '-',
    ], {
      ...(env ? { env } : {}),
      input: chunk,
      timeoutMs: 5 * 60_000,
      sensitiveOutput: true,
    });
    const response = parseResponse(result.stdout, command);
    if (!response.ok || response.data?.result !== 'success') {
      throw new Error(`Lark ${command} failed: ${JSON.stringify(response.error || response)}`);
    }
    // 飞书文档连续改版过快会触发版本冲突；逐日报节流换取确定性写入。
    if (index < chunks.length - 1 && chunkDelayMs > 0) await delay(chunkDelayMs);
  }

  const remote = await fetchDocument(executable, config, 'full', 'markdown', env);
  const expectedHeadings = dailyHistoryHeadings(content);
  const actualHeadings = dailyHistoryHeadings(remote.content);
  if (expectedHeadings.join('\n') !== actualHeadings.join('\n')) {
    throw new Error(
      `Lark history verification failed: expected ${expectedHeadings.length} reports, got ${actualHeadings.length}.`,
    );
  }
}

async function syncDocumentHistoryWithLarkParser(
  parser: { executable: string; larkCli: string },
  config: LarkConfig,
  context: RunContext,
  markdown: string,
): Promise<void> {
  const runDirectory = join(stateDirectory(), 'runs', context.jobName, context.date);
  await mkdir(runDirectory, { recursive: true });
  const content = prepareLarkMarkdown(markdown);
  await writeFile(join(runDirectory, 'combined.md'), content, { encoding: 'utf8', mode: 0o600 });

  const auth = await larkCliExternalAuthEnvironment();
  const current = await fetchDocument(parser.larkCli, config, 'full', 'markdown', auth);
  const expectedDates = dailyHistoryHeadings(content);
  const currentDates = dailyHistoryHeadings(current.content);
  const existingOffset = expectedDates.length - currentDates.length;
  if (existingOffset < 0
    || expectedDates.slice(existingOffset).join('\n') !== currentDates.join('\n')) {
    throw new Error(
      'Lark history is not a suffix of the local archive; refusing a destructive full-document rewrite.',
    );
  }

  const missing = splitHistoryMarkdown(content).slice(0, existingOffset);
  for (const report of [...missing].reverse()) {
    await insertHistoryReport(parser.larkCli, config, auth, report);
    if (larkChunkDelayMs() > 0) await delay(larkChunkDelayMs());
  }

  const remote = await fetchDocument(parser.larkCli, config, 'full', 'markdown', auth);
  const actualDates = dailyHistoryHeadings(remote.content);
  if (expectedDates.join('\n') !== actualDates.join('\n')) {
    throw new Error(
      `Lark history verification failed: expected ${expectedDates.length} reports, got ${actualDates.length}.`,
    );
  }
}

async function insertHistoryReport(
  executable: string,
  config: LarkConfig,
  env: NodeJS.ProcessEnv,
  markdown: string,
): Promise<void> {
  const expectedHeadings = markdownHeadings(markdown);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await runCommand(executable, [
        ...profileArgs(config),
        'docs',
        '+update',
        '--api-version',
        'v2',
        '--doc',
        config.document,
        '--command',
        'block_insert_after',
        '--block-id',
        '0',
        '--doc-format',
        'markdown',
        '--content',
        '-',
        '--as',
        config.identity,
      ], { env, input: markdown, timeoutMs: 5 * 60_000, sensitiveOutput: true });
      const response = parseResponse(result.stdout, 'insert history report');
      if (response.ok && response.data?.result === 'success') return;
    } catch {
      // 写入端可能在服务端已成功后丢失回包；下面统一读回确认，避免重复插入。
    }

    const remote = await fetchDocument(executable, config, 'full', 'markdown', env);
    if (markdownHeadings(remote.content).slice(0, expectedHeadings.length).join('\n')
      === expectedHeadings.join('\n')) return;
    if (attempt < 2) await delay(5_000);
  }
  throw new Error(`Lark failed to insert history report ${dailyHistoryHeadings(markdown)[0] || 'unknown'}.`);
}

async function larkCliExternalAuthEnvironment(): Promise<NodeJS.ProcessEnv> {
  const currentToken = process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN?.trim();
  const currentAppId = process.env.LARKSUITE_CLI_APP_ID?.trim();
  if (currentToken && currentAppId) {
    return {
      LARKSUITE_CLI_USER_ACCESS_TOKEN: currentToken,
      LARKSUITE_CLI_APP_ID: currentAppId,
    };
  }

  const bytedcli = await resolveExecutable('bytedcli');
  if (!bytedcli) throw new Error('bytedcli was not found for Lark user authentication.');
  const jwt = (await runCommand(bytedcli, ['auth', 'get-bytecloud-jwt-token'], {
    timeoutMs: 30_000,
    sensitiveOutput: true,
  })).stdout.trim();
  if (!jwt) throw new Error('bytedcli returned an empty ByteCloud JWT.');

  const baseUrl = process.env.LARK_PARSER_BASE_URL?.trim() || 'https://agihub.bytedance.net';
  const response = await fetch(`${baseUrl}/api/v3/lark_doc/auth/lark_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jwt-token': jwt },
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json() as {
    code?: number;
    message?: string;
    data?: { access_token?: string; app_id?: string };
  };
  const accessToken = payload.data?.access_token;
  const appId = payload.data?.app_id;
  if (!response.ok || payload.code !== 0 || !accessToken || !appId) {
    throw new Error(`Unable to obtain Lark user token: ${payload.message || response.status}.`);
  }
  return {
    LARKSUITE_CLI_USER_ACCESS_TOKEN: accessToken,
    LARKSUITE_CLI_APP_ID: appId,
  };
}

function dailyHistoryHeadings(markdown: string): string[] {
  return [...markdown.matchAll(/^# (20\d{2}-\d{2}-\d{2})(?: 工作日报)?$/gm)]
    .map((match) => match[1] || '');
}

function markdownHeadings(markdown: string): string[] {
  return [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)]
    .map((match) => `${match[1]} ${(match[2] || '').trim()}`);
}

function larkChunkDelayMs(): number {
  const configured = Number(process.env.INTERNFLOW_LARK_CHUNK_DELAY_MS || 2_000);
  return Number.isFinite(configured) && configured >= 0 ? configured : 2_000;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 按日报边界分批写入，避免大文档整页覆盖触发服务端超时。 */
export function splitHistoryMarkdown(markdown: string): string[] {
  const starts = [...markdown.matchAll(/^# 20\d{2}-\d{2}-\d{2}[^\n]*$/gm)]
    .map((match) => match.index);
  if (starts.length < 2) return [markdown];
  return [
    markdown.slice(0, starts[1]),
    ...starts.slice(1).map((start, index) => markdown.slice(start, starts[index + 2])),
  ];
}

/** Mermaid 围栏在飞书 Markdown 中只是代码块，发布前转换成可直接渲染的画板。 */
export function prepareLarkMarkdown(markdown: string): string {
  // 历史归档里可能残留旧版 HTML 空段；发布边界统一清除，避免再次写回飞书。
  const normalized = markdown.replace(
    /^[\t ]*<p>\s*<br\s*\/?>\s*<\/p>[\t ]*$/gim,
    '',
  );
  return compactLarkBlockSpacing(normalized).replace(
    /^```mermaid[\t ]*\r?\n([\s\S]*?)^```[\t ]*$/gim,
    (_match, source: string) => `<whiteboard type="mermaid">\n${escapeXmlText(source.trim())}\n</whiteboard>`,
  );
}

function compactLarkBlockSpacing(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const result: string[] = [];
  let inFence = false;
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    if (line.trim()) {
      result.push(line);
      if (/^```/.test(line)) inFence = !inFence;
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && !lines[end]?.trim()) end += 1;
    const previous = result.at(-1) || '';
    const next = lines[end] || '';
    // 飞书会把标题或代码围栏旁的 Markdown 空行渲染成独立空段落。
    const fenceBoundary = /^```/.test(previous) || /^```/.test(next);
    const headingBoundary = !inFence
      && (/^#{1,6}\s+/.test(previous) || /^#{1,6}\s+/.test(next));
    if (inFence && !fenceBoundary) result.push(...lines.slice(index, end));
    else if (!fenceBoundary && !headingBoundary) result.push('');
    index = end;
  }
  return result.join('\n');
}

function escapeXmlText(value: string): string {
  // Mermaid 解析器直接读取 whiteboard 原文；转义 `>` 会把连线箭头变成无效语法。
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

async function fetchDocument(
  executable: string,
  config: LarkConfig,
  scope: 'full' | 'outline',
  format: 'markdown' | 'xml',
  env?: NodeJS.ProcessEnv,
): Promise<{ content: string; revisionId: number }> {
  const result = await runCommand(executable, [
    ...profileArgs(config),
    'docs',
    '+fetch',
    '--api-version',
    'v2',
    '--doc',
    config.document,
    '--scope',
    scope,
    '--detail',
    format === 'xml' ? 'with-ids' : 'simple',
    '--doc-format',
    format,
    '--as',
    config.identity,
    '--format',
    'json',
  ], {
    ...(env ? { env, sensitiveOutput: true } : {}),
    timeoutMs: 3 * 60_000,
  });
  return documentFromResponse(result.stdout, `fetch ${scope}`);
}

async function fetchSection(
  executable: string,
  config: LarkConfig,
  headingId: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ content: string; revisionId: number }> {
  const result = await runCommand(executable, [
    ...profileArgs(config),
    'docs',
    '+fetch',
    '--api-version',
    'v2',
    '--doc',
    config.document,
    '--scope',
    'section',
    '--start-block-id',
    headingId,
    '--detail',
    'with-ids',
    '--doc-format',
    'xml',
    '--as',
    config.identity,
    '--format',
    'json',
  ], {
    ...(env ? { env, sensitiveOutput: true } : {}),
    timeoutMs: 3 * 60_000,
  });
  return documentFromResponse(result.stdout, `fetch section ${headingId}`);
}

async function replaceSection(
  executable: string,
  config: LarkConfig,
  heading: HeadingReference,
  section: { content: string; revisionId: number },
  markdown: string,
  env?: NodeJS.ProcessEnv,
): Promise<LarkResponse> {
  assertReplaceableSection(section.content, heading.blockId);
  const oldBlockIds = topLevelBlockIds(section.content);
  if (oldBlockIds[0] !== heading.blockId) {
    throw new Error(`Cannot resolve replaceable section for ${heading.blockId}.`);
  }
  if (oldBlockIds.length === 1) {
    return updateDocument(
      executable,
      config,
      'block_replace',
      heading.blockId,
      markdown,
      section.revisionId,
      env,
    );
  }

  // 先写入新内容再删除旧块；第二步失败时最多留下重复章节，不会先丢失原文。
  const inserted = await updateDocument(
    executable,
    config,
    'block_insert_after',
    oldBlockIds.at(-1) || heading.blockId,
    markdown,
    section.revisionId,
    env,
  );
  return updateDocument(
    executable,
    config,
    'block_delete',
    oldBlockIds.join(','),
    undefined,
    updateRevision(inserted, section.revisionId),
    env,
  );
}

async function updateDocument(
  executable: string,
  config: LarkConfig,
  command: 'append' | 'block_insert_after' | 'block_replace' | 'block_delete',
  blockId: string,
  content: string | undefined,
  revisionId: number,
  env?: NodeJS.ProcessEnv,
): Promise<LarkResponse> {
  const args = [
    ...profileArgs(config),
    'docs',
    '+update',
    '--api-version',
    'v2',
    '--doc',
    config.document,
    '--command',
    command,
  ];
  if (blockId) args.push('--block-id', blockId);
  if (content !== undefined) args.push('--doc-format', 'markdown', '--content', '-');
  args.push('--revision-id', String(revisionId), '--as', config.identity);
  const result = await runCommand(executable, args, {
    ...(env ? { env } : {}),
    ...(content !== undefined ? { input: content } : {}),
    timeoutMs: 5 * 60_000,
    sensitiveOutput: true,
  });
  const response = parseResponse(result.stdout, `update ${command}`);
  if (!response.ok || response.data?.result !== 'success') {
    throw new Error(`Lark ${command} failed: ${JSON.stringify(response.error || response)}`);
  }
  return response;
}

function updateRevision(response: LarkResponse, fallback: number): number {
  return response.data?.document?.revision_id ?? fallback;
}

function documentFromResponse(output: string, label: string): { content: string; revisionId: number } {
  const response = parseResponse(output, label);
  const content = response.data?.document?.content;
  const revisionId = response.data?.document?.revision_id;
  if (!response.ok || typeof content !== 'string' || typeof revisionId !== 'number') {
    throw new Error(`Lark ${label} failed: ${JSON.stringify(response.error || response)}`);
  }
  return { content, revisionId };
}

export function parseOutline(xml: string): HeadingReference[] {
  const headings: HeadingReference[] = [];
  let section: HeadingReference['section'] = null;
  const pattern = /<h([1-6])\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;
  for (const match of xml.matchAll(pattern)) {
    const level = Number(match[1]);
    const text = decodeXml(match[3] || '');
    if (level === 2) section = sectionFromText(text, section);
    headings.push({
      ref: `h${headings.length + 1}`,
      blockId: match[2] || '',
      level,
      text,
      section,
    });
  }
  if (!headings.length) throw new Error('No headings found in the Lark document.');
  return headings;
}

export function lastBlockId(xml: string, headingId: string): string {
  const ids = topLevelBlockIds(xml);
  if (!ids.length || ids[0] !== headingId) throw new Error(`Cannot resolve section end for ${headingId}.`);
  return ids.at(-1) || headingId;
}

export function topLevelBlockIds(xml: string): string[] {
  const ids: string[] = [];
  const identifiedAncestor: boolean[] = [];
  for (const match of xml.matchAll(/<\/?([a-z][\w-]*)(?:\s[^<>]*?)?\/?>/gi)) {
    const tag = match[0];
    const closing = tag.startsWith('</');
    const selfClosing = /\/>$/.test(tag);
    if (closing) {
      identifiedAncestor.pop();
      continue;
    }
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    const insideBlock = identifiedAncestor.at(-1) || false;
    const isBlock = Boolean(id) && !insideBlock && match[1]?.toLowerCase() !== 'fragment';
    if (isBlock && id) ids.push(id);
    if (!selfClosing) identifiedAncestor.push(insideBlock || isBlock);
  }
  return ids;
}

function firstMarkdownHeading(markdown: string): { level: number; text: string } | null {
  const match = markdown.match(/^(#{3,6})\s+(.+)$/m);
  return match ? { level: match[1]?.length || 0, text: (match[2] || '').trim() } : null;
}

function sectionContainsHeading(xml: string, level: number, text: string): boolean {
  const pattern = new RegExp(`<h${level}\\s+[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'g');
  const normalized = normalizeHeadingText(text);
  return [...xml.matchAll(pattern)]
    .some((match) => normalizeHeadingText(decodeXml(match[1] || '')) === normalized);
}

function normalizeHeadingText(value: string): string {
  return value
    .replace(/\\([`*_~])/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function assertReplaceableSection(xml: string, headingId: string): void {
  if (/<(?:img|whiteboard|sheet|bitable|synced_reference|source|file|cite)\b/i.test(xml)) {
    throw new Error(
      `Refusing to replace ${headingId}: the section contains a resource block that must be preserved manually.`,
    );
  }
}

export function assertHeadingsUnchanged(
  expected: HeadingReference[],
  current: HeadingReference[],
): void {
  const currentByBlockId = new Map(current.map((heading) => [heading.blockId, heading]));
  for (const heading of expected) {
    const latest = currentByBlockId.get(heading.blockId);
    if (!latest || latest.section !== heading.section || latest.text !== heading.text) {
      throw new Error(
        `Lark heading changed during generation: ${heading.text} (${heading.blockId}). Run the job again.`,
      );
    }
  }
}

function sectionFromText(
  text: string,
  current: HeadingReference['section'],
): HeadingReference['section'] {
  if (/^一、开发总览/.test(text)) {
    return 'overview';
  }
  if (/^(?:一、(?:需求开发档案|需求开发记录)|二、需求开发记录)/.test(text)) {
    return 'requirement';
  }
  if (/^(?:二、(?:问题定位与修复记录|联调问题与 Bug Fix 汇总)|三、问题与修复记录)/.test(text)) {
    return 'bugfix';
  }
  if (/^(?:三、(?:工程方法与知识沉淀|个人沉淀)|四、工程经验沉淀)/.test(text)) {
    return 'insight';
  }
  return current;
}

function decodeXml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function parseResponse(output: string, label: string): LarkResponse {
  try {
    return JSON.parse(output) as LarkResponse;
  } catch (error) {
    throw new Error(`lark-cli returned invalid JSON for ${label}: ${String(error)}`);
  }
}

function profileArgs(config: LarkConfig): string[] {
  return config.profile ? ['--profile', config.profile] : [];
}

async function requireLarkCli(config: LarkConfig): Promise<string> {
  const executable = await resolveExecutable('lark-cli', config.executable);
  if (!executable) throw new Error('lark-cli was not found. Run `internflow doctor`.');
  return executable;
}

async function larkCliRuntime(
  config: LarkConfig,
): Promise<{ executable: string; env?: NodeJS.ProcessEnv }> {
  const writer = await resolveLarkParserWriter(config);
  if (!writer) return { executable: await requireLarkCli(config) };
  return { executable: writer.larkCli, env: await larkCliExternalAuthEnvironment() };
}

function asLarkConfig(config: SinkConfig): LarkConfig {
  if (config.type !== 'lark') throw new Error('LarkSink received non-lark config.');
  return config;
}
