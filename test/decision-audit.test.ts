import { describe, expect, it } from 'vitest';
import {
  buildDecisionAudit,
  validateDecisionAssessment,
  withDecisionId,
} from '../src/core/decision-audit.js';
import type { DecisionAssessment } from '../src/core/contracts/index.js';

describe('decision audit contract', () => {
  it('allows an unscored gate and rejects a scored constraint', () => {
    expect(() => validateDecisionAssessment(gate())).not.toThrow();
    expect(() => validateDecisionAssessment({
      ...constraint(),
      score: { value: 8, threshold: 5, direction: 'higher' },
    })).toThrow(/constraint cannot carry a score/);
  });

  it('requires stable policy identity and at least one reason', () => {
    expect(() => validateDecisionAssessment({ ...gate(), policyId: '' })).toThrow();
    expect(() => validateDecisionAssessment({ ...gate(), reasons: [] })).toThrow();
  });

  it('keeps scores local to each policy and builds deterministic content ids', () => {
    const first = scored('daily.visual-need', 'inline');
    const second = scored('devlog.admission', 'exclude');
    const input = {
      job: 'daily-report', date: '2026-07-17', timezone: 'Asia/Shanghai',
      snapshotId: 'snapshot', inputFingerprint: 'input', assessments: [first, second],
      generatedAt: '2026-07-17T23:30:00+08:00',
    };
    const left = buildDecisionAudit(input);
    const right = buildDecisionAudit(input);

    expect(first.score?.value).toBe(second.score?.value);
    expect(first.outcome).not.toBe(second.outcome);
    expect(left.id).toBe(right.id);
    expect(left.policyVersions).toEqual({
      'daily.visual-need': '1.0.0',
      'devlog.admission': '1.0.0',
    });
  });
});

function gate(): DecisionAssessment {
  return withDecisionId({
    kind: 'gate', policyId: 'capture.coverage', policyVersion: '1.0.0',
    subject: { kind: 'capture', id: 'snapshot' }, outcome: 'accept', confidence: 'high',
    gates: [{ key: 'clean-ledger', passed: true, message: '事件账本完整', evidence: [] }],
    signals: [], reasons: [{ code: 'capture.coverage.clean', message: '事件账本完整', evidence: [] }],
    evidence: [], constraints: [],
  });
}

function constraint(): DecisionAssessment {
  return withDecisionId({
    kind: 'constraint', policyId: 'daily.mermaid-safety', policyVersion: '1.0.0',
    subject: { kind: 'daily-report', id: '2026-07-17' }, outcome: 'accept', confidence: 'high',
    gates: [], signals: [], reasons: [{ code: 'daily.mermaid-safety.accepted', message: '图示格式安全', evidence: [] }],
    evidence: [], constraints: [{
      key: 'line-count', passed: true, action: 'accept', actual: 4, limit: 40, message: '未超过行数限制',
    }],
  });
}

function scored(policyId: string, outcome: string): DecisionAssessment {
  return withDecisionId({
    kind: 'assessment', policyId, policyVersion: '1.0.0',
    subject: { kind: 'work-item', id: policyId }, outcome, confidence: 'high', gates: [],
    signals: [{ key: 'value', value: 6, weight: 1, contribution: 6, message: '领域信号' }],
    reasons: [{ code: `${policyId}.evaluated`, message: '已按领域标准评价', evidence: [] }],
    evidence: [], score: { value: 6, threshold: 6, direction: 'higher' }, constraints: [],
  });
}
