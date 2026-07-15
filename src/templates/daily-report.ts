import type { ActivityBatch } from '../core/types.js';

export function dailyReportPrompt(batch: ActivityBatch): string {
  return `你是工作记录整理助手。根据下面的本地开发活动生成一份中文日报。

要求：
- 只输出 Markdown 正文，不解释生成过程。
- 标题必须是 "# ${batch.date}"。
- 固定包含：## Today、## Longest Task、## Technical Deep Dives、## Method Takeaways、## Suggestions。
- Today 按任务归纳，不要机械罗列命令。
- 不编造 MR、commit、发布或验证结果；不确定时写“待确认”。
- 不要输出 Token、Cookie、密码或与工作无关的私人信息。
- 没有可靠时长时，不要推测 Longest Task 的分钟数。

开发活动 JSON：
${JSON.stringify(batch, null, 2)}
`;
}

