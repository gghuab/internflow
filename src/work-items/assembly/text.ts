import type { Activity, WorkEvidence } from '../../core/contracts/index.js';

export function workGoal(evidence: WorkEvidence[], activities: Activity[]): string {
  const requests = evidence.filter((item) => item.kind === 'request').map((item) => cleanRequest(item.summary));
  // 精准采集已经按 turn 切分时，只看该 turn 的请求，禁止整条长会话的后续追问污染目标。
  const candidates = (requests.length
    ? requests
    : activities.flatMap((item) => [item.firstUserMessage, ...item.userMessages]).map(cleanRequest))
    .filter(Boolean);
  return [...new Set(candidates)].sort((a, b) => goalScore(b) - goalScore(a) || a.length - b.length)[0] || '';
}

export function isCompletionMessage(value: string): boolean {
  return /(已完成|已经完成|完成了|完成并通过|已实现|已修复|测试通过|构建通过|已提交|已发布)/.test(value);
}

export function isUsefulFact(value: string): boolean {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const plain = text.replace(/[*_`]/g, '').trim();
  if (!text || text.length < 4) return false;
  if (/^(?:已|已经)?(?:完成|修复|实现)(?:了)?(?:指定范围内的)?(?:[一二三四五六七八九十\d]+(?:项|个)?)?(?:问题|修改|收敛)?[:：]?$/.test(plain)) return false;
  if (/^(?:(?:先说|核心)?结论|项目|结果|说明|注意|已完成|已修复|已实现)[:：]?$/.test(plain)) return false;
  return true;
}

export function compactFact(value: string): string {
  let text = String(value || '').replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, ' ');
  const requestMarker = text.match(/## My request for Codex:\s*([\s\S]*)$/i);
  if (requestMarker?.[1]) text = requestMarker[1];
  text = text.replace(/```[\s\S]*?```/g, ' ');
  const lines = text.split(/\r?\n|(?<=[。！？])\s*/)
    .map((line) => line.replace(/^[-#*>\s]+/, '').replace(/\s+/g, ' ').trim())
    .filter((line) => line && !/^::[a-z-]+\{/.test(line));
  const preferredIndex = lines.findIndex((line) => /(结论|根因|已完成|已修复|已实现|测试通过|构建通过|提交|发布)/.test(line));
  const preferred = preferredIndex >= 0 ? lines[preferredIndex] || '' : '';
  if (preferred && !isUsefulFact(preferred)) {
    const detail = lines.slice(preferredIndex + 1).find(isUsefulFact);
    if (detail) {
      const heading = preferred.replace(/[*_`]/g, '').replace(/[:：]\s*$/, '');
      return `${heading}：${detail}`.slice(0, 300);
    }
  }
  return (preferred || lines.find(isUsefulFact) || lines[0] || text).slice(0, 300);
}

function cleanRequest(value: string): string {
  let text = String(value || '').replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, ' ');
  const requestMarker = text.match(/## My request for Codex:\s*([\s\S]*)$/i);
  if (requestMarker?.[1]) text = requestMarker[1];
  text = text
    .replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/gi, ' ')
    .replace(/<image[\s\S]*?<\/image>/gi, ' ')
    .replace(/# Files mentioned by the user:[\s\S]*?(?=## My request for Codex:|$)/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 500);
}

const TECHNICAL_OBJECT = /(接口|字段|页面|组件|模块|样式|分支|脚本|配置|模型|流程|数据|文档|主题|颜色)/;

function goalScore(value: string): number {
  let score = value.length >= 6 && value.length <= 180 ? 5 : 0;
  // 接口返回样例只是上一轮问题的上下文，不能压过真实用户目标。
  if (/^[{[]/.test(value) || /"(?:status_code|status_msg|data|result)"\s*:/.test(value)) score -= 30;
  if (/(实现|修复|新增|添加|重构|改造|修改|解决|恢复|改回|回退|撤回|删除|清理|对齐|去掉|推送|发布(?!器)|部署|拉取|合并|\bbug\b)/i.test(value)) score += 9;
  else if (/(分析|解析|研究|总结|复盘|优化|升级|迁移|接口|字段|页面|流程|项目|工具)/.test(value)) score += 5;
  if (TECHNICAL_OBJECT.test(value)) score += 3;
  // 故障/启动症状是有效目标信号，不依赖具体产品名。
  if (/(拉不起来|打不开|启动不了|不能用|没反应|失败|崩溃|报错)/.test(value)) score += 6;
  // 通用口语降权：短指示/催促/纯确认，不绑定任何项目会话原句。
  if (/^(这是|这个|那个|咋|怎么|看下|看一下|赶快输出|输出答案|啥情况|已完成).{0,16}$/i.test(value)) score -= 10;
  if (/^(赶快|直接)?输出(?:一下)?(?:答案|结果)/.test(value)) score -= 10;
  if (/^(?:(?:你)?帮我)?(?:直接)?(?:恢复|修复|修改|删除|清理|调整|处理|弄|改|做)(?:一下)?(?:啊|吧|呀)?$/i.test(value)) score -= 12;
  if (/^第[一二三四五六七八九十\d]+个/.test(value) && !TECHNICAL_OBJECT.test(value)) score -= 12;
  if (/^(?:看不了|没看到|打不开|不行|没用)(?:了|啊|呀|吧)?$/.test(value)) score -= 7;
  if (/^(?:这里|这个|那个|上面|下面)?.{0,16}(?:有这个吗|为啥|为什么|怎么回事|好实现吗)[，,。.!！?？]*$/.test(value)) score -= 10;
  if (/^(噢|哦|明白|所以|也就是说|对)[~，,\s]/.test(value)) score -= 6;
  if (/(?:这个|那个|这部分|这个问题)(?:没看懂|看不懂)?$/.test(value) && !TECHNICAL_OBJECT.test(value)) score -= 6;
  if (/^https?:\/\//.test(value)) score -= 2;
  return score;
}
