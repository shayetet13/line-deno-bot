/**
 * @line-first/worker — Deno self-bot worker.
 *
 * Phase 1  — correctness core (dedupe/claims, rule matching, rate limiting,
 *            job identity, timeout/abort, error classification).
 * Phase 1b — connector seam: normalized inbound events, sender, session store
 *            and the pipeline that joins them to the core.
 *
 * LINEJS-specific code lives under `adapters/linejs/` and is imported only by
 * the CLIs, so the core stays connector-agnostic (see `docs/phase-plan.md`).
 */
export { loadConfig, type NodeEnv, type WorkerConfig } from './config/env.ts';
export { LOG_LEVELS, type LogLevel } from './config/constants.ts';
export { type LogFields, Logger, type LogRecord, type LogSink } from './logging/logger.ts';
export * from './errors/index.ts';
export * from './lib/index.ts';
export * from './core/index.ts';
export * from './adapters/types.ts';
export { MockInboundAdapter, MockSender } from './adapters/mock.ts';
export {
  type RaceStats,
  RacingInboundAdapter,
  type RacingOptions,
  type SourceWins,
} from './adapters/racing.ts';
export {
  createRacingInbound,
  type RacingInboundConfig,
  type RacingInboundResult,
} from './adapters/linejs/racing-inbound.ts';
export { AsyncQueue } from './lib/async-queue.ts';
export {
  FileSessionStore,
  MemorySessionStore,
  type SessionStore,
  type StoredSession,
} from './session/store.ts';
export {
  type PipelineDeps,
  type PipelineOutcome,
  type PipelineResult,
  processInbound,
} from './pipeline/process-inbound.ts';
export { MetricsRecorder, type MetricsSnapshot } from './metrics/recorder.ts';
export { LatencyRing, type LatencySnapshot } from './metrics/ring.ts';
export { NULL_TRACE, Trace, TRACE_POINTS, type TraceLike } from './metrics/trace.ts';
export { createWarmHttpClient, type WarmFetch } from './warm/http-client.ts';
export { HOT_SEND_ORIGIN, TransportWarmer, type WarmerStatus } from './warm/warmer.ts';
export {
  createOwnedLanePool,
  Lane,
  LanePool,
  type LanePoolOptions,
  type LaneStat,
} from './transport/index.ts';
export {
  READINESS_STATES,
  type ReadinessChecks,
  ReadinessFsm,
  type ReadinessSnapshot,
  type ReadinessState,
} from './readiness/state.ts';
export {
  type ShardSpec,
  ShardTopology,
  type TopologyProblem,
  validateTopology,
} from './sharding/topology.ts';
export {
  type WriteBehindOptions,
  WriteBehindQueue,
  type WriteBehindStats,
} from './persistence/write-behind.ts';
export {
  type Database,
  type Migration,
  openDatabase,
  runMigrations,
} from './persistence/sqlite.ts';
export { ACCOUNT_MIGRATIONS, CONTROL_MIGRATIONS } from './persistence/migrations.ts';
export {
  buildAuthorizeUrl,
  createNonce,
  createPkcePair,
  createState,
  deriveChallenge,
  type PkcePair,
  safeEqual,
} from './auth/pkce.ts';
export {
  classifyLanes,
  DEFAULT_SAMPLE_MAX_AGE_MS,
  type LaneBadge,
  type LaneView,
} from './observability/status.ts';
export {
  type StatusSnapshot,
  StatusSource,
  type StatusSourceOptions,
} from './observability/snapshot.ts';
export {
  createStatusHandler,
  type RunningStatusServer,
  startStatusServer,
} from './observability/server.ts';
