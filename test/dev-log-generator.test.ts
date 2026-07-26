import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStarterConfig } from '../src/core/config.js';
import type {
  DevLogWriteTarget,
  ResolvedDevLogCandidate,
  SinkSnapshot,
} from '../src/core/contracts/index.js';
import {
  CodexGenerator,
  devLogMarkdownIssue,
} from '../src/plugins/generators/codex.js';

afterEach(() => {
  delete process.env.FAKE_CODEX_RESPONSE;
  delete process.env.INTERNFLOW_STATE_DIR;
});

describe('dev-log generator guards', () => {
  it('rejects maintenance headings, stale block ids, and untitled core code', () => {
    expect(devLogMarkdownIssue('### 问题索引与维护原则\n内容')).toBe(
      'contains a maintenance-only heading',
    );
    expect(devLogMarkdownIssue('#### 核心实现\n```ts\nconst value = true;\n```')).toBe(
      'contains core code without a meaningful level-five heading',
    );
    expect(devLogMarkdownIssue(
      '#### 核心实现\n##### 状态判断\n```ts\nconst value = true;\n```',
    )).toBeNull();
    expect(devLogMarkdownIssue(
      '#### 需求概览\n<table data-block-id="old"><tr><td>状态</td></tr></table>',
    )).toBe('contains stale remote block identifiers');
  });

  it('rejects a response that omits a required target', async () => {
    const targets: DevLogWriteTarget[] = [
      target('changes', 'requirement', 'append', 'change-log', '##### 2026-07-16｜'),
      target('status', 'overview', 'replace', 'overview-status', '### 1. 当前需求状态'),
    ];
    const run = generatorRun(
      { records: [{ candidateId: 'candidate', targetRef: 'changes', markdown: '##### 2026-07-16｜完成实现' }] },
      candidate(targets),
      {
        headings: [
          heading('changes', 4, '变更记录', 'requirement'),
          heading('status', 3, '1. 当前需求状态', 'overview'),
        ],
      },
    );

    await expect(run).rejects.toThrow('omitted required dev-log targets');
  });

  it('restores unresolved todos omitted by the model', async () => {
    const todos = target(
      'todos',
      'overview',
      'replace',
      'overview-todos',
      '### 3. 待确认事项',
    );
    const result = await generatorRun(
      {
        records: [{
          candidateId: 'candidate',
          targetRef: 'todos',
          markdown: '### 3. 待确认事项\n- 继续确认 REQ-001 的发布状态。',
        }],
      },
      candidate([todos]),
      {
        markdown: '### 3. 待确认事项\n- 继续确认 REQ-001 的发布状态。\n- 确认 Aiden 是否作为 REQ-006 纳入档案。',
        headings: [heading('todos', 3, '3. 待确认事项', 'overview')],
      },
    );

    expect(result.kind).toBe('records');
    if (result.kind !== 'records') return;
    expect(result.records[0]?.markdown).toContain('- 确认 Aiden 是否作为 REQ-006 纳入档案。');
  });
});

async function generatorRun(
  response: unknown,
  resolved: ResolvedDevLogCandidate,
  snapshot: SinkSnapshot,
) {
  const directory = await mkdtemp(join(tmpdir(), 'internflow-dev-log-generator-'));
  const executable = join(directory, 'fake-codex.sh');
  await writeFile(executable, `#!/bin/sh
cat >/dev/null
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output-last-message' ]; then
    printf '%s' "$FAKE_CODEX_RESPONSE" > "$argument"
    break
  fi
  previous="$argument"
done
`);
  await chmod(executable, 0o755);
  process.env.FAKE_CODEX_RESPONSE = JSON.stringify(response);
  process.env.INTERNFLOW_STATE_DIR = join(directory, 'state');
  const config = createStarterConfig();
  const job = config.jobs['dev-log']!;
  return new CodexGenerator().generate({
    jobName: 'dev-log',
    job,
    date: '2026-07-16',
    timezone: config.timezone,
    dryRun: true,
    force: true,
  }, { type: 'codex', executable, model: null }, {
    date: '2026-07-16',
    timezone: config.timezone,
    sourceCount: 1,
    filteredCount: 0,
    activities: [],
    resolvedDevLogCandidates: [resolved],
  }, snapshot);
}

function candidate(writeTargets: DevLogWriteTarget[]): ResolvedDevLogCandidate {
  return {
    id: 'candidate',
    subjectKey: 'subject',
    section: 'requirement',
    operation: 'append',
    title: '接口字段实现',
    status: 'completed',
    facts: ['完成字段实现'],
    files: ['src/api.ts'],
    excerpts: [],
    verificationSummary: 'npm test：通过',
    evidenceIds: ['e1'],
    contentFingerprint: 'fingerprint',
    subjectHeading: 'REQ-001｜接口字段实现',
    allowedTargetRefs: writeTargets.map((item) => item.ref),
    writeTargets,
    routingAssessmentId: 'routing',
  };
}

function target(
  ref: string,
  section: DevLogWriteTarget['section'],
  operation: DevLogWriteTarget['operation'],
  role: DevLogWriteTarget['role'],
  markdownPrefix: string,
): DevLogWriteTarget {
  return {
    ref,
    section,
    operation,
    role,
    required: true,
    markdownPrefix,
    bindSubject: role === 'change-log',
  };
}

function heading(
  ref: string,
  level: number,
  text: string,
  section: NonNullable<ReturnType<typeof target>['section']>,
) {
  return { ref, blockId: ref, level, text, section };
}
