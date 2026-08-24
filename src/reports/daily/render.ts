import type { ActivityBatch } from '../../core/contracts/index.js';
import type { WorkItem } from '../../work-items/types.js';
import type { DailyDraft } from './schema.js';
import type { DailyReportView } from './types.js';
import { hasDeliveryRecord, manualValidationFacts } from './view.js';

const DELIVERY_PATTERN = /提交|推送|commit|push|PR\b|MR\b|合入|发布|交付/i;
const DIALOGUE_NOISE_PATTERN = /^(?:你说得对|你的理解|我先|我会|我正在|我们先|下面先|接下来|最后我|好的|可以的|没问题|让我们|大概率|先给结论|结论[:：]|对[，,。]|有[，,])/;

export function validateDailyDraft(view: DailyReportView, draft: DailyDraft): DailyDraft {
  const items = new Map(view.items.map((item) => [item.id, item]));
  const presentation = new Map(view.presentationPlan.map((item) => [item.workItemId, item.detailLevel]));
  const todayIds = draft.today.flatMap((entry) => [entry.workItemId, ...entry.relatedWorkItemIds]);
  if (new Set(todayIds).size !== todayIds.length) throw new Error('Daily draft contains duplicate Today work items.');
  const missing = view.items.filter((item) => !todayIds.includes(item.id));
  if (missing.length) throw new Error(`Daily draft omitted reportable work items: ${missing.map((item) => item.id).join(', ')}.`);

  for (const entry of draft.today) {
    const groupIds = [entry.workItemId, ...entry.relatedWorkItemIds];
    const groupedItems = groupIds.map((id) => items.get(id));
    if (groupedItems.some((item) => !item)) {
      throw new Error(`Daily draft cites unknown work item in Today group ${entry.workItemId}.`);
    }
    const missingPlan = groupIds.find((id) => !presentation.has(id));
    if (missingPlan) throw new Error(`Daily presentation plan omitted work item ${missingPlan}.`);
    const expectedLevel = groupIds.some((id) => presentation.get(id) === 'full') ? 'full' : 'brief';
    if (entry.detailLevel !== expectedLevel) {
      throw new Error(`Daily draft detail level for ${entry.workItemId} must be ${expectedLevel}.`);
    }
    if (entry.detailLevel === 'full' && entry.progress.length < 2) {
      throw new Error(`Full daily item ${entry.workItemId} requires at least two progress steps.`);
    }
    if (entry.detailLevel === 'brief' && entry.progress.length > 2) {
      throw new Error(`Brief daily item ${entry.workItemId} may contain at most two progress steps.`);
    }
    validateEvidenceIds(
      entry.workItemId,
      entry.evidenceIds,
      groupedItems.flatMap((item) => item?.evidenceIds || []),
    );
  }

  const deepDiveCandidates = new Set(view.deepDiveCandidateIds);
  const takeawayCandidates = new Set(view.takeawayCandidateIds);
  for (const entry of draft.deepDives) {
    if (!deepDiveCandidates.has(entry.workItemId)) {
      throw new Error(`Daily deep dive cites non-candidate work item ${entry.workItemId}.`);
    }
    validateCitedEntry(items, draft, entry.workItemId, entry.evidenceIds);
  }
  for (const entry of draft.takeaways) {
    if (!takeawayCandidates.has(entry.workItemId)) {
      throw new Error(`Daily takeaway cites non-candidate work item ${entry.workItemId}.`);
    }
    validateCitedEntry(items, draft, entry.workItemId, entry.evidenceIds);
  }
  const deepDiveIds = new Set(draft.deepDives.map((entry) => entry.workItemId));
  // 候选集合允许重叠，但最终栏目不能重复消费同一工作项；局部去重优于整份日报回退。
  const takeaways = draft.takeaways.filter((entry) => !deepDiveIds.has(entry.workItemId));

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
    takeaways,
    diagrams: draft.diagrams.map((diagram) => ({
      ...diagram,
      mermaid: sanitizeMermaid(diagram.mermaid) || diagram.mermaid,
    })),
  };
}

/** 保留五段式结构，事实选择和展示轻重均由本地规则控制。 */
export function renderDailyReport(batch: ActivityBatch, view: DailyReportView, draft: DailyDraft): string {
  return compactSections(`# ${batch.date} 工作日报
${renderAudit(batch, view)}

> ${draft.headline}

${draft.overview}

${renderGlobalDiagrams(draft)}

## 1. 今日工作
${renderToday(view, draft)}

## 2. 重点任务
${renderFocusTask(view, draft)}

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
    // 飞书标题后空行会渲染成明显空白块。
    .replace(/^(#{1,6}\s+[^\n]+)\n+/gm, '$1\n')
    .replace(/^(\*\*[^*\n]+\*\*)\n+/gm, '$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

export function fallbackDailyDraft(view: DailyReportView): DailyDraft {
  const presentation = new Map(view.presentationPlan.map((item) => [item.workItemId, item.detailLevel]));
  const today = view.items.map((item) => {
    const detailLevel = presentation.get(item.id) || 'brief';
    return {
      workItemId: item.id,
      relatedWorkItemIds: [],
      detailLevel,
      title: item.title,
      background: isReportNarrative(item.goal)
        ? item.goal
        : `围绕“${item.title}”完成事实核对与阶段性推进。`,
      progress: fallbackProgress(item, detailLevel),
      keyDecision: item.decisions.find(isReportNarrative) || '',
      result: primaryResult(item),
      openQuestions: item.blockers.join('；') || (item.status === 'in_progress' || item.status === 'blocked'
        ? '仍需继续推进并补齐验证闭环。'
        : ''),
      evidenceIds: item.evidenceIds.slice(0, 20),
    };
  });
  const highlights = today.filter((item) => item.detailLevel === 'full').slice(0, 3)
    .map((item) => item.title);
  const counts = statusCounts(view.items);
  const deliveredCount = view.items.filter((item) => item.status === 'completed' && hasDeliveryRecord(item)).length;
  const completedWithoutDelivery = counts.completed - deliveredCount;
  const statusParts = [
    deliveredCount ? `已交付 ${deliveredCount} 项` : '',
    completedWithoutDelivery ? `形成可复核产出 ${completedWithoutDelivery} 项` : '',
    counts.investigated ? `形成分析结论 ${counts.investigated} 项` : '',
    counts.in_progress ? `推进中 ${counts.in_progress} 项` : '',
    counts.blocked ? `阻塞 ${counts.blocked} 项` : '',
  ].filter(Boolean);
  const openItems = view.items.filter((item) => item.status === 'in_progress' || item.status === 'blocked');
  const suggestions = openItems.slice(0, 4).map((item, index) => ({
    workItemId: item.id,
    priority: index === 0 ? 'P0' as const : 'P1' as const,
    text: item.status === 'blocked' ? `解除“${item.title}”的阻塞` : `继续推进“${item.title}”`,
    completionCriteria: item.blockers.length
      ? `确认并关闭阻塞项：${summarize(item.blockers, 2, 160)}`
      : '形成可复核产出，并记录验证结果或明确未验证原因。',
  }));
  return {
    headline: highlights.length ? `今日主线：${highlights.join('、')}` : view.items.length ? '今日以轻量事项确认和结论整理为主' : '当天没有可汇报工作项',
    overview: view.items.length
      ? `今天共记录 ${view.items.length} 项工作，${statusParts.join('，') || '整体状态待确认'}。${highlights.length ? `主要任务包括 ${highlights.join('、')}，其余轻量事项在表格中集中呈现。` : '当天以轻量确认和结论整理为主。'}本草稿由本地事实回退生成。`
      : '当天没有可汇报工作项，可能是会话被过滤、证据不足，或当天确实没有可追溯交付。',
    today,
    deepDives: [],
    takeaways: [],
    diagrams: [],
    suggestions: suggestions.length ? suggestions : [{
      workItemId: null,
      priority: 'P1',
      text: view.items.length ? '复核已交付事项的验证闭环' : '确认当天是否存在被过滤的有效会话',
      completionCriteria: view.items.length
        ? '所有已知风险均已关闭，或已作为后续事项记录完成标准。'
        : '确认当天没有遗漏可汇报的有效工作项。',
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
  const fullSections: string[] = [];
  const briefRows: string[] = [];

  for (const entry of draft.today) {
    const groupedItems = [entry.workItemId, ...entry.relatedWorkItemIds]
      .map((id) => items.get(id))
      .filter((item): item is WorkItem => Boolean(item));
    if (!groupedItems.length) continue;
    if (entry.detailLevel === 'brief') {
      briefRows.push(`| ${escapeCell(entry.title)} | ${escapeCell(entry.result)} | ${escapeCell(briefStatus(entry, groupedItems))} |`);
      continue;
    }

    const files = unique(groupedItems.flatMap((item) => item.changes.flatMap((change) => change.files)));
    const lines = [
      `#### ${entry.title}`,
      `- **进展与闭环**：${progressLabel(groupedItems)}${groupedItems.length > 1 ? `，合并 ${groupedItems.length} 项关联工作` : ''}；${closureLabel(groupedItems)}`,
      `- **目标**：${entry.background}`,
      '- **推进与取舍**',
      ...entry.progress.map((step) => `  - ${step}`),
    ];
    if (entry.keyDecision.trim()) lines.push(`  - 关键取舍：${entry.keyDecision.trim()}`);
    lines.push('- **可复核产出**', `  - ${entry.result}`);
    if (files.length) lines.push(`  - 改动范围：${fileScopeSummary(files)}`);
    lines.push('- **验证与证据**', ...evidenceLines(groupedItems));
    const risk = riskDetail(entry.openQuestions, groupedItems);
    lines.push(`- **风险与未闭环**：${risk || '暂无已知未闭环事项'}`);

    const hasInlinePlan = groupedItems.some((item) => view.visualPlan.some((plan) => (
      plan.workItemId === item.id && plan.mode === 'inline'
    )));
    const inline = hasInlinePlan ? inlineDiagram(entry.progress) : '';
    if (inline) lines.push(`- **简要图示**：${inline}`);

    const groupedIds = new Set(groupedItems.map((item) => item.id));
    for (const diagram of draft.diagrams.filter((item) => item.workItemId && groupedIds.has(item.workItemId))) {
      lines.push('', renderDiagram(diagram.title, diagram.mermaid));
    }
    fullSections.push(lines.join('\n'));
  }

  const sections: string[] = [];
  if (fullSections.length) {
    // 只用标准 Markdown 空行分隔任务，避免预览器把 HTML 空段标签显示成正文。
    sections.push(`### 主要任务\n${fullSections.join('\n\n')}`);
  }
  if (briefRows.length) {
    sections.push([
      '### 其他事项',
      '| 事项 | 结论或产出 | 状态 / 后续 |',
      '|---|---|---|',
      ...briefRows,
    ].join('\n'));
  }
  return sections.join('\n\n');
}

function renderFocusTask(view: DailyReportView, draft: DailyDraft): string {
  const fullIds = new Set(view.presentationPlan.filter((item) => item.detailLevel === 'full').map((item) => item.workItemId));
  const focus = view.items.find((item) => item.id === view.longestWorkItemId && fullIds.has(item.id))
    || view.items.find((item) => view.longestTiedIds.includes(item.id) && fullIds.has(item.id))
    || view.items.find((item) => fullIds.has(item.id));
  if (!focus) return '- 当天没有需要单独复盘的重点任务。';

  const narrative = draft.today.find((entry) => (
    entry.workItemId === focus.id || entry.relatedWorkItemIds.includes(focus.id)
  ));
  if (!narrative) return '- 当天没有需要单独复盘的重点任务。';
  const itemMap = new Map(view.items.map((item) => [item.id, item]));
  const groupedItems = [narrative.workItemId, ...narrative.relatedWorkItemIds]
    .map((id) => itemMap.get(id))
    .filter((item): item is WorkItem => Boolean(item));
  return [
    '| 维度 | 内容 |',
    '|---|---|',
    `| 任务 | ${escapeCell(narrative.title)} |`,
    `| 核心难点 | ${escapeCell(coreDifficulty(narrative.progress, groupedItems))} |`,
    `| 关键判断与取舍 | ${escapeCell(narrative.keyDecision.trim() || summarize(groupedItems.flatMap((item) => item.decisions), 3, 240) || '未记录需要单独说明的方案取舍')} |`,
    `| 可复核产出 | ${escapeCell(focusOutput(narrative.result, groupedItems))} |`,
    `| 验证与证据 | ${escapeCell(evidenceSummary(groupedItems))} |`,
    `| 剩余风险 | ${escapeCell(riskDetail(narrative.openQuestions, groupedItems) || '暂无已知剩余风险')} |`,
  ].join('\n');
}

function renderDeepDives(draft: DailyDraft): string {
  if (!draft.deepDives.length) return '- 当天没有达到准入标准的技术沉淀。';
  return draft.deepDives.map((item) => [
    `### ${item.title}`,
    `- **结论**：${item.conclusion}`,
    `- **机制**：${item.mechanism}`,
    `- **证据**：${item.evidence}`,
    `- **边界**：${item.boundary}`,
  ].join('\n')).join('\n\n');
}

function renderTakeaways(draft: DailyDraft): string {
  const rows = draft.takeaways.map((item) => `| ${escapeCell(item.method)} | ${escapeCell(item.applicability)} | ${escapeCell(item.defaultAction)} | ${escapeCell(item.completionCriteria)} | ${escapeCell(item.avoid)} |`);
  return [
    '| 方法 | 适用场景 | 默认动作 | 完成标准 | 避免 |',
    '|---|---|---|---|---|',
    ...(rows.length ? rows : ['| 无 | 无 | 无 | 无 | 无 |']),
  ].join('\n');
}

function renderSuggestions(draft: DailyDraft): string {
  const order = { P0: 0, P1: 1, P2: 2 };
  return [...draft.suggestions]
    .sort((left, right) => order[left.priority] - order[right.priority])
    .map((item, index) => [
      `${index + 1}. **${item.priority}｜${escapeInline(item.text)}**`,
      `   - 完成标准：${escapeInline(item.completionCriteria)}`,
    ].join('\n'))
    .join('\n\n') || '- 暂无明确下一步';
}

function renderDiagram(title: string, mermaid: string): string {
  const body = sanitizeMermaid(mermaid);
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

function inlineDiagram(progress: string[]): string {
  const steps = unique(progress.map((value) => value.replace(/[。；;]+$/g, '').trim()))
    .filter(isInlineVisualStep)
    .map((value) => compactInline(value, 28));
  return steps.length >= 3 ? steps.slice(0, 3).join(' → ') : '';
}

/** 行内图只接受整理后的业务步骤，拒绝命令、路径和对话式开场。 */
function isInlineVisualStep(value: string): boolean {
  const text = String(value || '').trim();
  if (!isReportNarrative(text) || /\[[^\]]+\]\([^)]+\)/.test(text) || /[?？]$/.test(text)) return false;
  if (/(?:^|[：:；;]\s*)(?:git|npm|npx|pnpm|yarn|emo|node|bash|sh|set|cd|cat|rg|find|jq|curl)\b/i.test(text)) {
    return false;
  }
  if (/(?:^|\s)(?:\/Users\/|(?:apps|src|test|tests|config|docs)\/)[^\s；;]+/i.test(text)) return false;
  return !/(?:^|\s)[^\s；;]+\.(?:ts|tsx|js|jsx|json|go|py|rs|java|kt|swift|yaml|yml|toml|md)\b/i.test(text);
}

function fallbackProgress(item: WorkItem, detailLevel: 'full' | 'brief'): string[] {
  const candidates = unique([
    ...item.actions,
    ...item.outcomes,
    item.goal,
  ].map((value) => compactInline(value, 220)).filter(isInlineVisualStep));
  if (detailLevel === 'brief') return candidates.slice(0, 2).length ? candidates.slice(0, 2) : [item.title];
  const progress = candidates.slice(0, 5);
  if (progress.length < 2) progress.push(closureStep(item));
  return unique(progress).slice(0, 5);
}

function closureStep(item: WorkItem): string {
  if (item.verifications.some((value) => value.outcome === 'failed')) return '验证发现问题，仍需归因';
  if (item.verifications.some((value) => value.outcome === 'passed')) return '完成验证并记录通过结果';
  if (item.status === 'blocked') return '等待阻塞解除后继续推进';
  if (item.status === 'in_progress') return '保留为后续待闭环事项';
  if (item.status === 'investigated') return '形成可复核的分析结论';
  return '形成可复核的交付结果';
}

function primaryResult(item: WorkItem): string {
  return compactInline(
    item.outcomes.find(isReportNarrative)
      || item.decisions.find(isReportNarrative)
      || closureStep(item),
    220,
  );
}

function progressLabel(items: WorkItem[]): string {
  const statuses = items.map((item) => item.status);
  if (statuses.includes('blocked')) return '当前阻塞';
  if (statuses.includes('in_progress')) return '正在推进';
  if (statuses.every((status) => status === 'investigated')) return '已形成分析结论';
  if (statuses.every((status) => status === 'completed')) {
    return items.some(hasDeliveryRecord) ? '已交付' : '已形成可复核产出';
  }
  return '已形成阶段性产出';
}

function closureLabel(items: WorkItem[]): string {
  const verifications = items.flatMap((item) => item.verifications);
  if (verifications.some((item) => item.outcome === 'failed')) return '验证失败，待确认是本次改动还是存量问题';
  if (verifications.some((item) => item.outcome === 'unknown')) return '验证结果未确认';
  if (verifications.some((item) => item.outcome === 'passed')) return '已记录通过验证';
  if (manualEvidence(items).length) return '已记录运行态或人工验证';
  if (deliveryEvidence(items).length) return '已有交付证据，缺少自动化验证记录';
  if (items.every((item) => item.kind === 'research')) return '分析结论已形成，未记录独立验证';
  return '尚未记录验证闭环';
}

function evidenceLines(items: WorkItem[]): string[] {
  const lines: string[] = [];
  const verifications = items.flatMap((item) => item.verifications);
  if (verifications.length) lines.push(`  - 自动化检查：${automationDetail(verifications)}`);
  const manual = manualEvidence(items);
  if (manual.length) lines.push(`  - 运行态 / 人工验证：${summarize(manual, 4, 240)}`);
  const delivery = deliveryEvidence(items);
  if (delivery.length) lines.push(`  - 交付证据：${delivery.join('；')}`);
  if (!lines.length) lines.push('  - 未记录可复核的验证或交付证据');
  return lines;
}

function evidenceSummary(items: WorkItem[]): string {
  return evidenceLines(items).map((line) => line.replace(/^\s*-\s*/, '')).join('；');
}

function automationDetail(verifications: WorkItem['verifications']): string {
  const checks = unique(verifications.map((verification) => verificationType(verification.command)));
  const counts = { passed: 0, failed: 0, unknown: 0 };
  for (const verification of verifications) counts[verification.outcome] += 1;
  const parts = [
    counts.passed ? `${counts.passed} 项通过` : '',
    counts.failed ? `${counts.failed} 项失败` : '',
    counts.unknown ? `${counts.unknown} 项未确认` : '',
  ].filter(Boolean);
  return `执行了${checks.join('、')}，${parts.join('、')}`;
}

function manualEvidence(items: WorkItem[]): string[] {
  return unique(items.flatMap(manualValidationFacts)
    .filter(isReadableNarrative)
    .map((value) => compactInline(value, 240)));
}

function deliveryEvidence(items: WorkItem[]): string[] {
  const deliveredItems = items.filter(hasDeliveryRecord);
  const commits = unique(deliveredItems.flatMap((item) => item.commits || []))
    .map((commit) => `Commit ${commit.slice(0, 10)}`);
  const branches = unique(deliveredItems.map((item) => item.branch || '')).map((branch) => `工作分支 ${branch}`);
  const outcomes = unique(deliveredItems.flatMap((item) => item.outcomes)
    .filter((value) => DELIVERY_PATTERN.test(value))
    .map(deliveryOutcomeLabel));
  return [...commits, ...branches, ...outcomes].slice(0, 5);
}

function deliveryOutcomeLabel(value: string): string {
  if (/^git\s+commit\b/i.test(value)) return '已记录 Git 提交操作';
  if (/^git\s+push\b/i.test(value)) return '已记录 Git 推送操作';
  if (/^(?:gh\s+pr|glab\s+mr)\s+create\b/i.test(value)) return '已记录 PR / MR 创建操作';
  return compactInline(value, 180);
}

function riskDetail(openQuestions: string, items: WorkItem[]): string {
  const verificationRisks = items.flatMap((item) => item.verifications)
    .filter((item) => item.outcome !== 'passed')
    .map((item) => item.outcome === 'failed'
      ? `${verificationType(item.command)}失败，待归因`
      : `${verificationType(item.command)}结果未确认`);
  return summarize([
    openQuestions.trim(),
    ...items.flatMap((item) => item.blockers),
    ...verificationRisks,
  ], 5, 260);
}

function briefStatus(entry: DailyDraft['today'][number], items: WorkItem[]): string {
  const risk = riskDetail(entry.openQuestions, items);
  return `${progressLabel(items)}；${risk || closureLabel(items)}`;
}

function coreDifficulty(progress: string[], items: WorkItem[]): string {
  const blockers = unique(items.flatMap((item) => item.blockers));
  if (blockers.length) return summarize(blockers, 2, 240);
  const decisions = unique(items.flatMap((item) => item.decisions));
  if (decisions.length > 1) return `需要协调 ${decisions.length} 个相互关联的关键判断`;
  const files = unique(items.flatMap((item) => item.changes.flatMap((change) => change.files)));
  if (files.length > 1) return `涉及 ${files.length} 个文件或模块，需要保持实现和验证口径一致`;
  if (progress.length >= 4) return `包含 ${progress.length} 个连续推进步骤，需要保持事实、取舍和验证链一致`;
  return progress[0] || '未记录需要单独说明的复杂点';
}

function focusOutput(result: string, items: WorkItem[]): string {
  const files = unique(items.flatMap((item) => item.changes.flatMap((change) => change.files)));
  const delivery = deliveryEvidence(items);
  const parts = [
    files.length ? `改动范围：${fileScopeSummary(files)}` : '',
    delivery.length ? delivery.join('；') : '',
  ].filter(Boolean);
  return parts.join('；') || result;
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

function validateCitedEntry(
  items: Map<string, WorkItem>,
  draft: DailyDraft,
  workItemId: string,
  evidenceIds: string[],
): void {
  const item = items.get(workItemId);
  if (!item) throw new Error(`Daily draft cites unknown work item ${workItemId}.`);
  const todayGroup = draft.today.find((entry) => (
    entry.workItemId === item.id || entry.relatedWorkItemIds.includes(item.id)
  ));
  const groupedItems = todayGroup
    ? [todayGroup.workItemId, ...todayGroup.relatedWorkItemIds].map((id) => items.get(id))
    : [item];
  validateEvidenceIds(
    workItemId,
    evidenceIds,
    groupedItems.flatMap((value) => value?.evidenceIds || []),
  );
}

function validateEvidenceIds(subjectId: string, evidenceIds: string[], allowedIds: string[]): void {
  const allowed = new Set(allowedIds);
  for (const id of evidenceIds) {
    if (!allowed.has(id)) throw new Error(`Daily draft cites evidence ${id} outside work item group ${subjectId}.`);
  }
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

function isReadableNarrative(value: string): boolean {
  const text = String(value || '').trim();
  return text.length >= 4 && !/^(?:git|npm|npx|pnpm|yarn|emo|node|bash|sh|set|cd|cat|rg|find|jq|curl)\b/i.test(text);
}

function isReportNarrative(value: string): boolean {
  const text = String(value || '').trim();
  return isReadableNarrative(text) && !DIALOGUE_NOISE_PATTERN.test(text);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeInline(value: string): string {
  return String(value || '').replace(/\r?\n/g, ' ').trim();
}

function escapeCell(value: string): string {
  return escapeInline(value).replace(/\|/g, '\\|');
}
