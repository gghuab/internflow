import { isMetaMaintenanceText } from '../../core/source-filter.js';
import type { WorkEvidence } from '../../core/contracts/index.js';
import type { WorkItemKind } from '../types.js';

const BUG = /(\bbug\b|修复|错误|异常|故障|回归|不生效|失败|崩溃|错乱)/i;
const BUG_ACTION = /(修复|解决|排查).{0,32}|(?:修改|处理).{0,16}(?:bug|问题|错误|异常|故障|回归|不生效|失败|崩溃|错乱)|(?:bug|问题|错误|异常|故障|回归|不生效|失败|崩溃|错乱).{0,32}(?:修复|解决|排查|处理)/i;
const REFACTOR = /(重构|整理|抽取|解耦|收口|迁移|拆分|架构调整)/i;
const RESEARCH = /(分析|解析|研究|调研|原理|机制|区别|为什么|为啥|代码阅读|学习|走查|排查)/i;
const TOOLING = /(工具|脚本|自动化|工作流|环境|配置|安装|构建链路|生成器|\bcli\b|\bskill\b|\blaunchd\b)/i;
const DOCS = /(文档|readme|说明|注释|指南)/i;
const OPERATIONS = /(发布(?!器)|部署|上线|同步|推送|拉取|合并分支|切换分支|删除.{0,12}分支|清理.{0,12}分支|\bpush\b|\bcommit\b|\bstash\b|\bmr\b|\bpr\b)/i;
const FEATURE = /(需求|新增|添加|实现|开发|接口|字段|交互|页面|功能|\bmock\b)/i;
const FEATURE_ACTION = /(新增|添加|实现|开发|改造|对齐|调整|修改|\bmock\b)/i;
const WORK_SIGNAL = new RegExp([
  BUG.source, REFACTOR.source, RESEARCH.source, TOOLING.source,
  DOCS.source, OPERATIONS.source, FEATURE.source,
  String.raw`\b(src|test|app|packages?)\/|\.(ts|tsx|js|jsx|py|go|rs|java|md)\b`,
].join('|'), 'i');

export function classifyWorkItem(
  goal: string,
  evidence: WorkEvidence[],
  contextText = goal,
): WorkItemKind {
  const hasChange = evidence.some((item) => item.kind === 'change'
    && Boolean(item.files.length || item.codeExcerpts?.length));
  const hasDelivery = evidence.some((item) => item.kind === 'delivery');
  const requestText = evidence.filter((item) => item.kind === 'request').map((item) => item.summary).join('\n');
  const primary = semanticText(goal);
  const requested = semanticText(requestText);
  const changeText = evidence.filter((item) => ['change', 'delivery'].includes(item.kind))
    .map((item) => item.summary).join('\n');

  // 没有实际改动的疑问和解释请求属于研究，不因日志中偶然出现 push/失败而误分类。
  if (!hasChange && !hasDelivery && (RESEARCH.test(primary) || isQuestion(primary))) return 'research';
  // 有真实代码改动时，末尾的推送、提交或删分支只是交付动作，不能覆盖开发类型。
  if (!hasChange && OPERATIONS.test(primary) && !FEATURE_ACTION.test(primary)) return 'operations';
  if (hasChange && REFACTOR.test(primary)) return 'refactor';
  if (hasChange && BUG_ACTION.test(primary)) return 'bugfix';
  if (hasChange && TOOLING.test(primary)) return 'tooling';
  if (hasChange && DOCS.test(primary) && !FEATURE_ACTION.test(primary)) return 'docs';
  if (hasChange && FEATURE_ACTION.test(primary) && (
    !isQuestion(primary) || /(?:请|帮我|能不能|可以).{0,24}(?:新增|添加|实现|开发|改造|对齐|调整|修改|\bmock\b)/i.test(primary)
  )) return 'feature';
  if (hasChange && BUG.test(primary)) return 'bugfix';

  // 主目标信息不足时才参考整组请求，避免长会话里一次偶发报错覆盖真实开发意图。
  if (hasChange && REFACTOR.test(requested)) return 'refactor';
  if (hasChange && BUG_ACTION.test(requested)) return 'bugfix';
  if (hasChange && TOOLING.test(requested) && !FEATURE.test(requested)) return 'tooling';
  if (hasChange && DOCS.test(requested) && !FEATURE.test(requested)) return 'docs';
  if (!hasChange && OPERATIONS.test(`${primary}\n${requested}`)) return 'operations';
  if (!hasChange && RESEARCH.test(contextText)) return 'research';
  return hasChange ? 'feature' : hasDelivery ? 'operations' : 'research';
}

function semanticText(value: string): string {
  return String(value || '')
    .replace(/<image[\s\S]*?<\/image>/gi, ' ')
    .replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isQuestion(value: string): boolean {
  return /[?？]|(?:吗|呢|么|怎么|咋|是否|是不是|能不能|可不可以|什么|为啥|为什么)(?:[，,。.!！]?|$)/.test(value);
}

export function isWorkRelated(text: string, evidence: WorkEvidence[]): boolean {
  if (
    isMetaMaintenanceText(text)
    && !evidence.some((item) => item.kind === 'change' && !isMetaMaintenanceText(item.summary))
  ) {
    return false;
  }
  return evidence.some((item) => ['change', 'verification', 'delivery'].includes(item.kind))
    || WORK_SIGNAL.test(text);
}
