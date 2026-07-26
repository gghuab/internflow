export function parseJsonLine(line: string): unknown | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => isRecord(item)
      ? stringValue(item.text || item.content || (isRecord(item.input_text) ? item.input_text.text : ''))
      : '')
    .filter(Boolean)
    .join('\n');
}
