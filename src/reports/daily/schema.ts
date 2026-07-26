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
    title: z.string().min(1).max(80),
    background: z.string().min(1).max(600),
    story: z.string().min(1).max(1_500),
    result: z.string().min(1).max(600),
    openQuestions: z.string().max(500),
  })).max(20),
  deepDives: z.array(z.strictObject({
    ...cited,
    knowledge: z.string().min(1).max(120),
    background: z.string().min(1).max(700),
    mechanism: z.string().min(1).max(1_000),
    defaultAction: z.string().min(1).max(700),
    verification: z.string().min(1).max(700),
    antiPattern: z.string().min(1).max(700),
  })).max(8),
  takeaways: z.array(z.strictObject({
    ...cited,
    method: z.string().min(1).max(120),
    keyPoint: z.string().min(1).max(700),
    defaultAction: z.string().min(1).max(700),
    verification: z.string().min(1).max(700),
    antiPattern: z.string().min(1).max(700),
  })).max(8),
  diagrams: z.array(z.strictObject({
    title: z.string().min(1).max(80),
    mermaid: z.string().min(1).max(2_000),
    workItemId: z.string().min(1).nullable(),
    assessmentId: z.string().min(1),
  })).max(6),
  suggestions: z.array(z.strictObject({
    workItemId: z.string().min(1).nullable(),
    text: z.string().min(1).max(500),
    why: z.string().max(400),
  })).min(1).max(6),
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
      title: stringSchema(80),
      background: stringSchema(600),
      story: stringSchema(1_500),
      result: stringSchema(600),
      openQuestions: { type: 'string', maxLength: 500 },
      evidenceIds: stringArray(),
    }, 20),
    deepDives: arrayOf({
      workItemId: stringSchema(),
      knowledge: stringSchema(120),
      background: stringSchema(700),
      mechanism: stringSchema(1_000),
      defaultAction: stringSchema(700),
      verification: stringSchema(700),
      antiPattern: stringSchema(700),
      evidenceIds: stringArray(),
    }, 8),
    takeaways: arrayOf({
      workItemId: stringSchema(),
      method: stringSchema(120),
      keyPoint: stringSchema(700),
      defaultAction: stringSchema(700),
      verification: stringSchema(700),
      antiPattern: stringSchema(700),
      evidenceIds: stringArray(),
    }, 8),
    diagrams: arrayOf({
      title: stringSchema(80),
      mermaid: stringSchema(2_000),
      workItemId: { anyOf: [stringSchema(), { type: 'null' }] },
      assessmentId: stringSchema(),
    }, 6),
    suggestions: arrayOf({
      workItemId: { anyOf: [stringSchema(), { type: 'null' }] },
      text: stringSchema(500),
      why: { type: 'string', maxLength: 400 },
    }, 6, undefined, 1),
    agentCandidates: { type: 'array', maxItems: 8, items: stringSchema(500) },
  },
} as const;

function stringSchema(maxLength?: number) {
  return { type: 'string', minLength: 1, ...(maxLength ? { maxLength } : {}) } as const;
}

function stringArray(minItems = 1) {
  return { type: 'array', minItems, maxItems: 100, items: stringSchema() } as const;
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
