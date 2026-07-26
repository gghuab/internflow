export function redact(value: string): string {
  return value
    .replace(/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gi, '-----BEGIN $1-----\n[REDACTED]\n-----END $1-----')
    .replace(/(^|\r?\n)([ \t]*(?:set-)?cookie[ \t]*:[ \t]*)[^\r\n]*/gim, '$1$2[REDACTED]')
    .replace(/(^|\r?\n)([ \t]*authorization[ \t]*:[ \t]*)(?:Bearer|Basic)\s+[^\r\n]+/gim, '$1$2[REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[REDACTED]:[REDACTED]@')
    .replace(/(["'](?:[A-Za-z0-9_.-]*(?:token|secret|password|api[_-]?key|access[_-]?key|private[_-]?key)|authorization|cookie|passphrase|signature)["']\s*:\s*)(["'])(?:\\.|(?!\2)[^\\\r\n])*\2/gi, '$1$2[REDACTED]$2')
    .replace(/([?&](?:access[_-]?token|refresh[_-]?token|api[_-]?key|token|key|secret|password|signature)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b([A-Z][A-Z0-9_]*_(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY))\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/g, '$1=[REDACTED]')
    .replace(/\b(token|secret|password|cookie|api[_-]?key|authorization)\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, '[REDACTED]');
}

export function truncate(value: string, max: number): string {
  const clean = value.replace(/\u001b\[[0-9;]*m/g, '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}\n...[truncated ${clean.length - max} chars]`;
}

const IDE_CONTEXT_PREFIXES = [
  '# Context from my IDE setup:',
  '# Files mentioned by the user:',
];
const USER_REQUEST_MARKER = /^## My request for Codex:\s*/im;

export function userAuthoredMessage(text: string): string {
  const value = text.trim();
  if (!IDE_CONTEXT_PREFIXES.some((prefix) => value.startsWith(prefix))) return value;
  const marker = USER_REQUEST_MARKER.exec(value);
  if (!marker) return '';
  return value.slice(marker.index + marker[0].length).trim();
}

export function isInjectedContext(text: string): boolean {
  const value = text.trim();
  return value.startsWith('# AGENTS.md instructions')
    || value.startsWith('<environment_context>')
    || value.startsWith('<INSTRUCTIONS>')
    || value.startsWith('<skill>')
    || value.startsWith('<turn_aborted>')
    || value.startsWith('<recommended_plugins>')
    || value.startsWith('<permissions instructions>')
    || IDE_CONTEXT_PREFIXES.some((prefix) => value.startsWith(prefix));
}
