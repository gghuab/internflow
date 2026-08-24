import { z } from 'zod';

const cited = {
  workItemId: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).min(1).max(100),
};

export const dailyDraftSchema = z.strictObject({
  headline: z.string().min(8).max(160),
  overview: z.string().min(40).max(1_500),
  today: z.array(z.strictObject({
    ...cited,
    relatedWorkItemIds: z.array(z.string().min(1)).max(100),
    detailLevel: z.enum(['full', 'brief']),
    title: z.string().min(1).max(80),
    background: z.string().min(1).max(600),
    progress: z.array(z.string().min(1).max(500)).min(1).max(5),
    keyDecision: z.string().max(700),
    result: z.string().min(1).max(600),
    openQuestions: z.string().max(500),
  })).max(20),
  deepDives: z.array(z.strictObject({
    ...cited,
    title: z.string().min(1).max(120),
    conclusion: z.string().min(1).max(700),
    mechanism: z.string().min(1).max(1_000),
    evidence: z.string().min(1).max(700),
    boundary: z.string().min(1).max(700),
  })).max(3),
  takeaways: z.array(z.strictObject({
    ...cited,
    method: z.string().min(1).max(120),
    applicability: z.string().min(1).max(700),
    defaultAction: z.string().min(1).max(700),
    completionCriteria: z.string().min(1).max(700),
    avoid: z.string().min(1).max(700),
  })).max(2),
  diagrams: z.array(z.strictObject({
    title: z.string().min(1).max(80),
    mermaid: z.string().min(1).max(2_000),
    workItemId: z.string().min(1).nullable(),
    assessmentId: z.string().min(1),
  })).max(3),
  suggestions: z.array(z.strictObject({
    workItemId: z.string().min(1).nullable(),
    priority: z.enum(['P0', 'P1', 'P2']),
    text: z.string().min(1).max(500),
    completionCriteria: z.string().min(1).max(500),
  })).min(1).max(4),
  agentCandidates: z.array(z.string().min(1).max(500)).max(8),
});

export type DailyDraft = z.infer<typeof dailyDraftSchema>;

export const dailyDraftJsonSchema = {
  type: 'object', additionalProperties: false,
  required: [
    'headline', 'overview', 'today', 'deepDives', 'takeaways',
    'diagrams', 'suggestions', 'agentCandidates',
  ],
  properties: {
    headline: stringSchema(160),
    overview: stringSchema(1_500),
    today: arrayOf({
      workItemId: stringSchema(),
      relatedWorkItemIds: stringArray(0),
      detailLevel: { type: 'string', enum: ['full', 'brief'] },
      title: stringSchema(80),
      background: stringSchema(600),
      progress: boundedStringArray(1, 5, 500),
      keyDecision: { type: 'string', maxLength: 700 },
      result: stringSchema(600),
      openQuestions: { type: 'string', maxLength: 500 },
      evidenceIds: stringArray(),
    }, 20),
    deepDives: arrayOf({
      workItemId: stringSchema(),
      title: stringSchema(120),
      conclusion: stringSchema(700),
      mechanism: stringSchema(1_000),
      evidence: stringSchema(700),
      boundary: stringSchema(700),
      evidenceIds: stringArray(),
    }, 3),
    takeaways: arrayOf({
      workItemId: stringSchema(),
      method: stringSchema(120),
      applicability: stringSchema(700),
      defaultAction: stringSchema(700),
      completionCriteria: stringSchema(700),
      avoid: stringSchema(700),
      evidenceIds: stringArray(),
    }, 2),
    diagrams: arrayOf({
      title: stringSchema(80),
      mermaid: stringSchema(2_000),
      workItemId: { anyOf: [stringSchema(), { type: 'null' }] },
      assessmentId: stringSchema(),
    }, 3),
    suggestions: arrayOf({
      workItemId: { anyOf: [stringSchema(), { type: 'null' }] },
      priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
      text: stringSchema(500),
      completionCriteria: stringSchema(500),
    }, 4, undefined, 1),
    agentCandidates: { type: 'array', maxItems: 8, items: stringSchema(500) },
  },
} as const;

function stringSchema(maxLength?: number) {
  return { type: 'string', minLength: 1, ...(maxLength ? { maxLength } : {}) } as const;
}

function stringArray(minItems = 1) {
  return { type: 'array', minItems, maxItems: 100, items: stringSchema() } as const;
}

function boundedStringArray(minItems: number, maxItems: number, maxLength: number) {
  return { type: 'array', minItems, maxItems, items: stringSchema(maxLength) } as const;
}

function arrayOf(
  properties: Record<string, unknown>,
  maxItems: number,
  required: string[] | undefined = Object.keys(properties),
  minItems?: number,
) {
  return {
    type: 'array', maxItems, ...(minItems ? { minItems } : {}),
    items: { type: 'object', additionalProperties: false, required, properties },
  } as const;
}
