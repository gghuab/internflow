import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const fixtures = ['development', 'learning', 'fail-then-pass', 'cross-session', 'irrelevant'];

describe('work-layer fixture baseline', () => {
  it.each(fixtures)('keeps traceable confirmed evidence in %s', async (name) => {
    const path = join(process.cwd(), 'test', 'fixtures', 'work-layer', `${name}.json`);
    const fixture = JSON.parse(await readFile(path, 'utf8')) as {
      evidence: Array<{ status: string; sourceEventIds: string[] }>;
      expected: { sourceEventCount: number };
    };

    expect(new Set(fixture.evidence.flatMap((item) => item.sourceEventIds)).size)
      .toBe(fixture.expected.sourceEventCount);
    expect(fixture.evidence.every((item) => item.status === 'confirmed')).toBe(true);
  });
});
