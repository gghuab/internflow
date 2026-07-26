import { z } from 'zod';
import type { ActivityBatch, PeriodEntry, PeriodGroup, PeriodReportView } from '../../core/contracts/index.js';

export const periodDraftSchema = z.strictObject({
  title: z.string().min(1).max(120),
  overview: z.string().min(1).max(2_000),
  groups: z.array(z.strictObject({
    groupId: z.string().min(1),
    title: z.string().min(1).max(120),
    summary: z.string().min(1).max(2_000),
    highlights: z.array(z.string().min(1).max(500)).max(8),
  })).max(100),
  risks: z.array(z.string().min(1).max(500)).max(20),
  nextActions: z.array(z.string().min(1).max(500)).max(20),
});

export type PeriodDraft = z.infer<typeof periodDraftSchema>;

export const periodDraftJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'overview', 'groups', 'risks', 'nextActions'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    overview: { type: 'string', minLength: 1, maxLength: 2000 },
    groups: {
      type: 'array', maxItems: 100,
      items: {
        type: 'object', additionalProperties: false,
        required: ['groupId', 'title', 'summary', 'highlights'],
        properties: {
          groupId: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1, maxLength: 120 },
          summary: { type: 'string', minLength: 1, maxLength: 2000 },
          highlights: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    risks: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 500 } },
    nextActions: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 500 } },
  },
} as const;

export function periodReportPrompt(batch: ActivityBatch): string {
  const view = requireView(batch);
  return [
    `你在生成 Codex ${view.unit === 'week' ? '周报' : '月报'}的叙事层。`,
    '只能使用输入事实，不得补写未发生的工作。每个 groupId 必须且只能出现一次。',
    'title 用简洁工作主题重新命名，禁止直接复制用户问题；summary 总结目标、推进和结果；highlights 只选最重要的事实。风险与后续动作没有依据时返回空数组。',
    '日期、模块范围和验证概况由本地确定性渲染器补齐，不要为了简短而删除工作组。',
    view.quality.coverage !== 'high'
      ? `数据质量为 ${view.quality.coverage}：${view.quality.reasons.join('；') || '部分工作日降级纳入'}。overview 中需简要说明。`
      : '全部工作日均为 high coverage。',
    JSON.stringify(compactPeriodView(view)),
  ].join('\n\n');
}

/** 模型只需要叙事摘要；完整 entry/文件/会话 id 留在本地渲染。 */
export function compactPeriodView(view: PeriodReportView) {
  return {
    unit: view.unit,
    startDate: view.startDate,
    endDate: view.endDate,
    dates: view.dates,
    quality: view.quality,
    groups: view.groups.map((group) => ({
      groupId: group.id,
      title: group.title,
      repositoryKey: group.repositoryKey,
      branch: group.branch,
      status: group.status,
      dates: group.dates,
      factCount: group.factCount,
      modules: moduleScopes(group.entries.flatMap((entry) => entry.changedFiles)),
      verification: verificationSummary(group.entries.flatMap((entry) => entry.verifications)),
      blockers: [...new Set(group.entries.flatMap((entry) => entry.blockers))].slice(0, 6),
      days: group.entries.map((entry) => ({
        date: entry.date,
        title: entry.title,
        goal: entry.goal,
        status: entry.status,
        outcomes: conciseOutcomes(entry.outcomes).slice(0, 3),
        decisions: entry.decisions.slice(0, 2),
      })),
    })),
  };
}

export function validatePeriodDraft(view: PeriodReportView, draft: PeriodDraft): PeriodDraft {
  const expected = new Set(view.groups.map((group) => group.id));
  const seen = new Set<string>();
  for (const group of draft.groups) {
    if (!expected.has(group.groupId) || seen.has(group.groupId)) {
      throw new Error(`Period draft cites an unknown or repeated group: ${group.groupId}.`);
    }
    seen.add(group.groupId);
  }
  if (seen.size !== expected.size) {
    throw new Error(`Period draft omitted ${expected.size - seen.size} work group(s).`);
  }
  return draft;
}

export function buildFallbackPeriodReport(batch: ActivityBatch): string {
  const view = requireView(batch);
  return renderPeriodReport(batch, {
    title: `Codex ${view.unit === 'week' ? '周报' : '月报'} ${view.startDate} 至 ${view.endDate}`,
    overview: [
      `本周期覆盖 ${view.dates.length} 个工作日、${view.groups.length} 组工作。`,
      view.quality.coverage === 'high'
        ? '全部来自 finalized 的逐日事实账本。'
        : `数据质量 ${view.quality.coverage}：${view.quality.reasons.slice(0, 3).join('；') || '部分工作日降级纳入'}。`,
    ].join(''),
    groups: view.groups.map((group) => ({
      groupId: group.id,
      title: group.title,
      summary: conciseOutcomes(group.entries.flatMap((entry) => entry.outcomes))[0]
        || `${group.title}，当前状态：${statusText(group.status)}。`,
      highlights: conciseOutcomes(group.entries.flatMap((entry) => entry.outcomes)).slice(1, 4),
    })),
    risks: [...new Set(view.groups.flatMap((group) => group.entries.flatMap((entry) => entry.blockers)))],
    nextActions: [],
  });
}

export function renderPeriodReport(batch: ActivityBatch, draft: PeriodDraft): string {
  const view = requireView(batch);
  const narratives = new Map(draft.groups.map((group) => [group.groupId, group]));
  const lines = [`# ${draft.title}`, '', draft.overview, ''];
  for (const group of view.groups) {
    const narrative = narratives.get(group.id);
    lines.push(`## ${narrative?.title || group.title}`, '', narrative?.summary || group.entries.at(-1)?.goal || group.title, '');
    if (narrative?.highlights.length) {
      lines.push('**重点结果**', ...narrative.highlights.map((item) => `- ${item}`), '');
    }
    lines.push('**推进记录**');
    for (const entry of group.entries) {
      const outcome = conciseOutcomes(entry.outcomes)[0];
      lines.push(`- ${entry.date}：${outcome || statusText(entry.status)}`);
    }
    const scopes = moduleScopes(group.entries.flatMap((entry) => entry.changedFiles));
    if (scopes.length) lines.push('', `**涉及模块**：${scopes.join('、')}`);
    lines.push(`**验证情况**：${verificationSummary(group.entries.flatMap((entry) => entry.verifications))}`);
    lines.push('');
  }
  if (draft.risks.length) lines.push('## 风险与阻塞', '', ...draft.risks.map((item) => `- ${item}`), '');
  if (draft.nextActions.length) lines.push('## 下一步', '', ...draft.nextActions.map((item) => `- ${item}`), '');
  lines.push(`> 数据口径：${view.startDate} 至 ${view.endDate}，${view.snapshotIds.length} 份 finalized 快照，${view.groups.reduce((sum, group) => sum + group.factCount, 0)} 条引用事实，质量 ${view.quality.coverage}。`);
  return `${lines.join('\n').trim()}\n`;
}

function requireView(batch: ActivityBatch): PeriodReportView {
  if (!batch.periodView) throw new Error('Period report requires a PeriodReportView.');
  return batch.periodView;
}

function conciseOutcomes(values: string[]): string[] {
  const command = /^(?:git|npm|npx|pnpm|yarn|emo|node|bash|sh|set|cd|cat|rg|find|jq|curl)\b/i;
  return [...new Set(values.map((value) => value.trim()))]
    .filter((value) => value.length >= 4 && value.length <= 220 && !command.test(value));
}

function moduleScopes(files: string[]): string[] {
  return [...new Set(files.map((file) => {
    const parts = file.split('/').filter(Boolean);
    if (!parts.length || parts[0] === 'tmp' || file.includes('${')) return '';
    const src = parts.indexOf('src');
    const app = parts[0] === 'apps' ? parts[1] : undefined;
    const folders = (src >= 0
      ? parts.slice(src + 1, -1)
      : app ? parts.slice(2, -1) : parts.slice(0, -1)).slice(0, 3).join('/')
      || parts.at(-1)?.replace(/\.[^.]+$/, '');
    return [app, folders].filter(Boolean).join(': ');
  }).filter(Boolean))].slice(0, 6);
}

export function verificationSummary(
  verifications: PeriodEntry['verifications'],
): string {
  if (!verifications.length) return '未记录独立验证命令';
  let passed = 0;
  let failed = 0;
  let unknown = 0;
  for (const item of verifications) {
    if (item.outcome === 'passed') passed += 1;
    else if (item.outcome === 'failed') failed += 1;
    else unknown += 1;
  }
  const parts = [
    passed ? `通过 ${passed}` : '',
    failed ? `失败 ${failed}` : '',
    unknown ? `未决 ${unknown}` : '',
  ].filter(Boolean);
  return `共 ${verifications.length} 项（${parts.join(' / ')}）`;
}

function statusText(status: PeriodGroup['status']): string {
  return ({
    completed: '已完成',
    in_progress: '持续推进中',
    blocked: '存在阻塞',
    investigated: '已完成分析',
  } as const)[status];
}
