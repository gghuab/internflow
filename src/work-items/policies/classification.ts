import { isMetaMaintenanceText } from '../../core/source-filter.js';
import type { WorkEvidence } from '../../core/contracts/index.js';
import type { WorkItemKind } from '../types.js';

const BUG = /(\bbug\b|修复|错误|异常|故障|回归|不生效|失败|崩溃|错乱|无法|(?<!能)不能|没显示|不显示|不正确|无响应|卡住|卡手|缺失|重复(?:请求|加载|触发|显示|提交|上报))/i;
const BUG_ACTION = /(修复|解决|排查|改回|恢复|撤销).{0,32}|(?:删除|去掉|清理).{0,24}(?:适配|改动|修改|逻辑|代码)|(?:修改|处理).{0,16}(?:bug|问题|错误|异常|故障|回归|不生效|失败|崩溃|错乱)|(?:bug|问题|错误|异常|故障|回归|不生效|失败|崩溃|错乱).{0,32}(?:修复|解决|排查|处理|改回|恢复|撤销)/i;
const REFACTOR = /(重构|整理|抽取|解耦|收口|迁移|拆分|架构调整)/i;
const RESEARCH = /(分析|解析|研究|调研|原理|机制|区别|为什么|为啥|代码阅读|学习|走查|排查)/i;
const TOOLING = /(工具|脚本|自动化|工作流|环境|配置|安装|构建链路|生成器|\bcli\b|\bskill\b|\blaunchd\b)/i;
const DOCS = /(文档|readme|说明|注释|指南)/i;
const OPERATIONS = /(发布(?!器)|部署|上线|同步|推送|拉取|合并分支|切换分支|删除.{0,12}分支|清理.{0,12}分支|撤回.{0,16}(?:提交|版本号)|回退.{0,16}(?:提交|分支)|\bpush\b|\bcommit\b|\bstash\b|\bmr\b|\bpr\b)/i;
const PURE_DELIVERY = /(?:撤回|回退|还原).{0,20}(?:提交|commit|版本号|分支)|(?:删除|清理).{0,12}分支/i;
const WORKTREE_CLEANUP = /(?:git\s*diff|git.{0,12}(?:更改|变化)|无关的?更改|不该改|自动生成|生成基线|git\s*ignore|\.gitignore|只有.{0,8}行)/i;
const FEATURE = /(需求|新增|添加|实现|开发|接口|字段|交互|页面|功能|\bmock\b)/i;
const FEATURE_ACTION = /(新增|添加|实现|开发|改造|对齐|\bmock\b)/i;
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
  const changedFiles = evidence.filter((item) => item.kind === 'change').flatMap((item) => item.files);
  const branch = evidence.find((item) => item.branch)?.branch || '';
  const fixBranch = /(?:^|[/_-])(?:fix|bugfix|hotfix)(?:[/_-]|$)|(?:^|[/_-])bug(?:[/_-]|$)/i.test(branch);
  const onlyDeliveryMetadataChanged = changedFiles.length > 0 && changedFiles.every((file) => (
    /(?:^|\/)(?:package(?:-lock)?\.json|[^/]*version[^/]*|tsconfig\.tsbuildinfo|\.gitignore)$/i.test(file)
  ));

  // 没有实际改动的疑问和解释请求属于研究，不因日志中偶然出现 push/失败而误分类。
  if (!hasChange && !hasDelivery && (RESEARCH.test(primary) || isQuestion(primary))) return 'research';
  // 撤回版本提交、清理分支等即使会改工作区，也仍是交付操作，不是新的产品需求。
  if (PURE_DELIVERY.test(primary) && (!hasChange || onlyDeliveryMetadataChanged)) return 'operations';
  if (hasChange && WORKTREE_CLEANUP.test(primary)) return 'operations';
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
  // 修复分支上的中性“调整/修改”默认属于缺陷收敛；明确的新增、实现仍会在上面判为 feature。
  if (hasChange && fixBranch) return 'bugfix';

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
