import type { ActivityBatch, SinkSnapshot } from '../../core/contracts/index.js';
import { devLogMarkdownSection } from './document-index.js';

export function devLogPrompt(batch: ActivityBatch, snapshot: SinkSnapshot): string {
  if (!batch.resolvedDevLogCandidates) {
    throw new Error('Dev log requires resolved WorkItem candidates.');
  }
  const headings = (snapshot.headings || []).map(({ ref, level, text, section }) => ({
    ref,
    level,
    text,
    section,
  }));
  const targetContexts = batch.resolvedDevLogCandidates.flatMap((candidate) => (
    candidate.writeTargets
      .filter((target) => target.operation === 'replace')
      .map((target) => ({
        candidateId: candidate.id,
        targetRef: target.ref,
        role: target.role,
        currentMarkdown: devLogMarkdownSection(snapshot, target.ref),
      }))
  ));
  return `你是需求开发文档表达助手。候选事实、分类和允许写入位置已经由本地代码确认；你只负责把已确认事实组织成清晰正文。

只输出合法 JSON：{"records":[{"candidateId":"候选 id","targetRef":"候选 writeTargets 中的 ref","markdown":"该目标的 Markdown"}]}。

硬性要求：
- 只能使用输入中的 candidateId；同一候选可以对应多个 writeTargets，但同一个 candidateId + targetRef 最多输出一次。
- targetRef 只能来自该候选的 writeTargets。本地代码已经确定 operation、role、位置和标题前缀，你不得自行换位置。
- 每个 required=true 的 writeTarget 必须输出；required=false 只在当天事实确实改变该节当前结论时输出，禁止为了改写而改写。
- 每条 markdown 必须以对应 writeTarget.markdownPrefix 开头；不得改写本地分配的 REQ / ISSUE 编号或标题。
- replace 中的表格必须输出普通 Markdown 表格，不得复制飞书导出内容里的 data-block-id、id 或其他远端 Block ID。
- 新增内容和状态变化只能来自 facts、files、verificationSummary 和 excerpts；replace 可以保留对应 currentMarkdown 中仍有效的旧事实。
- excerpts 为空时不得编造代码。
- markdown 不得包含一级或二级标题；append/create 不得复制现有正文，replace 只保留目标小节中仍有效的内容。
- 标题和代码围栏前后不要插入空行；飞书会把这些空行渲染成独立空段落。
- 不得生成空章节，也不得生成「问题索引与维护原则」「常见问题类型」「修复原则」「记录规则」「维护规则」「后续增量」「迁移自原文」「状态纠正」等维护性标题。
- 只记录公司业务需求及其开发、联调、修复和可复用工程经验；个人项目、本机工具、模型代理和环境配置不得写入。

归类要求：
- 先判断当天动作是在实现尚未完成的验收目标，还是在恢复已经存在但发生异常的行为：前者属于 requirement，后者属于 bugfix。
- operation、writeTargets 和 routingAssessmentId 已由本地策略确定。你只能完成计划中的写入，不得自行比较标题或改写归属位置。
- role=change-log 只保留当天历史增量；role=requirement-overview/background/design/implementation/verification/retrospective 维护对应的当前事实。
- bugfix 即使与旧需求高度相关，也必须保留 ISSUE 分类；relatedRequirementHeading 非空时，在正文中明确写出“关联需求”，不得把它改写成 REQ 增量。
- 同一分支可以包含多个需求、回归修复和交付操作；分支名只能作为交付证据，不能作为需求标题或归类依据。
- operation=create 表示在分类根节点创建新条目；append 表示保留原文并追加；replace 表示输出该小节的完整最新版本。
- replace 必须保留目标小节中仍然有效的原有事实，只删除被当天证据明确推翻的内容，再合并当天新增事实；不得因输入只包含当天增量而丢掉历史仍有效内容。
- candidate.status 只描述当天工作项，不等于长期需求生命周期；当天子任务 completed 不能关闭旧阻塞或把整个需求改成已完成，除非 facts 或 verificationSummary 明确证明旧问题已解决。
- 多个候选指向同一 subjectHeading 时，replace 目标只会挂在其中一个候选下，但正文要综合同一 subjectHeading 的全部当天候选事实。

正式文档分为四部分：
- overview「一、开发总览」：同步当前需求状态、当天最近更新和仍未解决的待确认事项；表格必须保留未受影响需求的行。
- requirement「二、需求开发记录」：按需求维护稳定档案，并把每日新增事实追加到该需求的「变更记录」。
- bugfix「三、问题与修复记录」：每个恢复既有行为、修正异常或处理回归的问题使用明确的 ISSUE 标题；相关旧需求通过“关联需求”建立引用，不改变分类。
- insight「四、工程经验沉淀」：只收录能跨需求复用的方法、机制和反模式，不记录普通操作流水或文档维护规则。

requirement 写法：
- role=change-log 时按给定 markdownPrefix 开头，依次写目标与上下文、推进与决策、核心实现、验证结果、风险与下一步。
- role=entry 时必须使用本地已经分配好的 subjectHeading；根据事实创建「需求概览」「背景与范围」「方案与职责边界」「核心实现」「验证与交付」「变更记录」「复盘与沉淀」，没有内容的可选章节直接省略。
- 「需求概览」只写当前事实；历史状态只进入「变更记录」。同一事实不要在多个章节重复。
- 稳定背景和方案不要每天重复；增量只描述当天新出现或发生变化的事实。
- role=overview-status 使用完整 Markdown 表格，至少保留编号、需求、当前阶段、最近有证据更新、当前结论、交付状态六列。
- role=overview-recent 只列 ${batch.date} 的确认增量；role=overview-todos 保留尚未解决的旧事项，并根据当天证据关闭或补充事项。

核心代码要求：
- excerpts 非空时，尽可能选择能完整说明实现链路的最小核心片段，不粘贴整份文件。
- 新需求的「核心实现」中，每个真实实现模块必须使用有意义的五级标题，不能只有粗体标题、文件路径或裸代码块。
- 代码块前标注仓库相对路径；非注释代码必须来自 excerpts 并保持原顺序，不得补造实现。
- 可以在代码片段中插入中文解释性注释，但必须标明「文档注释，非源码」，且不能改变代码语义。
- 每段代码后必须解释：解决的问题、输入输出、采用该实现的原因、边界或失败路径、验证方式。
- 跨模块调用、数据流、状态机或事件链路仅在图比文字更清楚时补充 Mermaid；图中节点必须来自输入事实，不得虚构。飞书端会把 mermaid 代码围栏自动渲染成画板。

bugfix 写法：使用「### ISSUE-XXX｜具体问题」直接记录现象与影响 → 定位过程 → 根因 → 修复代码 → 验证 → 防复发；不要创建问题分类、索引或原则章节。
insight 写法：使用能直接说明方法的具体标题，记录适用场景 → 原理 → 实例 → 默认动作 → 反模式；不要创建维护规则。

replace 目标的当前正文：
${JSON.stringify(targetContexts, null, 2)}

可写入标题清单：
${JSON.stringify(headings, null, 2)}

DevLogCandidate JSON：
${JSON.stringify(batch.resolvedDevLogCandidates, null, 2)}
`;
}
