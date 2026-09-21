import { ConfigError, ValidationError } from '../errors/base.ts';
import type {
  EvidenceKind,
  ExperimentDefinition,
  ExperimentRecord,
  ExperimentState,
} from './types.ts';

export interface RegistryOptions {
  /** How many experiments may be on at once. One, unless you can argue
   * otherwise: interactions between two live techniques are unattributable
   * (Phases §17: "ไม่เปิดทุก option พร้อมกันเพียงเพื่อให้ครบรายการ"). */
  maxConcurrent?: number;
}

interface Entry {
  definition: ExperimentDefinition;
  state: ExperimentState;
  note: string;
  evidence: EvidenceKind;
}

const ACTIVE: ReadonlySet<ExperimentState> = new Set<ExperimentState>(['running', 'adopted']);

/**
 * The experiment registry.
 *
 * It holds the paper trail and it refuses the two mistakes that make an
 * experiment programme worthless: switching on two techniques that interact,
 * and declaring a winner from a run that was never defined as a test.
 */
export class ExperimentRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #maxConcurrent: number;

  constructor(definitions: readonly ExperimentDefinition[], options: RegistryOptions = {}) {
    this.#maxConcurrent = options.maxConcurrent ?? 1;
    for (const definition of definitions) this.#define(definition);
    this.#assertConflictsResolve();
  }

  get all(): readonly ExperimentRecord[] {
    return [...this.#entries.values()].map(toRecord);
  }

  get active(): readonly ExperimentRecord[] {
    return this.all.filter((r) => ACTIVE.has(r.state));
  }

  get(id: string): ExperimentRecord | undefined {
    const entry = this.#entries.get(id);
    return entry === undefined ? undefined : toRecord(entry);
  }

  /** True only for an experiment that is on right now. Callers gate on this. */
  isOn(id: string): boolean {
    const state = this.#entries.get(id)?.state;
    return state !== undefined && ACTIVE.has(state);
  }

  /**
   * Switch an experiment on for measurement.
   *
   * Rejects a technique that conflicts with one already on, one that needs host
   * control the operator has not confirmed, and any request that would exceed
   * the concurrency ceiling.
   */
  start(id: string, options: { hostControlConfirmed?: boolean } = {}): ExperimentRecord {
    const entry = this.#require(id);
    if (ACTIVE.has(entry.state)) return toRecord(entry);

    if (entry.definition.requiresHostControl === true && options.hostControlConfirmed !== true) {
      throw new ValidationError('experiment needs confirmed host control', {
        id,
        hint: 'profile the host and pass hostControlConfirmed',
      });
    }

    const blocker = this.#conflictOn(entry.definition);
    if (blocker !== undefined) {
      throw new ValidationError('experiment conflicts with an active one', { id, blocker });
    }

    const onNow = this.active.length;
    if (onNow >= this.#maxConcurrent) {
      throw new ValidationError('too many experiments on at once', {
        id,
        onNow,
        maxConcurrent: this.#maxConcurrent,
        hint: 'two live techniques make an improvement unattributable',
      });
    }

    entry.state = 'running';
    entry.note = 'collecting samples';
    return toRecord(entry);
  }

  /**
   * Record a verdict. `adopt` demands evidence and a sample count that clears
   * the experiment's own floor, so a good-looking single run cannot promote a
   * technique.
   */
  conclude(
    id: string,
    verdict: 'adopt' | 'reject',
    detail: { note: string; evidence: EvidenceKind; samples?: number },
  ): ExperimentRecord {
    const entry = this.#require(id);
    if (verdict === 'adopt') {
      if (detail.evidence === 'none') {
        throw new ValidationError('cannot adopt an experiment with no evidence', { id });
      }
      const samples = detail.samples ?? 0;
      if (samples < entry.definition.minSamples) {
        throw new ValidationError('cannot adopt below the sample floor', {
          id,
          samples,
          minSamples: entry.definition.minSamples,
        });
      }
    }
    entry.state = verdict === 'adopt' ? 'adopted' : 'rejected';
    entry.note = detail.note;
    entry.evidence = detail.evidence;
    return toRecord(entry);
  }

  /** Roll back to off, whatever the state. This is the escape hatch every
   * definition promises; it never throws. */
  rollback(id: string, note: string): ExperimentRecord | undefined {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    entry.state = 'rejected';
    entry.note = note;
    return toRecord(entry);
  }

  /** Marks an experiment as impossible here — no host control, no dependency.
   * Distinct from `rejected`, which means measured and not worth it. */
  block(id: string, note: string): ExperimentRecord {
    const entry = this.#require(id);
    entry.state = 'blocked';
    entry.note = note;
    return toRecord(entry);
  }

  #define(definition: ExperimentDefinition): void {
    if (this.#entries.has(definition.id)) {
      throw new ConfigError('duplicate experiment id', { id: definition.id });
    }
    if (definition.rollback.trim() === '') {
      throw new ConfigError('experiment has no rollback', { id: definition.id });
    }
    if (definition.minSamples < 1) {
      throw new ConfigError('experiment sample floor must be positive', { id: definition.id });
    }
    this.#entries.set(definition.id, {
      definition,
      state: definition.requiresHostControl === true ? 'blocked' : 'not-run',
      note: definition.requiresHostControl === true
        ? 'needs host profiling before it can run'
        : 'defined',
      evidence: 'none',
    });
  }

  /** A conflict list naming an id that does not exist hides a typo, and a typo
   * here silently lets two interacting techniques run together. */
  #assertConflictsResolve(): void {
    for (const entry of this.#entries.values()) {
      for (const other of entry.definition.conflictsWith ?? []) {
        if (!this.#entries.has(other)) {
          throw new ConfigError('experiment conflicts with an unknown id', {
            id: entry.definition.id,
            unknown: other,
          });
        }
      }
    }
  }

  /** Conflict is symmetric even when only one side declares it. */
  #conflictOn(definition: ExperimentDefinition): string | undefined {
    for (const other of this.active) {
      if (definition.conflictsWith?.includes(other.id) === true) return other.id;
      if (other.conflictsWith?.includes(definition.id) === true) return other.id;
    }
    return undefined;
  }

  #require(id: string): Entry {
    const entry = this.#entries.get(id);
    if (entry === undefined) throw new ValidationError('unknown experiment', { id });
    return entry;
  }
}

function toRecord(entry: Entry): ExperimentRecord {
  return {
    ...entry.definition,
    state: entry.state,
    note: entry.note,
    evidence: entry.evidence,
  };
}
