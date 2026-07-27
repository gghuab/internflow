import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  WorkspaceEntry,
  WorkspaceState,
  WorkspaceSubject,
  WorkVerification,
} from '../core/contracts/index.js';

export interface WorkspaceMarkdownViews {
  indexPath: string;
  subjectPaths: string[];
}

export async function writeWorkspaceMarkdownViews(
  directory: string,
  state: WorkspaceState,
): Promise<WorkspaceMarkdownViews> {
  const viewsDirectory = join(directory, 'views');
  const subjectsDirectory = join(viewsDirectory, 'subjects');
  await mkdir(subjectsDirectory, { recursive: true, mode: 0o700 });

  const subjectPaths: string[] = [];
  for (const subject of state.subjects) {
    const path = join(subjectsDirectory, `${subject.id}.md`);
    await atomicWrite(path, renderSubject(state, subject));
    subjectPaths.push(path);
  }

  const indexPath = join(viewsDirectory, 'index.md');
  // 主题文件先写，索引最后写；索引出现时，它引用的本次主题视图已经就绪。
  await atomicWrite(indexPath, renderIndex(state));
  return { indexPath, subjectPaths };
}

function renderIndex(state: WorkspaceState): string {
  const rows = state.subjects.map((subject) => [
    `[${linkText(subject.title)}](subjects/${subject.id}.md)`,
    statusLabel(subject.status),
    subject.lastSeenAt,
    tableCell(subject.repositoryKey),
  ]).map((cells) => `| ${cells.join(' | ')} |`);
  return [
    `# ${heading(state.workspaceId)}`,
    '',
    `- Revision: ${state.revision}`,
    `- Updated: ${state.updatedAt || 'never'}`,
    `- Subjects: ${state.subjects.length}`,
    '',
    '## Subject index',
    '',
    '| Subject | Status | Last updated | Repository |',
    '| --- | --- | --- | --- |',
    ...(rows.length ? rows : ['| No subjects yet | - | - | - |']),
    '',
  ].join('\n');
}

function renderSubject(state: WorkspaceState, subject: WorkspaceSubject): string {
  const entries = state.entries
    .filter((entry) => entry.subjectId === subject.id)
    .sort((left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id));
  return [
    `# ${heading(subject.title)}`,
    '',
    `- Status: ${statusLabel(subject.status)}`,
    `- Repository: ${oneLine(subject.repositoryKey)}`,
    `- First seen: ${subject.firstSeenAt}`,
    `- Last updated: ${subject.lastSeenAt}`,
    ...(subject.branches.length ? [`- Branches: ${subject.branches.map(oneLine).join(', ')}`] : []),
    ...(subject.commits.length ? [`- Commits: ${subject.commits.map(oneLine).join(', ')}`] : []),
    '',
    '## Current view',
    '',
    '### Goal',
    '',
    subject.current.goal || 'No goal recorded.',
    '',
    '### Outcomes',
    '',
    ...list(subject.current.outcomes, 'No outcomes recorded.'),
    '',
    '### Blockers',
    '',
    ...list(subject.current.blockers, 'No blockers.'),
    '',
    '### Latest verification',
    '',
    subject.current.latestVerification || 'No structured verification recorded.',
    '',
    '## Timeline',
    '',
    ...(entries.length ? entries.flatMap(renderEntry) : ['No entries yet.', '']),
  ].join('\n');
}

function renderEntry(entry: WorkspaceEntry): string[] {
  return [
    `### ${entry.date} | ${heading(entry.title)}`,
    '',
    `- Type: ${entry.kind}`,
    `- Status: ${statusLabel(entry.status)}`,
    `- Snapshot: ${oneLine(entry.snapshotId)}`,
    `- Match: ${entry.match.method} (${entry.match.score})`,
    `- Evidence: ${entry.evidenceIds.map(oneLine).join(', ') || 'none'}`,
    '',
    '#### Goal',
    '',
    entry.goal || 'No goal recorded.',
    '',
    '#### Actions',
    '',
    ...list(entry.actions, 'No actions recorded.'),
    '',
    '#### Outcomes',
    '',
    ...list(entry.outcomes, 'No outcomes recorded.'),
    '',
    '#### Decisions',
    '',
    ...list(entry.decisions, 'No decisions recorded.'),
    '',
    '#### Changed files',
    '',
    ...list(entry.changedFiles, 'No changed files recorded.'),
    '',
    '#### Verifications',
    '',
    ...verificationList(entry.verifications),
    '',
    '#### Blockers',
    '',
    ...list(entry.blockers, 'No blockers.'),
    '',
  ];
}

function verificationList(values: WorkVerification[]): string[] {
  if (!values.length) return ['No structured verification recorded.'];
  return values.map((item) => (
    `- ${oneLine(item.command)}: ${item.outcome}${item.exitCode === null ? '' : ` (exit ${item.exitCode})`}`
  ));
}

function list(values: string[], empty: string): string[] {
  return values.length ? values.map((value) => `- ${oneLine(value)}`) : [empty];
}

function statusLabel(status: WorkspaceSubject['status']): string {
  return {
    completed: 'completed',
    in_progress: 'in progress',
    blocked: 'blocked',
    investigated: 'investigated',
  }[status];
}

function heading(value: string): string {
  return oneLine(value).replace(/^#+\s*/, '') || 'Untitled';
}

function tableCell(value: string): string {
  return oneLine(value).replace(/\|/g, '\\|');
}

function linkText(value: string): string {
  return tableCell(value).replace(/([\[\]])/g, '\\$1');
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${content.trimEnd()}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
