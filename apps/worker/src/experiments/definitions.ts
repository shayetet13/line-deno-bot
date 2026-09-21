import type { ExperimentDefinition } from './types.ts';

/**
 * The Phase 9 experiment set (Phases §17), one entry per listed technique.
 *
 * Each was written before it ran. Where a phase has already produced evidence
 * — the receive-path race in Phase 5, the owned lanes in Phase 4 — the entry
 * names the measurement rather than restating the hope.
 */

export const EXPERIMENT_IDS = {
  receiverDiversity: 'receiver-diversity',
  fetchRace: 'read-only-fetch-race',
  preparedSlot: 'prepared-request-slot',
  cpuAffinity: 'cpu-affinity-irq',
  socketTuning: 'napi-socket-tuning',
  splitTransport: 'split-fetch-send-transport',
  nativeEncoder: 'native-encode-relay',
} as const;

export const EXPERIMENTS: readonly ExperimentDefinition[] = [
  {
    id: EXPERIMENT_IDS.receiverDiversity,
    title: 'Receiver diversity → single sender',
    hypothesis: 'Several subscribed receivers see the same event at slightly different times; ' +
      'taking the earliest sighting and replying from one sender shaves the inbound tail.',
    metric: 'inbound',
    minSamples: 200,
    failureImpact:
      'Two receivers answering the same job. Contained by the reply claim, but a bug ' +
      'there becomes a double post in a customer room.',
    rollback: 'Subscribe one receiver; the racing adapter falls back to a single source.',
    // Both fan events into the same dedupe gate; running them together makes
    // any inbound improvement unattributable.
    conflictsWith: [EXPERIMENT_IDS.fetchRace],
  },
  {
    id: EXPERIMENT_IDS.fetchRace,
    title: 'Read-only message-fetch racing',
    hypothesis:
      'A dedicated per-room fetch loop sees a message before the push stream delivers it, ' +
      'so racing the two halves inbound latency.',
    metric: 'inbound',
    minSamples: 200,
    failureImpact:
      'Extra read load on a watched room, and a duplicate delivery for every message ' +
      'if the dedupe gate ever regresses.',
    rollback: 'Stop passing --race; the push stream remains the only source.',
    conflictsWith: [EXPERIMENT_IDS.receiverDiversity],
  },
  {
    id: EXPERIMENT_IDS.preparedSlot,
    title: 'Single-use prepared request slot',
    hypothesis: 'Serialising the reply during idle time and firing prepared bytes on the job ' +
      'removes pre-network work from the critical path.',
    metric: 'send',
    minSamples: 200,
    failureImpact:
      'A stale prepared request replayed against a rotated session or a moved sequence.',
    rollback: 'Stop calling prepare(); take() misses and the sender builds the request inline.',
  },
  {
    id: EXPERIMENT_IDS.cpuAffinity,
    title: 'CPU affinity, IRQ allocation, scheduler tuning',
    hypothesis:
      'Pinning the worker away from the NIC interrupt CPU cuts scheduling jitter in the tail.',
    metric: 'send',
    minSamples: 500,
    failureImpact:
      'A mispinned worker sharing a core with the interrupt handler is slower, not faster, ' +
      'and the effect only shows under load.',
    rollback: 'Remove the taskset/IRQ affinity lines from the unit file and restart.',
    requiresHostControl: true,
  },
  {
    id: EXPERIMENT_IDS.socketTuning,
    title: 'NAPI / interrupt coalescing / socket tuning',
    hypothesis: 'Lower coalescing trades throughput for latency on a machine that is nearly idle ' +
      'between jobs.',
    metric: 'send',
    minSamples: 500,
    failureImpact: 'Higher CPU per packet; on a shared VPS this can be a net loss.',
    rollback: 'Restore the saved ethtool settings; they are captured before the change.',
    requiresHostControl: true,
    // Both change how the kernel schedules the same work; separate the variables.
    conflictsWith: [EXPERIMENT_IDS.cpuAffinity],
  },
  {
    id: EXPERIMENT_IDS.splitTransport,
    title: 'Separate fetch and send transports',
    hypothesis: 'Keeping polling reads off the send lanes stops a slow read from queueing behind ' +
      'the reply on the same HTTP/2 connection.',
    metric: 'send',
    minSamples: 200,
    failureImpact: 'More open connections per bot, and a second lane set to keep warm.',
    rollback: 'Point the fetcher back at the shared warm client.',
  },
  {
    id: EXPERIMENT_IDS.nativeEncoder,
    title: 'Native encode relay for the send path',
    hypothesis: 'Lane-level HTTP RTT measures 7.6ms while a full send measures ~30ms, so roughly ' +
      '22ms is thrift encode/parse in TypeScript. Moving encoding to a local native relay ' +
      'should recover most of that gap.',
    metric: 'send',
    minSamples: 200,
    failureImpact:
      'A second process on the reply path. If the relay stalls, every send stalls with it; ' +
      'it needs its own health check and a direct-path fallback.',
    rollback: 'Flip the sender back to the in-process LINEJS encoder.',
  },
];
