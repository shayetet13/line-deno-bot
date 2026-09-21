import { ConfigError } from '../errors/base.ts';

/**
 * One worker process and the owners it is responsible for.
 *
 * Sharding is by OWNER, never by individual bot: sibling bots of one owner
 * share owner-level room claims and primary/secondary handoff, and those live
 * in one process's memory. Splitting an owner across workers silently breaks
 * "only one sibling answers" (Playbook §14.3, §19).
 */
export interface ShardSpec {
  workerId: string;
  /** Owner ids this worker serves. Ignored when `isDefault` is true. */
  owners: readonly string[];
  /** Catch-all for owners no shard names. At most one shard may set this. */
  isDefault?: boolean;
  /** Where the control plane proxies this shard's requests. */
  url?: string;
}

export interface TopologyProblem {
  severity: 'error' | 'warning';
  message: string;
  detail: Record<string, unknown>;
}

/** Checks the shard set before anything is started. Errors are fatal: they all
 * describe a topology that would corrupt owner-level coordination. */
export function validateTopology(shards: readonly ShardSpec[]): TopologyProblem[] {
  const problems: TopologyProblem[] = [];
  const seenWorkers = new Set<string>();
  const owningWorker = new Map<string, string>();
  const defaults: string[] = [];

  for (const shard of shards) {
    if (shard.workerId.length === 0) {
      problems.push({ severity: 'error', message: 'shard has an empty workerId', detail: {} });
    }
    if (seenWorkers.has(shard.workerId)) {
      problems.push({
        severity: 'error',
        message: 'duplicate workerId',
        detail: { workerId: shard.workerId },
      });
    }
    seenWorkers.add(shard.workerId);
    if (shard.isDefault === true) defaults.push(shard.workerId);

    for (const owner of shard.owners) {
      const already = owningWorker.get(owner);
      if (already !== undefined && already !== shard.workerId) {
        problems.push({
          severity: 'error',
          message: 'owner assigned to more than one worker — owner-level claims would split',
          detail: { ownerId: owner, workers: [already, shard.workerId] },
        });
      }
      owningWorker.set(owner, shard.workerId);
    }
    if (shard.owners.length === 0 && shard.isDefault !== true) {
      problems.push({
        severity: 'warning',
        message: 'shard serves no owners and is not the default',
        detail: { workerId: shard.workerId },
      });
    }
  }

  if (defaults.length > 1) {
    problems.push({
      severity: 'error',
      message: 'more than one default shard',
      detail: { workers: defaults },
    });
  }
  if (shards.length === 0) {
    problems.push({ severity: 'error', message: 'topology has no shards', detail: {} });
  }
  return problems;
}

/**
 * Resolves which worker owns an owner id, and answers "is this mine?" for the
 * worker it belongs to.
 */
export class ShardTopology {
  readonly #byOwner = new Map<string, ShardSpec>();
  readonly #default: ShardSpec | undefined;
  readonly shards: readonly ShardSpec[];

  private constructor(shards: readonly ShardSpec[]) {
    this.shards = shards;
    for (const shard of shards) {
      for (const owner of shard.owners) this.#byOwner.set(owner, shard);
    }
    this.#default = shards.find((s) => s.isDefault === true);
  }

  /** @throws {ConfigError} if the topology has any error-severity problem. */
  static create(shards: readonly ShardSpec[]): ShardTopology {
    const problems = validateTopology(shards);
    const errors = problems.filter((p) => p.severity === 'error');
    if (errors.length > 0) {
      throw new ConfigError(`invalid shard topology: ${errors.map((e) => e.message).join('; ')}`, {
        problems: errors,
      });
    }
    return new ShardTopology(shards);
  }

  workerFor(ownerId: string): ShardSpec | undefined {
    return this.#byOwner.get(ownerId) ?? this.#default;
  }

  /** True when `ownerId` belongs to `workerId`. A worker MUST drop work for any
   * owner this returns false for, or two processes would answer for it. */
  belongsTo(ownerId: string, workerId: string): boolean {
    return this.workerFor(ownerId)?.workerId === workerId;
  }

  ownersOf(workerId: string): readonly string[] {
    return this.shards.find((s) => s.workerId === workerId)?.owners ?? [];
  }
}
