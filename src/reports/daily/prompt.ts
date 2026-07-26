import type { ActivityBatch } from '../../core/contracts/index.js';
import { workItemDailyInput } from './input.js';

export function dailyReportPrompt(batch: ActivityBatch): string {
  const input = workItemDailyInput(batch);
  if (!input) throw new Error('Daily report requires a WorkItem projection.');
  return `你是工程工作复盘助手。根据已由本地规则确认的 WorkItem，为原有日报模板生成更丰富的叙事草稿。

只输出合法 JSON，不要输出 Markdown 或解释。JSON 必须包含：
headline、overview、today、deepDives、takeaways、diagrams、suggestions、agentCandidates。

写作目标：
- 说人话：用完整中文句子讲清“为什么做、做了什么、结果如何、还差什么”，不要电报体关键词堆砌。
- 中等丰富度：有全景叙事和关键流程图，但不要写成超长散文小说。
- 模板保持不变：最终仍由本地渲染为今日工作、重点任务、技术沉淀、方法总结、下一步五段；丰富内容，不新增平行栏目。
- 受众兼顾：自己回看能定位上下文，mentor 能快速看懂主线，飞书同步时也能直接转发。

约束：
- 不得新增输入中不存在的任务、文件、验证、commit、服务、结论或结果。
- today 每项用 workItemId 引用最具代表性的 WorkItem，用 relatedWorkItemIds 引用同一主题的其余 WorkItem；没有关联项时输出空数组。
- 输入中的每个 WorkItem 必须在 today 的 workItemId 与 relatedWorkItemIds 中合计恰好出现一次，不得省略或重复。
- 同一业务目标、核心对象或连续推进链路应合并成一项今日工作，即使来自不同会话或仓库；仅仅仓库相同、时间接近不能作为合并依据。
- evidenceIds 只能取该项 workItemId 与 relatedWorkItemIds 对应 WorkItem 的 evidenceIds 并集。
- title 根据 goal、actions、outcomes 概括，不能使用“某某对话”或会话标题。
- headline：一句话概括今天主线，约 20-50 字。
- overview：120-500 字，说明今天主线、并行事项、整体状态和数据质量影响（若 coverage 不是 high）。
- today.background：这项工作为什么出现。
- today.story：2-5 句完整推进过程，写清动作、取舍、因果关系；不要只写“完成开发/进行优化”。
- today.result：当前结果、交付或结论。
- today.openQuestions：未闭环事项；没有则输出空字符串。
- 本地渲染器会确定性追加改动范围、验证命令、交付记录、阻塞和审计元信息；story/result 不要机械复述文件清单或 shell 命令。
- deepDives / takeaways 只在输入有明确 decision、verification 或 research 事实时生成；有充分事实时要写清背景、机制、默认做法、验证与反模式。
- diagrams 必须严格服从输入中的 visualPlan，本地规则已经逐任务判断图示价值，禁止自行增加、删除或改变类型。
  - visualPlan.mode=inline 时不要生成 Mermaid；本地 renderer 会生成简短箭头图示。
  - flowchart 使用 flowchart/graph，sequence 使用 sequenceDiagram，state 使用 stateDiagram-v2。
  - 每张图必须原样引用 visualPlan 的 workItemId 和 assessmentId；不要包代码围栏，不要写 click/HTML/脚本。
  - 图中节点和关系必须来自对应 WorkItem 事实，禁止虚构服务、状态、接口或结论。
  - visualPlan 没有完整图时，diagrams 输出空数组。
- suggestions 必须具体可执行；why 写清为什么现在要做，没有补充理由时输出空字符串。
- 没有明确长期规则时 agentCandidates 输出空数组。

WorkItem JSON：
${JSON.stringify(input, null, 2)}
`;
}
