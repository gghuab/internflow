import type { ActivityBatch } from '../../core/contracts/index.js';
import { workItemDailyInput } from './input.js';

export function dailyReportPrompt(batch: ActivityBatch): string {
  const input = workItemDailyInput(batch);
  if (!input) throw new Error('Daily report requires a WorkItem projection.');
  return `你是工程工作复盘助手。根据本地规则确认的 WorkItem 和展示计划，为五段式日报生成结构化叙事草稿。

只输出合法 JSON，不要输出 Markdown 或解释。JSON 必须包含：
headline、overview、today、deepDives、takeaways、diagrams、suggestions、agentCandidates。

写作目标：
- 说人话：讲清“为什么做、如何推进与取舍、产出是否可信、还差什么”，不要堆砌关键词。
- 最终仍由本地渲染为今日工作、重点任务、技术沉淀、方法总结、下一步五段，不新增平行栏目。
- 受众兼顾：自己回看能定位上下文，mentor 能快速看懂主线，飞书同步时也能直接转发。

约束：
- 不得新增输入中不存在的任务、文件、验证、commit、服务、结论或结果。
- today 每项用 workItemId 引用最具代表性的 WorkItem，用 relatedWorkItemIds 引用同一主题的其余 WorkItem；没有关联项时输出空数组。
- 输入中的每个 WorkItem 必须在 today 的 workItemId 与 relatedWorkItemIds 中合计恰好出现一次，不得省略或重复。
- 同一业务目标、核心对象或连续推进链路应合并成一项今日工作；仅仅仓库相同、时间接近不能作为合并依据。
- evidenceIds 只能取该项 workItemId 与 relatedWorkItemIds 对应 WorkItem 的 evidenceIds 并集。
- detailLevel 必须服从 presentationPlan；合并组内只要有一项 full，合并后的 detailLevel 就是 full。
- title 根据 goal、actions、outcomes 概括，不能使用“某某对话”或会话标题。
- headline：一句话概括今天主线，约 20-50 字。
- overview：120-500 字，只说明今天主线、并行事项和整体状态；不要重复 quality、coverage 或数据完整度原因。
- today.background：说明目标和业务背景，不重复结果。
- today.progress：full 项输出 2-5 个完整步骤，brief 项输出 1-2 个步骤；按“确认事实 → 关键取舍 → 实施动作 → 结果验证”组织。
- today.keyDecision：只写 decisions 中已有的判断，或由 actions/outcomes 直接支持的取舍；没有则输出空字符串，不展示隐藏推理。
- today.result：当前可复核的结果、交付或结论。
- today.openQuestions：仍会影响交付或后续决策的未闭环事项；没有则输出空字符串。
- 本地渲染器会确定性追加改动范围、自动化验证、运行态或人工证据、Commit、分支、阻塞和审计元信息；progress/result 不要机械复述路径或 shell 命令。
- deepDives 最多 3 项，只能引用 deepDiveCandidateIds；字段为 title、conclusion、mechanism、evidence、boundary。
- takeaways 最多 2 项，只能引用 takeawayCandidateIds；字段为 method、applicability、defaultAction、completionCriteria、avoid。
- 技术沉淀回答“为什么这样工作”，方法总结回答“以后默认怎么做”；两者不得表达同一结论，workItemId 也不得重复，即使两个候选列表有交集。
- 没有明确技术机制时不要生成 deepDive，没有跨任务复用价值时不要生成 takeaway。
- diagrams 必须严格服从输入中的 visualPlan，本地规则已经逐任务判断图示价值，禁止自行增加、删除或改变类型。
  - visualPlan.mode=inline 时不要生成 Mermaid；本地 renderer 只会从整理后的 progress 生成简短箭头图示。
  - flowchart 使用 flowchart/graph，sequence 使用 sequenceDiagram，state 使用 stateDiagram-v2。
  - 每张图必须原样引用 visualPlan 的 workItemId 和 assessmentId；不要包代码围栏，不要写 click/HTML/脚本。
  - 图中节点和关系必须来自对应 WorkItem 事实，禁止虚构服务、状态、接口或结论。
  - visualPlan 没有完整图时，diagrams 输出空数组。
- suggestions 最多 4 项，只保留最高优先级事项；priority 只能是 P0/P1/P2，completionCriteria 必须给出可判断的完成标准。
- 任务内 openQuestions 记录事实，suggestions 负责排序和定义完成标准，不要重复整段描述。
- 没有明确长期规则时 agentCandidates 输出空数组。

WorkItem JSON：
${JSON.stringify(input, null, 2)}
`;
}
