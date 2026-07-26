import type { SourceConfig } from './config.js';
import type { Activity } from './contracts/index.js';

/**
 * 内置元维护噪音：排除「写日报 / 维护日报脚本」本身，以及 longest-task 自指。
 * 不收录任何产品特性名或业务域词；个性化排除请走 source.exclude。
 */
export const META_MAINTENANCE_PATTERN = /(codex\s*日报|daily-report|reports?[/\\](?:daily|dev-log)|longest task|日报)/i;

export function isMetaMaintenanceText(text: string): boolean {
  return META_MAINTENANCE_PATTERN.test(text);
}

export function matchesConfiguredSourceFilters(activity: Activity, config: SourceConfig): boolean {
  return matchesConfiguredText(activitySearchText(activity), config);
}

export function matchesConfiguredText(text: string, config: SourceConfig): boolean {
  const exclude = compilePatterns(config.exclude || []);
  if (exclude.some((pattern) => pattern.test(text))) return false;
  const include = compilePatterns(config.include || []);
  return !include.length || include.some((pattern) => pattern.test(text));
}

function activitySearchText(activity: Activity): string {
  return [
    activity.title,
    activity.cwd,
    activity.gitBranch,
    activity.firstUserMessage,
    ...activity.userMessages,
    ...activity.assistantMessages,
    ...activity.changedFiles,
    ...activity.commands.map((command) => `${command.command}\n${command.cwd}`),
  ].filter(Boolean).join('\n');
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, 'i');
    } catch (error) {
      throw new Error(`Invalid source filter pattern ${JSON.stringify(pattern)}: ${String(error)}`);
    }
  });
}
