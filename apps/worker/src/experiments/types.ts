/**
 * Phase 9 — advanced experiments.
 *
 * The rule this module exists to enforce (Phases §17): a technique is kept only
 * when it measurably improves the FIRST response without making correctness or
 * missed-job rate worse, and techniques are never all switched on at once just
 * to tick the list — some of them interact or add jitter.
 *
 * So an experiment is not a boolean flag. It is a record with a hypothesis, a
 * baseline, a sample-size floor, a stated failure impact and a rollback, and it
 * cannot be enabled next to one it conflicts with.
 */

/** Where the evidence for a verdict came from. */
export const EVIDENCE_KINDS = ['none', 'local-replay', 'live-paired', 'host-profile'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EXPERIMENT_STATES = [
  /** Defined, never switched on. */
  'not-run',
  /** Currently on and collecting samples. */
  'running',
  /** Measured to help; on by default. */
  'adopted',
  /** Measured not to help (or to hurt); off, kept for the record. */
  'rejected',
  /** Cannot run here — needs host control or a dependency we do not have. */
  'blocked',
] as const;
export type ExperimentState = (typeof EXPERIMENT_STATES)[number];

export interface ExperimentDefinition {
  readonly id: string;
  readonly title: string;
  /** What we expect to improve, and why. Stated before the run, not after. */
  readonly hypothesis: string;
  /** The measurement that decides it, named as it appears in metrics. */
  readonly metric: string;
  /** No verdict is allowed below this many paired samples per arm. */
  readonly minSamples: number;
  /** What goes wrong if it misfires in production. */
  readonly failureImpact: string;
  /** Exactly how it gets switched off. Every experiment must have one. */
  readonly rollback: string;
  /** Ids that must never be on at the same time as this one. */
  readonly conflictsWith?: readonly string[];
  /** True when it needs privileges/tuning the host may not grant. */
  readonly requiresHostControl?: boolean;
}

export interface ExperimentRecord extends ExperimentDefinition {
  readonly state: ExperimentState;
  /** Why it is in that state, in one line. */
  readonly note: string;
  readonly evidence: EvidenceKind;
}
