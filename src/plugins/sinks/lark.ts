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
    const executable = await requireLarkCli(lark);
    const markdown = lark.reader === 'larkparser'
      ? await fetchDocumentWithLarkParser(lark)
      : (await fetchDocument(executable, lark, 'full', 'markdown')).content;
    const outline = await fetchDocument(executable, lark, 'outline', 'xml');
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
    const executable = await requireLarkCli(lark);
    if (lark.mode === 'append') {
      if (artifact.kind !== 'markdown') throw new Error('Lark append mode requires a Markdown artifact.');
      const current = await fetchDocument(executable, lark, 'outline', 'xml');
      if (!context.dryRun) {
        await updateDocument(
          executable,
          lark,
          'append',
          '',
          prepareLarkMarkdown(artifact.markdown),
          current.revisionId,
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
        await replaceDocument(executable, lark, context, combined);
      }
      return {
        sink: this.name,
        mode: lark.mode,
        applied: !context.dryRun,
        reportCount: (combined.match(/^# \d{4}-\d{2}-\d{2}$/gm) || []).length,
      };
    }

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
      if (!heading || heading.level < 2 || heading.level > 4 || heading.section !== record.section) {
        throw new Error(`Unknown or mismatched heading ref: ${record.targetRef}`);
      }
      return { record, heading };
    });

    // 生成期间文档可能被人工编辑。首次写入前重新校验标题，避免旧引用写到错误章节。
    const currentOutline = await fetchDocument(executable, lark, 'outline', 'xml');
    assertHeadingsUnchanged(snapshot.headings, parseOutline(currentOutline.content));

    const prepared = [];
    for (const { record, heading } of resolvedRecords) {
      const section = await fetchSection(executable, lark, heading.blockId);
      prepared.push({
        record,
        heading,
        anchorBlockId: lastBlockId(section.content, heading.blockId),
        revisionId: section.revisionId,
      });
    }

    const updates: Array<Record<string, unknown>> = [];
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index];
      if (!item) continue;
      const { record, heading } = item;
      const section = index === 0 || context.dryRun
        ? { revisionId: item.revisionId, anchorBlockId: item.anchorBlockId }
        : await fetchSectionAnchor(executable, lark, heading.blockId);
      const response = !context.dryRun
        ? await updateDocument(
          executable,
          lark,
          'block_insert_after',
          section.anchorBlockId,
          prepareLarkMarkdown(record.markdown),
          section.revisionId,
        )
        : null;
      updates.push({
        targetRef: record.targetRef,
        anchorBlockId: section.anchorBlockId,
        applied: !context.dryRun,
        response,
      });
    }
    return { sink: this.name, mode: lark.mode, updates };
  }

  async doctor(config: SinkConfig): Promise<{ ok: boolean; message: string }> {
    const lark = asLarkConfig(config);
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
      input: chunk,
      timeoutMs: 5 * 60_000,
      sensitiveOutput: true,
    });
    const response = parseResponse(result.stdout, command);
    if (!response.ok || response.data?.result !== 'success') {
      throw new Error(`Lark ${command} failed: ${JSON.stringify(response.error || response)}`);
    }
  }
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
  return markdown.replace(
    /^```mermaid[\t ]*\r?\n([\s\S]*?)^```[\t ]*$/gim,
    (_match, source: string) => `<whiteboard type="mermaid">\n${escapeXmlText(source.trim())}\n</whiteboard>`,
  );
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
  ], { timeoutMs: 3 * 60_000 });
  return documentFromResponse(result.stdout, `fetch ${scope}`);
}

async function fetchSection(
  executable: string,
  config: LarkConfig,
  headingId: string,
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
  ], { timeoutMs: 3 * 60_000 });
  return documentFromResponse(result.stdout, `fetch section ${headingId}`);
}

async function updateDocument(
  executable: string,
  config: LarkConfig,
  command: 'append' | 'block_insert_after',
  blockId: string,
  content: string,
  revisionId: number,
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
  args.push(
    '--doc-format',
    'markdown',
    '--content',
    '-',
    '--revision-id',
    String(revisionId),
    '--as',
    config.identity,
  );
  const result = await runCommand(executable, args, {
    input: content,
    timeoutMs: 5 * 60_000,
    sensitiveOutput: true,
  });
  const response = parseResponse(result.stdout, `update ${command}`);
  if (!response.ok || response.data?.result !== 'success') {
    throw new Error(`Lark ${command} failed: ${JSON.stringify(response.error || response)}`);
  }
  return response;
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
  const ids = [...xml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1] || '');
  if (!ids.length || ids[0] !== headingId) throw new Error(`Cannot resolve section end for ${headingId}.`);
  return ids.at(-1) || headingId;
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

async function fetchSectionAnchor(
  executable: string,
  config: LarkConfig,
  headingId: string,
): Promise<{ anchorBlockId: string; revisionId: number }> {
  const section = await fetchSection(executable, config, headingId);
  return {
    anchorBlockId: lastBlockId(section.content, headingId),
    revisionId: section.revisionId,
  };
}

function sectionFromText(
  text: string,
  current: HeadingReference['section'],
): HeadingReference['section'] {
  if (/^一、(?:需求开发档案|需求开发记录)/.test(text)) return 'requirement';
  if (/^二、(?:问题定位与修复记录|联调问题与 Bug Fix 汇总)/.test(text)) return 'bugfix';
  if (/^三、(?:工程方法与知识沉淀|个人沉淀)/.test(text)) return 'insight';
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

function asLarkConfig(config: SinkConfig): LarkConfig {
  if (config.type !== 'lark') throw new Error('LarkSink received non-lark config.');
  return config;
}
