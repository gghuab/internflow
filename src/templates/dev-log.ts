import type { ActivityBatch, SinkSnapshot } from '../core/types.js';

export function devLogPrompt(batch: ActivityBatch, snapshot: SinkSnapshot): string {
  const headings = (snapshot.headings || []).map(({ ref, level, text, section }) => ({
    ref,
    level,
    text,
    section,
  }));

  return `你是需求开发记录维护助手。根据今天的开发活动和现有文档，只生成需要追加的结构化记录。

输出要求：
- 只输出合法 JSON，不要代码围栏或说明。
- 格式：{"records":[{"section":"requirement|bugfix|insight","targetRef":"h1","markdown":"新增内容"}]}。
- targetRef 只能使用标题清单中的临时 ref，不得输出或猜测真实飞书 Block ID。
- markdown 只能包含新增内容，不能复制、改写或删除已有正文。
- markdown 禁止一级、二级标题；确需新增条目时可以使用三级或更低标题。
- 匹配已有需求时，选择最具体的相关标题。
- 新需求归入 requirement；联调和修复归入 bugfix；可复用方法归入 insight。
- 没有必要内容、内容已经存在或证据不足时输出 {"records":[]}。
- 最多输出 12 条记录，不编造 MR、commit、发布或验证结果。

现有文档 Markdown：
${snapshot.markdown || ''}

标题清单：
${JSON.stringify(headings, null, 2)}

今天的开发活动：
${JSON.stringify(batch, null, 2)}
`;
}

