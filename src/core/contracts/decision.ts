export type DecisionKind = 'gate' | 'assessment' | 'constraint';
export type DecisionConfidence = 'high' | 'medium' | 'low';
export type DecisionScalar = string | number | boolean | null;

export interface DecisionRef {
  kind:
    | 'capture'
    | 'work-evidence'
    | 'work-item'
    | 'daily-report'
    | 'dev-log-candidate'
    | 'document-heading'
    | 'period-entry'
    | 'job'
    | 'config';
  id: string;
}

export interface DecisionReason {
  code: string;
  message: string;
  params?: Record<string, DecisionScalar>;
  evidence: DecisionRef[];
}

export interface DecisionSignal {
  key: string;
  value: DecisionScalar;
  weight?: number;
  contribution?: number;
  message: string;
}

export interface DecisionGate {
  key: string;
  passed: boolean;
  message: string;
  evidence: DecisionRef[];
}

export interface DecisionScore {
  value: number;
  threshold: number;
  direction: 'higher' | 'lower';
  scale?: { min: number; max: number };
}

export interface DecisionConstraint {
  key: string;
  passed: boolean;
  action: 'accept' | 'trim' | 'reject';
  actual: number | string;
  limit: number | string;
  message: string;
}

export interface DecisionAssessment<TOutcome extends string = string> {
  id: string;
  kind: DecisionKind;
  policyId: string;
  policyVersion: string;
  subject: DecisionRef;
  outcome: TOutcome;
  confidence: DecisionConfidence;
  gates: DecisionGate[];
  signals: DecisionSignal[];
  reasons: DecisionReason[];
  evidence: DecisionRef[];
  score?: DecisionScore;
  constraints: DecisionConstraint[];
}

export interface Evaluated<T> {
  value: T;
  assessment: DecisionAssessment;
}

export interface DecisionAudit {
  version: 1;
  id: string;
  mode: 'shadow' | 'enforced';
  job: string;
  date: string;
  timezone: string;
  snapshotId: string | null;
  inputFingerprint: string;
  generatedAt: string;
  policyVersions: Record<string, string>;
  assessments: DecisionAssessment[];
}
