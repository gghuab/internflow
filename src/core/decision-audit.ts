import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  DecisionAssessment,
  DecisionAudit,
} from './contracts/index.js';

const decisionRefSchema = z.strictObject({
  kind: z.enum([
    'capture', 'work-evidence', 'work-item', 'daily-report', 'dev-log-candidate',
    'document-heading', 'period-entry', 'job', 'config',
  ]),
  id: z.string().min(1),
});

const evidenceSchema = z.array(decisionRefSchema);
const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const assessmentSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['gate', 'assessment', 'constraint']),
  policyId: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/),
  policyVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  subject: decisionRefSchema,
  outcome: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  gates: z.array(z.strictObject({
    key: z.string().min(1),
    passed: z.boolean(),
    message: z.string().min(1),
    evidence: evidenceSchema,
  })),
  signals: z.array(z.strictObject({
    key: z.string().min(1),
    value: scalarSchema,
    weight: z.number().optional(),
    contribution: z.number().optional(),
    message: z.string().min(1),
  })),
  reasons: z.array(z.strictObject({
    code: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/),
    message: z.string().min(1),
    params: z.record(z.string(), scalarSchema).optional(),
    evidence: evidenceSchema,
  })).min(1),
  evidence: evidenceSchema,
  score: z.strictObject({
    value: z.number().finite(),
    threshold: z.number().finite(),
    direction: z.enum(['higher', 'lower']),
    scale: z.strictObject({ min: z.number().finite(), max: z.number().finite() }).optional(),
  }).optional(),
  constraints: z.array(z.strictObject({
    key: z.string().min(1),
    passed: z.boolean(),
    action: z.enum(['accept', 'trim', 'reject']),
    actual: z.union([z.number(), z.string()]),
    limit: z.union([z.number(), z.string()]),
    message: z.string().min(1),
  })),
});

const auditSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1),
  mode: z.enum(['shadow', 'enforced']),
  job: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1),
  snapshotId: z.string().nullable(),
  inputFingerprint: z.string().min(1),
  generatedAt: z.string().datetime({ offset: true }),
  policyVersions: z.record(z.string(), z.string()),
  assessments: z.array(assessmentSchema),
});

export function decisionId(input: Omit<DecisionAssessment, 'id'>): string {
  return digest(input).slice(0, 24);
}

export function withDecisionId<T extends Omit<DecisionAssessment, 'id'>>(input: T): T & { id: string } {
  return { ...input, id: decisionId(input) };
}

export function validateDecisionAssessment(value: unknown): DecisionAssessment {
  const parsed = assessmentSchema.parse(value) as DecisionAssessment;
  if (parsed.kind !== 'assessment' && parsed.score) {
    throw new Error(`${parsed.kind} cannot carry a score.`);
  }
  if (parsed.score?.scale && parsed.score.scale.min >= parsed.score.scale.max) {
    throw new Error('Decision score scale min must be less than max.');
  }
  return parsed;
}

export function buildDecisionAudit(input: {
  mode?: DecisionAudit['mode'];
  job: string;
  date: string;
  timezone: string;
  snapshotId?: string | null;
  inputFingerprint: string;
  generatedAt?: string;
  assessments: DecisionAssessment[];
}): DecisionAudit {
  const assessments = input.assessments.map(validateDecisionAssessment);
  const policyVersions = Object.fromEntries(
    [...new Set(assessments.map((item) => `${item.policyId}\0${item.policyVersion}`))]
      .sort()
      .map((value) => value.split('\0') as [string, string]),
  );
  const content = {
    mode: input.mode || 'enforced',
    job: input.job,
    date: input.date,
    timezone: input.timezone,
    snapshotId: input.snapshotId || null,
    inputFingerprint: input.inputFingerprint,
    policyVersions,
    assessments,
  };
  return validateDecisionAudit({
    version: 1,
    id: digest(content).slice(0, 24),
    generatedAt: input.generatedAt || new Date().toISOString(),
    ...content,
  });
}

export function validateDecisionAudit(value: unknown): DecisionAudit {
  return auditSchema.parse(value) as DecisionAudit;
}

export function decisionFingerprint(value: unknown): string {
  return digest(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
