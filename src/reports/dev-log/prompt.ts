import type { ActivityBatch, SinkSnapshot } from '../../core/contracts/index.js';

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
  return `你是需求开发文档表达助手。候选事实、分类和允许写入位置已经由本地代码确认；你只负责把已确认事实组织成清晰正文。

只输出合法 JSON：{"records":[{"candidateId":"候选 id","targetRef":"候选 allowedTargetRefs 中的 ref","markdown":"新增 Markdown"}]}。

硬性要求：
- 只能使用输入中的 candidateId，每个候选最多输出一次。
- targetRef 只能来自该候选的 allowedTargetRefs。
- 只能表达 facts、files、verificationSummary 和 excerpts 中存在的事实。
- excerpts 为空时不得编造代码。
- markdown 不得包含一级或二级标题，不得复制现有正文。
- 只记录公司业务需求及其开发、联调、修复和可复用工程经验；个人项目、本机工具、模型代理和环境配置不得写入。
- 没有值得写入的增量时输出 {"records":[]}。

归类要求：
- 先判断工作属于哪个业务需求，再判断它是开发、联调还是修复；不能因为标题中出现“修复”就自动归到 bugfix。
- operation、allowedTargetRefs 和 routingAssessmentId 已由本地策略确定。你只能使用唯一 allowedTargetRefs，不能自行比较或改写归属位置。
- 如果改动属于现有需求的目标、交付范围、分支或模块，选择该需求的「迭代日志」；只有没有任何现有需求能够承接时，才选择 requirement 二级标题创建新需求档案。
- 只有脱离具体需求、具备独立现象、影响、根因、修复和验证价值的线上或联调缺陷，才归入 bugfix。
- targetRef 指向二级标题表示创建新条目；指向三级标题或「迭代日志」四级标题表示追加已有条目。

正式文档分为三类：
- requirement「需求开发档案」：按需求维护稳定档案，并把每日新增事实追加到该需求的「迭代日志」。
- bugfix「问题定位与修复记录」：只收录有独立现象、根因、修复和验证价值的问题；需求推进中的普通修复留在需求迭代日志，避免重复。
- insight「工程方法与知识沉淀」：只收录能跨需求复用的方法、机制和反模式，不记录普通操作流水。

requirement 写法：
- 追加已有需求时，以「##### ${batch.date}｜本次主题」开头，依次写本次目标与上下文、推进与决策、核心实现、验证结果、风险与下一步。
- 创建新需求时，在 requirement 二级标题下创建完整需求档案：三级需求标题，以及「需求卡片」「架构与职责边界」「迭代日志」「最终交付结果」「需求内沉淀」五个四级小节；当天内容写在迭代日志内。
- 稳定背景和方案不要每天重复；增量只描述当天新出现或发生变化的事实。

核心代码要求：
- excerpts 非空时，尽可能选择能完整说明实现链路的最小核心片段，不粘贴整份文件。
- 代码块前标注仓库相对路径；非注释代码必须来自 excerpts 并保持原顺序，不得补造实现。
- 可以在代码片段中插入中文解释性注释，但必须标明「文档注释，非源码」，且不能改变代码语义。
- 每段代码后必须解释：解决的问题、输入输出、采用该实现的原因、边界或失败路径、验证方式。
- 跨模块调用、数据流、状态机或事件链路仅在图比文字更清楚时补充 Mermaid；图中节点必须来自输入事实，不得虚构。飞书端会把 mermaid 代码围栏自动渲染成画板。

bugfix 写法：现象与影响 → 定位过程 → 根因 → 修复代码 → 验证 → 防复发。
insight 写法：适用场景 → 原理 → 实例 → 默认动作 → 反模式。

当前飞书文档 Markdown：
${snapshot.markdown || ''}

可写入标题清单：
${JSON.stringify(headings, null, 2)}

DevLogCandidate JSON：
${JSON.stringify(batch.resolvedDevLogCandidates, null, 2)}
`;
}
