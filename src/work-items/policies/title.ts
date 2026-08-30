import type { WorkItemKind } from '../types.js';

const MAX_TITLE_LENGTH = 32;
const LEADING_CHATTER = /^(?:(?:请|麻烦|赶快|帮忙|帮我|你来帮我|你帮我|我想|我要|我需要|需要|继续|看一下|看看|好的|好|那|那么|现在|要求的是|我现在想问(?:你)?|我想问(?:你)?)[，,、：:\s]*)+/i;
const TRAILING_CHATTER = /(?:怎么做|怎么弄|告诉我怎么打开|为什么|为啥|是什么|是啥|可以吗|行吗|好吗|吗|呢|吧|呀)+$/i;
const VAGUE_REFERENCE = /^(?:已完成|完成|技术分析|直接开始(?:修复|处理)?|开始处理|恢复一下|解析一下(?:这个)?|看一下(?:这个)?|bug|问题|这个|那个|这里|上面|下面|第[一二三四五六七八九十\d]+个|(?:和|与)?(?:增强|优化|调整))(?:[:：。.!！啊呀吧\s]*)$/i;
const LOW_INFORMATION = /^(?:这里|这个|那个|上面|下面|第[一二三四五六七八九十\d]+个|赶快|我刚才|好的，?按|按(?:你的|这个|上面)|直接开始)/;
const QUESTION = /[?？]|(?:吗|呢|么|怎么|咋|是否|是不是|能不能|可不可以|什么|为啥|为什么)(?:[，,。.!！]?|$)/;
const GENERIC_SCOPE = /^(?:src|test|tests|app|apps|packages?|mock|index(?:\.module)?|shared|utils?|types?|interface|api|config|constants?|components?|pages?|hooks?)$/i;
const TECHNICAL_TOPIC_SOURCE = String.raw`(?:[A-Za-z][A-Za-z0-9._-]{2,}|接口|字段|页面|组件|模块|路由|状态|数据|模型|生成器|配置|脚本|流程|分支|发布|部署|构建|样式|主题|颜色|权限|鉴权|缓存|会话|任务|需求|文档|测试|校验|迁移|流水线)`;
const TECHNICAL_TOPIC = new RegExp(TECHNICAL_TOPIC_SOURCE);
const TECHNICAL_TOPICS = new RegExp(TECHNICAL_TOPIC_SOURCE, 'g');

export function inferWorkItemTitle(
  goal: string,
  outcomes: string[],
  files: string[],
  kind: WorkItemKind,
  contextTexts: string[] = [],
  _branch = '',
): string {
  const cleanedGoal = cleanSentence(goal);
  const goalTitle = actionableTitle(cleanedGoal, kind, QUESTION.test(goal));
  const outcomeTitle = bestOutcomeTitle(outcomes, kind);
  const businessTitle = businessScopeTitle(files, kind);
  const scopedTitle = fileTitle(files, kind);
  const topicTitle = topicTitleFromText(cleanedGoal, kind);
  const contextTitle = contextScopeTitle(contextTexts, kind);
  // 人类可读标题必须来自业务目标或代码范围；分支名只进入交付证据，不再冒充需求名称。
  const title = [contextTitle, goalTitle, outcomeTitle, businessTitle, scopedTitle, topicTitle]
    .filter(Boolean)
    .sort((left, right) => titleQualityScore(right) - titleQualityScore(left) || left.length - right.length)[0]
    || fallbackLabel(kind);
  return limitTitle(title);
}

function businessScopeTitle(files: string[], kind: WorkItemKind): string {
  const paths = files.join('\n');
  const bug = kind === 'bugfix';
  if (/ActivityManagePopup/i.test(paths)) return bug ? '活动管理弹窗文案回退' : '活动管理弹窗交互优化';
  if (/apply-management/i.test(paths)) return bug ? '报名申请列表问题修复' : '报名申请列表状态展示优化';
  if (/registration-v2/i.test(paths)) return bug ? '报名详情组件问题修复' : '报名详情组件分层重构';
  if (/group-association-modal|bind-managed-groups/i.test(paths)) return bug ? '活动绑定群列表问题修复' : '活动绑定群列表与弹窗优化';
  if (/RefundPolicyNotice/i.test(paths)) return bug ? '报名详情退款提示问题修复' : '报名详情退款提示优化';
  if (/activity-tracking|page-tracking/i.test(paths)) return bug ? '活动创建页埋点问题修复' : '活动创建页埋点服务重构';
  if (/launch-activity-v2-migration/i.test(paths)) return bug ? '活动创建页 V2 回归修复' : '活动创建页 V2 重构';
  if (/activity-detail/i.test(paths)) return bug ? '活动详情页问题修复' : '活动详情页初始化重构';
  if (/(?:checkin|check-in).*(?:poster|template|swiper|image)|(?:poster|template|swiper|image).*(?:checkin|check-in)/i.test(paths)) {
    return bug ? '打卡图片海报与模板问题修复' : '打卡图片海报与模板优化';
  }
  if (/(?:hexiao|write-off)/i.test(paths)) return bug ? '活动核销链路问题修复' : '活动核销链路优化';
  if (/activity-(?:level|group|grade)/i.test(paths)) return bug ? '活动分级审核问题修复' : '活动分级审核开发';
  if (/(?:^|\/)registration(?:\/|$)/im.test(paths)) return bug ? '报名详情页问题修复' : '报名详情页优化';
  return '';
}

function titleQualityScore(value: string): number {
  const hanCount = (value.match(/[\p{Script=Han}]/gu) || []).length;
  let score = Math.min(value.length, 28) + Math.min(hanCount, 16);
  if (value.length >= 6 && value.length <= 24) score += 8;
  if (/(活动|报名|退款|核销|打卡|详情|创建页|绑定群|埋点|海报|模板)/.test(value)) score += 10;
  if (/(新增|实现|修复|重构|改造|升级|优化|迁移|调整|更新|开发)$/.test(value)) score += 6;
  if (/(?:\bconst\b|container|service|serivice|commit|push|git|diff|incut_)/i.test(value)) score -= 16;
  if (/(?:不要问|都可以|我看看|你现在|你能|是不是)/.test(value)) score -= 16;
  if (/(?:功能开发|交付操作|问题修复|代码重构)$/.test(value)) score -= 14;
  if (/^[A-Za-z0-9_.-]+(?:功能开发|问题修复|代码重构)$/.test(value)) score -= 12;
  return score;
}

function contextScopeTitle(values: string[], kind: WorkItemKind): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    // 从多轮请求中提取反复出现的业务页面名，而不是采用任意一轮的整句会话标题。
    const scopes = new Set([...value.matchAll(/([\p{Script=Han}]{2})创建页/gu)].map((match) => `${match[1]}创建页`));
    for (const scope of scopes) counts.set(scope, (counts.get(scope) || 0) + 1);
  }
  const scope = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
  if (scope) return `${scope}${kind === 'refactor' ? '重构' : kindLabel(kind)}`;
  if (values.length < 2) return '';

  // 合并后的工作项可能包含多个连续 turn；从全部真实请求中挑信息量最高的业务标题，
  // 避免某一句“现在怎么实现”覆盖前面的具体需求描述。
  return values
    .map((value) => cleanSentence(value))
    .map((value) => actionableTitle(value, kind, QUESTION.test(value)))
    .filter(Boolean)
    .sort((left, right) => contextTitleScore(right) - contextTitleScore(left) || left.length - right.length)[0] || '';
}

function contextTitleScore(value: string): number {
  const hanCount = (value.match(/[\p{Script=Han}]/gu) || []).length;
  let score = Math.min(value.length, 28) + Math.min(hanCount, 16);
  if (value.length >= 6 && value.length <= 28) score += 8;
  if (/(新增|实现|修复|重构|改造|升级|优化|迁移|调整|更新|上移|下移|贴纸|海报|模板|上传|预览|下载|核销|报名|活动)/.test(value)) score += 6;
  if (/^(?:这个|那个|这里|上面|下面|一版|给我|再|现在)|(?:怎么实现|能实现|分析|看看)$/.test(value)) score -= 12;
  if (/^[A-Za-z0-9_.-]+(?:功能开发|问题修复|代码重构)$/.test(value)) score -= 10;
  return score;
}

function actionableTitle(goal: string, kind: WorkItemKind, questionContext = false): string {
  if (!goal || isVague(goal)) return '';

  if (/^贴纸[:：]/.test(goal) && /(已签到|已核销|已失效)/.test(goal)) return '签到与核销状态贴纸更新';

  if (/(?:代码|分支).{0,24}(?:review|评审)/i.test(goal)) return '分支代码评审';

  const branchMerge = goal.match(/^(.{3,80}?)[，,]\s*(?:拉取|合并|合入)/i);
  if (branchMerge?.[1]) {
    const branch = cleanObject(branchMerge[1])
      .replace(/^最新的?/i, '')
      .replace(/^(?:origin\/)?(?:feat|feature|fix|bugfix)\//i, '');
    if (branch && !isVague(branch)) return `${branch}分支合入`;
  }

  const developmentRecord = goal.match(/((?:需求|项目|工作)?开发记录)/);
  if (developmentRecord?.[1] && /(总结|整理|同步|写入|嵌入)/.test(goal)) {
    return `${developmentRecord[1]}同步`;
  }

  if (kind === 'research') {
    const developmentFlow = goal.match(/开发(.{2,24}?)的时候/);
    if (developmentFlow?.[1]) return `${cleanObject(developmentFlow[1])}开发流程分析`;
    const summary = goal.match(/(?:总结|复盘)(?:一下)?(?:我的|我们的)?\s*(.+)/i);
    const object = cleanObject(summary?.[1] || '');
    if (object && !isVague(object)) return `${object}复盘`;
  }

  // “运行配置能力升级”这类名词短语已经是完整标题，末尾动作不应被误解为句中指令。
  if (!questionContext && /^.{2,28}(?:新增|实现|修复|重构|改造|升级|优化|迁移|调整|更新|清理)$/.test(goal)) {
    return goal;
  }

  const patterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /(?:新增|添加)(?:了)?(?:一个)?\s*(.+)/i, label: '新增' },
    { pattern: /(?:实现|开发)(?:一个)?\s*(.+)/i, label: '实现' },
    { pattern: /(?:修复|解决)(?:一下)?\s*(.+)/i, label: '修复' },
    { pattern: /(?:改回|恢复)(?:成|到)?(?:一下)?\s*(.+)/i, label: '修复' },
    { pattern: /(?:重构|整理)(?:一下)?\s*(.+)/i, label: '重构' },
    { pattern: /(?:收敛)(?:一下)?\s*(.+)/i, label: '重构' },
    { pattern: /(?:改造)(?:一个)?\s*(.+)/i, label: '改造' },
    { pattern: /(?:升级)(?:一个)?\s*(.+)/i, label: '升级' },
    { pattern: /(?:优化)(?:一个)?\s*(.+)/i, label: '优化' },
    { pattern: /(?:迁移)(?:一个)?\s*(.+)/i, label: '迁移' },
    { pattern: /(?:统一|调整|更改|修改)(?:一下)?\s*(.+)/i, label: '调整' },
    { pattern: /(?:拉取|更新)(?:最新的?)?\s*(.+)/i, label: '更新' },
    { pattern: /(?:删除|清理)(?:一下)?\s*(.+)/i, label: '清理' },
    { pattern: /(?:配置|设置)(?:一下)?\s*(.+)/i, label: '配置' },
    { pattern: /(?:解析|分析|研究)(?:一下)?\s*(.+)/i, label: '分析' },
    { pattern: /(?:mock)(?:一下)?\s*(.+)/i, label: 'Mock' },
  ];
  for (const { pattern, label } of patterns) {
    const match = goal.match(pattern);
    const prefix = match?.index === undefined ? '' : goal.slice(0, match.index);
    if (/(?:没|未|没有)\s*$/.test(prefix)) continue;
    const object = cleanObject(match?.[1] || '');
    if (object && !isVague(object)) {
      return kind === 'research' && questionContext
        ? `${object}${label}方案分析`
        : `${object}${label}`;
    }
    if (match) return '';
  }

  const trailingRefactor = goal.match(/^(.{2,48}?)(?:开始)?(?:整理|重构)$/i);
  if (trailingRefactor?.[1]) {
    const object = cleanObject(trailingRefactor[1]);
    if (object && !isVague(object)) return `${object}重构`;
  }

  const difference = goal.match(/^(.{3,48}?)(?:看着|看起来|显示得?)?(?:不太一样|不一致|有差异)$/i);
  if (difference?.[1]) {
    const object = cleanObject(difference[1]);
    if (object && !isVague(object)) return `${object}差异分析`;
  }

  const failure = goal.match(/^(.{2,40}?)(?:也)?(?:拉不起来|打不开|不能用|没反应|启动不了)$/i);
  if (failure?.[1]) {
    const object = cleanObject(failure[1]);
    if (object && !isVague(object)) return `${object}启动问题修复`;
  }

  const repeated = goal.match(/(.{0,28}?)(?:还是|仍然)?(?:会)?重复(请求|加载|触发|显示|提交|上报)/);
  if (repeated) {
    const object = cleanObject(repeated[1] || '').replace(/^往/, '');
    return `${object ? `${object}` : ''}重复${repeated[2]}修复`;
  }

  const movement = goal.match(/(.{2,36}?)(?:上移|下移|前移|后移)/);
  if (movement?.[1]) {
    const object = cleanObject(movement[1]);
    if (object && !isVague(object)) return `${object}调整`;
  }

  const trailingRemoval = goal.match(/^(.{2,48}?)(?:去掉|移除|删掉)$/i);
  if (trailingRemoval?.[1]) {
    const object = cleanObject(trailingRemoval[1]);
    if (object && !isVague(object)) return `${object}修复`;
  }

  if (!questionContext && !QUESTION.test(goal) && goal.length <= MAX_TITLE_LENGTH && isInformativeDirectTitle(goal)) {
    return goal;
  }
  return topicTitleFromText(goal, kind);
}

function bestOutcomeTitle(outcomes: string[], kind: WorkItemKind): string {
  const candidates = outcomes.map(cleanOutcome).filter(Boolean);
  const best = candidates.sort((left, right) => scoreOutcome(right) - scoreOutcome(left)
    || left.length - right.length)[0];
  if (!best) return '';
  const action = actionableTitle(best, kind);
  if (action) return action;
  const topics = topicTitleFromText(best, kind);
  return topics || (best.length <= MAX_TITLE_LENGTH ? best : '');
}

function cleanOutcome(value: string): string {
  const text = cleanSentence(value)
    .replace(/^(?:已经|已)?(?:完成|实现|修复)(?:了)?(?:指定范围内的|以下|两项|三项|多项)?(?:修改|收敛)?[:：]?\s*/i, '')
    .trim();
  if (!text || /^(?:git|npm|pnpm|yarn|npx|emo|exec|rg|sed|cat)\b/i.test(text)) return '';
  if (VAGUE_REFERENCE.test(text) || /[:：]$/.test(text)) return '';
  return text;
}

function cleanSentence(value: string): string {
  let text = String(value || '');
  const request = text.match(/## My request for Codex:\s*([\s\S]*)$/i);
  if (request?.[1]) text = request[1];
  return text
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[。！？!?；;\n]/)[0]!
    .replace(/^#+\s*/, '')
    .replace(LEADING_CHATTER, '')
    .replace(TRAILING_CHATTER, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanObject(value: string): string {
  return String(value || '')
    .split(/(?:，|,|然后|同时|并且|并告诉|并|告诉我|我看看|看看效果|我想|但是|不过|给这个)/)[0]!
    .replace(/^(?:一下|一个|这个|那个|这里|上面|下面|这一页的?|第[一二三四五六七八九十\d]+个)\s*/i, '')
    .replace(/^(?:我的|我们的)\s*/i, '')
    .replace(/^(?:我看|我觉得|我发现)\s*/i, '')
    .replace(/^我现在\s*/i, '')
    .replace(/^不只是\s*/i, '')
    .replace(/^我从(.+?)到今天所干的事情$/i, '$1至今工作')
    .replace(/^开发整个(.+)$/i, '$1开发')
    .replace(/(?:的代码|的部分|这个部分|相关的|相关代码|的办法|的方式|的方案)$/i, '')
    .replace(/到本地$/i, '')
    .replace(/(?:吗|呢|吧|呀|啊|把)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isVague(value: string): boolean {
  const text = value.trim();
  return !text
    || VAGUE_REFERENCE.test(text)
    || LOW_INFORMATION.test(text) && !TECHNICAL_TOPIC.test(text)
    || /^(?:这|那|第[一二三四五六七八九十\d]+)[个一二三四五六七八九十\d\s]+$/.test(text);
}

function isInformativeDirectTitle(value: string): boolean {
  const text = value.trim();
  return Boolean(text
    && text.length >= 4
    && TECHNICAL_TOPIC.test(text)
    && !VAGUE_REFERENCE.test(text)
    && !LOW_INFORMATION.test(text)
    && !/(?:不要问|都可以|我看看|给我|你现在|你能|是不是)/.test(text));
}

function topicTitleFromText(value: string, kind: WorkItemKind): string {
  const topics = [...new Set(value.match(TECHNICAL_TOPICS) || [])]
    .filter((topic) => !/^(?:这个|那个|这里|什么)$/.test(topic))
    .slice(0, 3);
  if (!topics.length) return '';
  return `${joinTopics(topics)}${kindLabel(kind)}`;
}

function fileTitle(files: string[], kind: WorkItemKind): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (!file || /^(?:\$\{[^}]+\}\/)|\.(?:jsonl|log)$/i.test(file)) continue;
    const parts = file.split(/[/\\]/).filter(Boolean);
    const base = parts.at(-1)?.replace(/\.[^.]+$/, '') || '';
    const scope = GENERIC_SCOPE.test(base) ? nearestScope(parts.slice(0, -1)) : base;
    if (!scope || GENERIC_SCOPE.test(scope) || !/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(scope)) continue;
    counts.set(scope, (counts.get(scope) || 0) + 1);
  }
  const scopes = [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 2)
    .map(([name]) => name);
  if (!scopes.length) return '';
  const combined = `${joinTopics(scopes)}${kindLabel(kind)}`;
  return combined.length <= MAX_TITLE_LENGTH ? combined : `${scopes[0]}${kindLabel(kind)}`;
}

function nearestScope(parts: string[]): string {
  return [...parts].reverse().find((part) => !GENERIC_SCOPE.test(part)) || '';
}

function scoreOutcome(value: string): number {
  let score = value.length >= 6 && value.length <= 48 ? 4 : 0;
  if (TECHNICAL_TOPIC.test(value)) score += 3;
  if (/(完成|通过|提交|发布|修复|实现|迁移|配置)/.test(value)) score += 2;
  return score;
}

function joinTopics(topics: string[]): string {
  if (topics.length <= 1) return topics[0] || '';
  return `${topics.slice(0, -1).join('、')} 与 ${topics.at(-1)}`;
}

function limitTitle(value: string): string {
  const title = value.replace(/\s+/g, ' ').trim();
  if (title.length <= MAX_TITLE_LENGTH) return title;
  const suffix = title.match(/(方案分析|差异分析|启动问题修复|问题修复|功能开发|代码重构|技术分析|工具链优化|文档完善|交付操作|分支合入|新增|实现|修复|重构|改造|升级|优化|迁移|调整|更新|清理|分析|Mock)$/)?.[1];
  if (!suffix) return `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`;
  return `${title.slice(0, MAX_TITLE_LENGTH - suffix.length - 1)}…${suffix}`;
}

function kindLabel(kind: WorkItemKind): string {
  return ({
    feature: '功能开发', bugfix: '问题修复', refactor: '代码重构', research: '技术分析',
    tooling: '工具链优化', docs: '文档完善', operations: '交付操作',
  } as const)[kind];
}

function fallbackLabel(kind: WorkItemKind): string {
  return kind === 'research' ? '待确认事项分析' : kindLabel(kind);
}
