import type { WorkEvidence } from '../../core/contracts/index.js';
import type { WorkVerification } from '../types.js';

export function normalizeVerificationCommand(command: string): string {
  return command
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:--runInBand|--watch=false|--no-color)\b/g, '')
    .trim()
    .toLowerCase();
}

export function reduceVerifications(evidence: WorkEvidence[]): WorkVerification[] {
  const groups = new Map<string, WorkEvidence[]>();
  for (const item of evidence) {
    if (!item.verification) continue;
    const key = normalizeVerificationCommand(item.verification.command);
    const values = groups.get(key) || [];
    values.push(item);
    groups.set(key, values);
  }
  return [...groups.entries()].map(([normalizedCommand, values]) => {
    const ordered = [...values].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
    const final = [...ordered].reverse().find((item) => item.verification?.exitCode !== null) || ordered.at(-1);
    if (!final?.verification) throw new Error(`Verification group ${normalizedCommand} has no details.`);
    return {
      command: final.verification.command,
      normalizedCommand,
      outcome: final.verification.outcome,
      exitCode: final.verification.exitCode,
      timestamp: final.timestamp,
      evidenceIds: ordered.map((item) => item.id),
      affectedFiles: [...new Set(ordered.flatMap((item) => item.files).map(normalizePath))],
    };
  }).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.normalizedCommand.localeCompare(b.normalizedCommand));
}

export function verificationAppliesToFiles(
  verification: WorkVerification,
  changedFiles: string[],
): boolean {
  if (!changedFiles.length) return true;
  const commandFiles = verification.command.match(
    /(?:^|\s)([^\s'"`]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|less|py|go|rs|java|md|yaml|yml|sh))(?=\s|$)/gi,
  )?.map((value) => normalizePath(value.trim())) || [];
  const affectedFiles = verification.affectedFiles?.map(normalizePath) || [];
  const scopedFiles = [...new Set([...commandFiles, ...affectedFiles])];
  if (!scopedFiles.length) return true;
  const normalizedChanges = changedFiles.map(normalizePath);
  return scopedFiles.some((commandFile) => normalizedChanges.some((changedFile) => (
    changedFile === commandFile
    || changedFile.endsWith(`/${commandFile}`)
    || commandFile.endsWith(`/${changedFile}`)
  )));
}

function normalizePath(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase();
}
