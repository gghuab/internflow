import { createHash } from 'node:crypto';

const DEFAULT_BRANCHES = new Set(['', 'main', 'master', 'develop', 'development', 'trunk']);
const ACTION_NOISE = /(?:继续|帮我|帮忙|请|麻烦|需要|进行|开始|完成|新增|添加|实现|修改|修复|完善|优化|升级|调整|处理|分析|查看|研究|一下)/g;
const GENERIC_TOPIC = /(?:项目|代码|功能|需求|问题|任务|工作|内容|相关)/g;

export interface SubjectInput {
  repositoryKey: string;
  branch?: string;
  files: string[];
  goal: string;
  fallbackKey?: string;
}

export function subjectKeyFor(input: SubjectInput): string {
  const repositoryKey = normalizeValue(input.repositoryKey) || 'unknown-repository';
  const branch = normalizeBranch(input.branch || '');
  const branchScope = DEFAULT_BRANCHES.has(branch) ? '' : branch;
  const fileScope = stableFileScope(input.files);
  const topic = stableTopic(input.goal);
  const scope = [branchScope, fileScope, topic].filter(Boolean).join('|')
    || normalizeValue(input.fallbackKey || '')
    || 'unknown-subject';
  return stableHash(`${repositoryKey}|${scope}`);
}

export function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableTopic(value: string): string {
  const normalized = normalizeValue(value)
    .replace(ACTION_NOISE, ' ')
    .replace(GENERIC_TOPIC, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const latin = normalized.match(/[a-z0-9][a-z0-9_-]+/gi) || [];
  const han = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
  return [...new Set([...latin.map((item) => item.toLowerCase()), ...han])].sort().join('-').slice(0, 120);
}

function stableFileScope(files: string[]): string {
  return [...new Set(files.map((file) => normalizeValue(file).replace(/^\.\//, '')).filter(Boolean))]
    .sort()
    .slice(0, 4)
    .join(',');
}

function normalizeBranch(branch: string): string {
  return normalizeValue(branch).replace(/^refs\/heads\//, '');
}

function normalizeValue(value: string): string {
  return String(value || '').toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
}
