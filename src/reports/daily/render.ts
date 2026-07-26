import type { ActivityBatch } from '../../core/contracts/index.js';
import type { WorkItem } from '../../work-items/types.js';
import type { DailyDraft } from './schema.js';
import type { DailyReportView } from './types.js';

export function validateDailyDraft(view: DailyReportView, draft: DailyDraft): DailyDraft {
  const items = new Map(view.items.map((item) => [item.id, item]));
  const todayIds = draft.today.flatMap((entry) => [entry.workItemId, ...entry.relatedWorkItemIds]);
  if (new Set(todayIds).size !== todayIds.length) throw new Error('Daily draft contains duplicate Today work items.');
  const missing = view.items.filter((item) => !todayIds.includes(item.id));
  if (missing.length) throw new Error(`Daily draft omitted reportable work items: ${missing.map((item) => item.id).join(', ')}.`);
  for (const entry of draft.today) {
    const groupedItems = [entry.workItemId, ...entry.relatedWorkItemIds].map((id) => items.get(id));
    if (groupedItems.some((item) => !item)) {
      throw new Error(`Daily draft cites unknown work item in Today group ${entry.workItemId}.`);
    }
    const allowed = new Set(groupedItems.flatMap((item) => item?.evidenceIds || []));
    for (const id of entry.evidenceIds) {
      if (!allowed.has(id)) throw new Error(`Daily draft cites evidence ${id} outside work item group ${entry.workItemId}.`);
    }
  }
  for (const entry of [...draft.deepDives, ...draft.takeaways]) {
    const item = items.get(entry.workItemId);
    if (!item) throw new Error(`Daily draft cites unknown work item ${entry.workItemId}.`);
    const todayGroup = draft.today.find((value) => (
      value.workItemId === item.id || value.relatedWorkItemIds.includes(item.id)
    ));
    const groupedItems = todayGroup
      ? [todayGroup.workItemId, ...todayGroup.relatedWorkItemIds].map((id) => items.get(id))
      : [item];
    const allowed = new Set(groupedItems.flatMap((value) => value?.evidenceIds || []));
    for (const id of entry.evidenceIds) {
      if (!allowed.has(id)) throw new Error(`Daily draft cites evidence ${id} outside work item group ${item.id}.`);
    }
  }
  for (const suggestion of draft.suggestions) {
    if (suggestion.workItemId && !items.has(suggestion.workItemId)) {
      throw new Error(`Daily suggestion cites unknown work item ${suggestion.workItemId}.`);
    }
  }
  for (const diagram of draft.diagrams) {
    if (diagram.workItemId && !items.has(diagram.workItemId)) {
      throw new Error(`Daily diagram cites unknown work item ${diagram.workItemId}.`);
    }
    if (!sanitizeMermaid(diagram.mermaid)) {
      throw new Error(`Daily diagram "${diagram.title}" contains unsupported mermaid content.`);
    }
    const plan = view.visualPlan.find((value) => (
      value.workItemId === diagram.workItemId && value.assessmentId === diagram.assessmentId
    ));
    if (!plan || plan.mode === 'inline') {
      throw new Error(`Daily diagram "${diagram.title}" is outside the approved visual plan.`);
    }
    if (!diagramMatchesMode(diagram.mermaid, plan.mode)) {
      throw new Error(`Daily diagram "${diagram.title}" does not match visual mode ${plan.mode}.`);
    }
  }
  const expected = view.visualPlan.filter((item) => item.mode !== 'inline');
  const missingDiagrams = expected.filter((plan) => !draft.diagrams.some((diagram) => (
    diagram.workItemId === plan.workItemId && diagram.assessmentId === plan.assessmentId
  )));
  if (missingDiagrams.length) throw new Error('Daily draft omitted approved visual plan items.');
  return {
    ...draft,
    diagrams: draft.diagrams.map((diagram) => ({
      ...diagram,
      mermaid: sanitizeMermaid(diagram.mermaid) || diagram.mermaid,
    })),
  };
}

/** 保留原日报五段结构，只丰富每段中的叙事、验证和流程图。 */
export function renderDailyReport(batch: ActivityBatch, view: DailyReportView, draft: DailyDraft): string {
  const qualityNote = view.quality.coverage === 'high'
    ? ''
    : view.quality.reasons.length
      ? ` 注意：${view.quality.reasons.join('，')}，部分细节可能不完整。`
      : ' 注意：数据覆盖率不完整。';
  // 飞书标题后空行会渲染成明显空白块；标题与正文之间不插空行。
  return compactSections(`# ${batch.date} 工作日报
${renderAudit(batch, view)}

> ${draft.headline}

${draft.overview}${qualityNote}

${renderGlobalDiagrams(draft)}

## 1. 今日工作
${renderToday(view, draft)}

## 2. 重点任务
${renderLongest(view, draft)}

## 3. 技术沉淀
${renderDeepDives(draft)}

## 4. 方法总结
${renderTakeaways(draft)}

## 5. 下一步
${renderSuggestions(draft)}
`);
}

function renderAudit(batch: ActivityBatch, view: DailyReportView): string {
  return `---
- 目标日期：${batch.date}
- 原始会话数：${batch.sourceSessionCount ?? batch.sourceCount}
- 有效会话数：${batch.sessionCount ?? batch.activities.length}
- 过滤会话数：${batch.filteredSessionCount ?? batch.filteredCount}
- 数据完整度：${view.quality.coverage}${view.quality.reasons.length ? `（${view.quality.reasons.join('；')}）` : ''}
- 生成时间：${batch.generatedAt || new Date().toISOString()}
---`;
}

function compactSections(markdown: string): string {
  return String(markdown || '')
    .replace(/\r\n/g, '\n')
    // 标题后空行在飞书会渲染成空白块。
    .replace(/^(#{1,6}\s+[^\n]+)\n+/gm, '$1\n')
    .replace(/^(\*\*[^*\n]+\*\*)\n+/gm, '$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

export function fallbackDailyDraft(view: DailyReportView): DailyDraft {
  const today = view.items.map((item) => ({
    workItemId: item.id,
    relatedWorkItemIds: [],
    title: item.title,
    background: item.goal || item.title,
    story: fallbackStory(item),
    result: primaryResult(item),
    openQuestions: item.blockers.join('；') || (item.status === 'in_progress' || item.status === 'blocked'
      ? '仍需继续推进并补齐验证闭环。'
      : ''),
    evidenceIds: item.evidenceIds.slice(0, 20),
  }));
  const highlights = today.slice(0, 3).map((item) => item.title);
  const counts = statusCounts(view.items);
  const statusParts = [
    counts.completed ? `完成 ${counts.completed} 项` : '',
    counts.investigated ? `完成分析 ${counts.investigated} 项` : '',
    counts.in_progress ? `推进中 ${counts.in_progress} 项` : '',
    counts.blocked ? `阻塞 ${counts.blocked} 项` : '',
  ].filter(Boolean);
  return {
    headline: highlights.length ? `今日主线：${highlights.join('、')}` : '当天没有可汇报工作项',
    overview: view.items.length
      ? `今天共记录 ${view.items.length} 项工作，${statusParts.join('，') || '状态待确认'}。${highlights.length ? `重点包括 ${highlights.join('、')}。` : ''}本草稿由本地事实回退生成，建议正式同步前再人工润色叙事。`
      : '当天没有可汇报工作项，可能是会话被过滤、证据不足，或当天确实没有可追溯交付。',
    today,
    deepDives: [],
    takeaways: [],
    diagrams: [],
    suggestions: [{
      workItemId: null,
      text: view.items.length ? '为进行中的工作补充明确验证闭环。' : '确认当天是否有被过滤的有效会话。',
      why: view.items.length ? '当前回退草稿只能保证事实覆盖，验证闭环仍需补齐。' : '避免漏记真实工作。',
    }],
    agentCandidates: [],
  };
}

function renderGlobalDiagrams(draft: DailyDraft): string {
  return draft.diagrams.filter((diagram) => !diagram.workItemId)
    .map((diagram) => renderDiagram(diagram.title, diagram.mermaid)).join('\n\n');
}

function renderToday(view: DailyReportView, draft: DailyDraft): string {
  if (!draft.today.length) return '- 无可汇报工作项';
  const items = new Map(view.items.map((item) => [item.id, item]));
  const sections = draft.today.map((entry) => {
    const groupedItems = [entry.workItemId, ...entry.relatedWorkItemIds]
      .map((id) => items.get(id))
      .filter((item): item is WorkItem => Boolean(item));
    const item = groupedItems[0];
    if (!item) return '';
    const files = unique(groupedItems.flatMap((value) => value.changes.flatMap((change) => change.files)));
    const statuses = groupedItems.map((value) => value.status);
    const status = statuses.includes('blocked')
      ? 'blocked'
      : statuses.includes('in_progress')
        ? 'in_progress'
        : statuses.every((value) => value === 'investigated')
          ? 'investigated'
          : 'completed';
    const lines = [
      `### ${entry.title}`,
      `- **状态与投入**：${statusLabel(status)}${groupedItems.length > 1 ? `，合并 ${groupedItems.length} 项关联工作` : item.activeMinutes === null ? '' : `，目标日期内累计约 ${item.activeMinutes} 分钟`}`,
      `- **背景与目标**：${entry.background}`,
      '- **推进过程**',
      ...storyBullets(entry.story),
      `- **结果**：${entry.result}`,
    ];
    const inlineItems = groupedItems.filter((value) => view.visualPlan.some((plan) => plan.workItemId === value.id && plan.mode === 'inline'));
    if (inlineItems.length) lines.push(`- **简要图示**：${inlineItems.map(inlineDiagram).join('；')}`);
    if (files.length) lines.push(`- **改动范围**：${fileScopeSummary(files)}`);
    lines.push(`- **验证情况**：${verificationDetail(groupedItems)}`);
    const blockers = groupedItems.flatMap((value) => value.blockers);
    if (entry.openQuestions.trim() || blockers.length) {
      lines.push(`- **未闭环**：${entry.openQuestions.trim() || summarize(blockers, 5, 220)}`);
    }
    const groupedIds = new Set(groupedItems.map((value) => value.id));
    for (const diagram of draft.diagrams.filter((value) => value.workItemId && groupedIds.has(value.workItemId))) {
      lines.push('', renderDiagram(diagram.title, diagram.mermaid));
    }
    return lines.join('\n');
  }).filter(Boolean);
  // 飞书会折叠普通 Markdown 空行；显式空段落让相邻工作项保持一行呼吸空间。
  return sections.join('\n\n<p><br/></p>\n\n');
}

function renderLongest(view: DailyReportView, draft: DailyDraft): string {
  const item = view.items.find((value) => value.id === view.longestWorkItemId)
    || view.items.find((value) => view.longestTiedIds.includes(value.id)) || view.items[0];
  if (!item) return '| 任务 | 为什么耗时 | 产出 | 当前状态 |\n|---|---|---|---|\n| 无可靠最长任务统计 | 当天没有可汇报工作项 | 无 | 待确认 |';
  const narrative = draft.today.find((value) => (
    value.workItemId === item.id || value.relatedWorkItemIds.includes(item.id)
  ));
  const title = narrative?.title || item.title;
  const reason = narrative?.background || view.longestReason || '按可靠活跃时长选择';
  const result = narrative?.result || primaryResult(item);
  return [
    '| 任务 | 为什么耗时 | 产出 | 当前状态 |',
    '|---|---|---|---|',
    `| ${escapeCell(title)} | ${escapeCell(`${reason}${item.activeMinutes === null ? '' : `；累计约 ${item.activeMinutes} 分钟`}`)} | ${escapeCell(result)} | ${statusLabel(item.status)} |`,
  ].join('\n');
}

function renderDeepDives(draft: DailyDraft): string {
  const rows = draft.deepDives.map((item) => `| ${escapeCell(item.knowledge)} | ${escapeCell(item.background)} | ${escapeCell(item.mechanism)} | ${escapeCell(item.defaultAction)} | ${escapeCell(item.verification)} | ${escapeCell(item.antiPattern)} |`);
  return ['| 知识点 | 现象或背景 | 底层机制或原因 | 默认做法 | 验证方式 | 反模式或易错点 |', '|---|---|---|---|---|---|', ...(rows.length ? rows : ['| 无 | 无 | 无 | 无 | 无 | 无 |'])].join('\n');
}

function renderTakeaways(draft: DailyDraft): string {
  const rows = draft.takeaways.map((item) => `| ${escapeCell(item.method)} | ${escapeCell(item.keyPoint)} | ${escapeCell(item.defaultAction)} | ${escapeCell(item.verification)} | ${escapeCell(item.antiPattern)} |`);
  return ['| 方法 | 要点 | 默认动作 | 验证 | 反模式 |', '|---|---|---|---|---|', ...(rows.length ? rows : ['| 无 | 无 | 无 | 无 | 无 |'])].join('\n');
}

function renderSuggestions(draft: DailyDraft): string {
  return draft.suggestions.map((item) => `- ${escapeInline(item.text)}${item.why.trim() ? `（${item.why.trim()}）` : ''}`).join('\n') || '- 暂无明确下一步';
}

function renderDiagram(title: string, mermaid: string): string {
  const body = sanitizeMermaid(mermaid);
  // 小标题后不插空行，避免飞书多出空白块。
  return body ? [`**${escapeInline(title)}**`, '```mermaid', body, '```'].join('\n') : '';
}

function sanitizeMermaid(value: string): string | null {
  let text = String(value || '').replace(/\r\n/g, '\n').trim();
  text = text.replace(/^```(?:mermaid)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!text || /<|javascript:|click\s+/i.test(text)) return null;
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
  if (!/^(flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?)\b/i.test(first)) return null;
  return text.split('\n').slice(0, 40).map((line) => line.replace(/\s+$/g, '')).join('\n').trim() || null;
}

function diagramMatchesMode(mermaid: string, mode: 'flowchart' | 'sequence' | 'state'): boolean {
  const first = mermaid.trim().split('\n')[0] || '';
  if (mode === 'sequence') return /^sequenceDiagram\b/i.test(first);
  if (mode === 'state') return /^stateDiagram(?:-v2)?\b/i.test(first);
  return /^(?:flowchart|graph)\b/i.test(first);
}

function inlineDiagram(item: WorkItem): string {
  const narrativeSteps = unique([...item.actions, ...item.outcomes])
    .map((value) => value.replace(/[。；;]+$/g, '').trim())
    .filter(isInlineVisualStep);
  const anchor = [item.goal, item.title].find(isInlineVisualStep) || '明确任务目标';
  const steps = unique([
    ...narrativeSteps,
    anchor,
    deliveryStep(item),
    closureStep(item),
  ]).map((value) => compactInline(value, 28)).slice(0, 3);
  return steps.join(' → ');
}

/** 行内图只保留业务动作；原始路径和命令属于证据，不应成为读图节点。 */
function isInlineVisualStep(value: string): boolean {
  const text = String(value || '').trim();
  if (!isReadableNarrative(text)) return false;
  if (/(?:^|[：:；;]\s*)(?:git|npm|npx|pnpm|yarn|emo|node|bash|sh|set|cd|cat|rg|find|jq|curl)\b/i.test(text)) {
    return false;
  }
  if (/(?:^|\s)(?:\/Users\/|(?:apps|src|test|tests|config|docs)\/)[^\s；;]+/i.test(text)) return false;
  return !/(?:^|\s)[^\s；;]+\.(?:ts|tsx|js|jsx|json|go|py|rs|java|kt|swift|yaml|yml|toml|md)\b/i.test(text);
}

function deliveryStep(item: WorkItem): string {
  if (item.kind === 'research') return '完成分析判断';
  if (item.kind === 'bugfix') return '完成问题修复';
  if (item.kind === 'tooling') return '完成工具调整';
  if (item.kind === 'docs') return '完成文档整理';
  return item.changes.length ? '完成实现调整' : '形成处理方案';
}

function closureStep(item: WorkItem): string {
  if (item.verifications.some((value) => value.outcome === 'failed')) return '发现验证问题';
  if (item.verifications.some((value) => value.outcome === 'passed')) return '验证通过';
  if (item.status === 'blocked') return '等待阻塞解除';
  if (item.status === 'in_progress') return '继续推进闭环';
  if (item.status === 'investigated') return '形成分析结论';
  return '形成交付结果';
}

function storyBullets(story: string): string[] {
  const parts = String(story || '').split(/\n+|(?<=[。！？；])/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return ['  - 暂无详细推进过程'];
  return parts.map((part) => `  - ${part}`);
}

function fallbackStory(item: WorkItem): string {
  return [
    item.goal ? `围绕“${item.goal}”推进。` : '',
    ...item.actions.slice(0, 3).map((action) => `${action}。`),
    ...item.outcomes.slice(0, 2).map((outcome) => `结果：${outcome}。`),
    item.blockers[0] ? `当前仍有阻塞：${item.blockers[0]}。` : '',
  ].filter(Boolean).join('') || `${item.title} 已记录，但缺少更细的推进描述。`;
}

function primaryResult(item: WorkItem): string {
  return compactInline(item.outcomes.find(isReadableNarrative) || item.goal || item.title || '暂无明确结果', 220);
}

function isReadableNarrative(value: string): boolean {
  const text = String(value || '').trim();
  return text.length >= 4 && !/^(?:git|npm|npx|pnpm|yarn|emo|node|bash|sh|set|cd|cat|rg|find|jq|curl)\b/i.test(text);
}

function verificationDetail(items: WorkItem[]): string {
  const verifications = items.flatMap((item) => item.verifications);
  if (!verifications.length) return '未记录独立验证命令';
  const checks = unique(verifications.map((verification) => verificationType(verification.command)));
  const counts = { passed: 0, failed: 0, unknown: 0 };
  for (const verification of verifications) counts[verification.outcome] += 1;

  const parts = [
    counts.passed ? `${counts.passed} 项通过` : '',
    counts.failed ? `${counts.failed} 项失败` : '',
    counts.unknown ? `${counts.unknown} 项未确认` : '',
  ].filter(Boolean);

  const conclusion = counts.failed > 0
    ? '，需要确认失败是本次改动引入还是存量问题'
    : counts.unknown > 0
      ? '，部分检查没有记录到最终结果'
      : '，验证已通过';

  return `执行了${checks.join('、')}，${parts.join('、')}${conclusion}`;
}

function verificationType(command: string): string {
  if (/\b(?:tsc|typecheck)\b/i.test(command)) return '类型检查';
  if (/\b(?:eslint|lint)\b/i.test(command)) return 'Lint';
  if (/\b(?:prettier|format)\b/i.test(command)) return '格式化检查';
  if (/\b(?:vitest|jest|pytest|test)\b/i.test(command)) return '测试';
  if (/\bbuild\b/i.test(command)) return '构建';
  if (/git\s+diff\s+--check/i.test(command)) return '差异检查';
  if (/JSON\.parse/i.test(command)) return 'JSON 配置检查';
  return '其他检查';
}

function fileScopeSummary(files: string[]): string {
  const groups = new Map<string, { directories: string[]; count: number }>();
  for (const file of files) {
    const parts = file.split('/').filter(Boolean);
    const appIndex = parts.indexOf('apps');
    const isAbsoluteUserPath = parts[0] === 'Users';
    const app = appIndex >= 0 && parts[appIndex + 1]
      ? parts[appIndex + 1]!
      : isAbsoluteUserPath ? '本机配置' : '项目';
    const srcIndex = parts.indexOf('src');
    const relative = srcIndex >= 0
      ? parts.slice(srcIndex + 1)
      : isAbsoluteUserPath ? parts.slice(-2) : parts.slice(appIndex >= 0 ? appIndex + 2 : 0);
    const directory = relative.slice(0, -1).slice(0, 3).join('/')
      || relative.at(-1)?.replace(/\.[^.]+$/, '')
      || '根目录';
    const group = groups.get(app) || { directories: [], count: 0 };
    group.directories.push(directory);
    group.count += 1;
    groups.set(app, group);
  }
  return [...groups.entries()].map(([app, group]) => {
    const scopes = unique(group.directories);
    const shown = scopes.slice(0, 5);
    const omitted = scopes.length - shown.length;
    return `${app}：${shown.join('、')}${omitted > 0 ? `等 ${scopes.length} 个模块` : ''}（${group.count} 个文件）`;
  }).join('；');
}

function statusCounts(items: WorkItem[]) {
  const counts = { completed: 0, in_progress: 0, blocked: 0, investigated: 0 };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

function summarize(values: string[], limit: number, maxLength: number): string {
  const distinct = unique(values.map((value) => compactInline(value, maxLength)));
  const shown = distinct.slice(0, limit);
  return `${shown.join('；')}${distinct.length > shown.length ? `；另 ${distinct.length - shown.length} 项` : ''}`;
}

function compactInline(value: string, maxLength: number): string {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

function statusLabel(status: WorkItem['status']): string {
  return ({ completed: '已完成', in_progress: '进行中', blocked: '阻塞', investigated: '已分析' } as const)[status];
}

function escapeInline(value: string): string { return String(value || '').replace(/\r?\n/g, ' ').trim(); }

function escapeCell(value: string): string { return escapeInline(value).replace(/\|/g, '\\|'); }
