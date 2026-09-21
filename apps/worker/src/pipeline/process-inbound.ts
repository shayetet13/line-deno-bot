import type { JobKey, RuleId } from '@line-first/contracts';
import type { InboundEvent, Sender, SendResult } from '../adapters/types.ts';
import { ALLOW_ANY_SENDER, type SenderAllowlist } from '../core/allowlist.ts';
import type { CorrectnessCore } from '../core/core.ts';
import { deriveJobKey } from '../core/jobs/job-key.ts';
import type { CompiledRuleSet } from '../core/rules/types.ts';
import { classifyError } from '../errors/classify.ts';
import type { Clock } from '../lib/clock.ts';
import { withTimeout } from '../lib/with-timeout.ts';
import type { Logger } from '../logging/logger.ts';
import type { MetricsRecorder } from '../metrics/recorder.ts';
import { NULL_TRACE, type TraceLike } from '../metrics/trace.ts';

export type PipelineOutcome =
  | 'dispatched'
  | 'sender-not-allowed'
  | 'deduped-incoming'
  | 'no-rule'
  | 'job-terminal'
  | 'deduped-reply'
  | 'deduped-room'
  | 'rate-limited'
  | 'send-failed';

export interface PipelineDeps {
  core: CorrectnessCore;
  rules: CompiledRuleSet;
  sender: Sender;
  /** Who may start a job. Omitted means anyone (see {@link ALLOW_ANY_SENDER}). */
  allowlist?: SenderAllowlist | undefined;
  clock: Clock;
  logger: Logger;
  opTimeoutMs: number;
  /** When present, spans and outcomes are filed here AFTER the reply is sent. */
  metrics?: MetricsRecorder | undefined;
}

export interface PipelineResult {
  outcome: PipelineOutcome;
  jobKey: JobKey | undefined;
  ruleId: RuleId | undefined;
  sendResult: SendResult | undefined;
  trace: TraceLike;
}

const round1 = (ms: number): number => Math.round(ms * 10) / 10;

/** `event.surface` ('square'/'talk'/'oa') in the vocabulary the admin pages
 * already show group kinds in (admin/server.ts's loadOpenChats/loadTalkChats/
 * loadOfficialAccounts) — "square" is LINE's own protocol name for OpenChat. */
const roomKind = (surface: InboundEvent['surface']): string =>
  surface === 'square' ? 'openchat' : surface;

const result = (
  outcome: PipelineOutcome,
  extra: Partial<PipelineResult> = {},
): PipelineResult => ({
  outcome,
  jobKey: undefined,
  ruleId: undefined,
  sendResult: undefined,
  trace: NULL_TRACE,
  ...extra,
});

interface Passed {
  ruleId: RuleId;
  reply: string;
  jobKey: JobKey;
}

/**
 * Runs one inbound event through the Phase 1 correctness core and, if it clears
 * every gate, sends the reply. Never throws on normal control flow — a failed
 * send is reported as `send-failed` with the error attached.
 *
 * Gate order is fixed (decision doc §8 step 1 / Playbook §6.2): reject a sender
 * who may not start a job, dedupe the event before it can drive rules/logs,
 * match, check the job is not already settled, then reply/room claims, then
 * admission, then dispatch.
 */
export function processInbound(
  event: InboundEvent,
  deps: PipelineDeps,
  signal: AbortSignal,
): Promise<PipelineResult> {
  try {
    const gate = evaluate(event, deps);
    if ('outcome' in gate) {
      report(gate.done.outcome, event, deps);
      return Promise.resolve(gate.done);
    }
    deps.core.jobs.markEligible(gate.jobKey);
    deps.core.jobs.markDispatched(gate.jobKey);
    return dispatch(event, gate, deps, signal);
  } catch (err: unknown) {
    // An invariant violation (e.g. an illegal job transition) must surface as a
    // rejection, never as a synchronous throw into a fire-and-forget caller.
    return Promise.reject(err);
  }
}

type GateResult = { outcome: true; done: PipelineResult } | Passed;

/** Files spans and the outcome. Called only after the reply is on the wire.
 *
 * `inbound` and `line_round_trip` are wall-clock, cross-host readings —
 * LINE's own timestamps for the trigger and (when the send succeeded) the
 * reply — computed here rather than on `Trace`, since they need fields off
 * `event`/`sendResult` that the monotonic mark system never sees. */
function report(
  outcome: PipelineOutcome,
  event: InboundEvent,
  deps: PipelineDeps,
  sendResult?: SendResult,
): void {
  const metrics = deps.metrics;
  if (metrics === undefined) return;
  metrics.count(`outcome.${outcome}`);
  metrics.count(`surface.${event.surface}`);
  metrics.count(`source.${event.source}`);

  // Every local duration is derived after ACK from timestamps the receiver
  // and sender already need. No Trace allocation, Map write, or intermediate
  // performance.now() call remains between trigger observation and dispatch.
  if (sendResult !== undefined) {
    metrics.count('line_calls');
    const submitted = sendResult.submittedAtMono;
    if (submitted !== undefined) {
      metrics.recordSpan('code', Math.max(0, submitted - event.observedAtMono));
      metrics.recordSpan('send', Math.max(0, sendResult.ackAtMono - submitted));
      metrics.recordSpan('local_total', Math.max(0, sendResult.ackAtMono - event.observedAtMono));
    }
  }

  const trigger = event.serviceEventTimeMs;
  metrics.recordCrossHost(
    'inbound',
    trigger !== undefined && event.observedAtWallMs !== undefined
      ? event.observedAtWallMs - trigger
      : undefined,
  );
  metrics.recordCrossHost(
    'line_round_trip',
    trigger !== undefined && sendResult?.sentServiceEventTimeMs !== undefined
      ? sendResult.sentServiceEventTimeMs - trigger
      : undefined,
  );
}

function evaluate(event: InboundEvent, deps: PipelineDeps): GateResult {
  const { claims, jobs, rateLimiter } = deps.core;
  const stop = (o: PipelineOutcome, e?: Partial<PipelineResult>): GateResult => ({
    outcome: true,
    done: result(o, e),
  });

  // Cheapest gate first, and before the dedupe store: a sender who may not
  // start a job should not be able to fill the claim map either.
  const allowlist = deps.allowlist ?? ALLOW_ANY_SENDER;
  if (!allowlist.allows(event.ownerId, event.senderId)) return stop('sender-not-allowed');

  if (!claims.incomingMessage(event.botId, event.surface, event.messageId)) {
    return stop('deduped-incoming');
  }
  const rule = deps.rules.match(event.text);
  if (rule === null) return stop('no-rule');

  const jobKey = deriveJobKey({
    explicitJobId: event.explicitJobId,
    sourceMessageId: event.messageId,
    senderId: event.senderId,
    roomId: event.roomId,
    ruleId: rule.id,
  });
  if (jobs.isTerminal(jobKey)) return stop('job-terminal', { jobKey, ruleId: rule.id });
  if (!claims.reply(event.botId, event.roomId, rule.id, event.messageId)) {
    return stop('deduped-reply', { jobKey, ruleId: rule.id });
  }
  if (!claims.roomAnswer(event.ownerId, event.roomId, event.messageId)) {
    return stop('deduped-room', { jobKey, ruleId: rule.id });
  }
  const admitted = rateLimiter.tryAdmit(event.botId, event.roomId);
  if (!admitted) {
    deps.logger.warn('rate limit drop', { roomId: event.roomId, ruleId: rule.id });
    return stop('rate-limited', { jobKey, ruleId: rule.id });
  }
  return { ruleId: rule.id, reply: rule.reply, jobKey };
}

async function dispatch(
  event: InboundEvent,
  passed: Passed,
  deps: PipelineDeps,
  signal: AbortSignal,
): Promise<PipelineResult> {
  const cmd = {
    surface: event.surface,
    roomId: event.roomId,
    text: passed.reply,
  };
  // Start the transport first. The timeout is still useful for classifying an
  // ACK that never returns, but LINEJS cannot cancel an in-flight send, so its
  // controller/timer/Promise race has no reason to delay the actual request.
  let pendingSend: Promise<SendResult>;
  try {
    pendingSend = deps.sender.send(cmd, signal);
  } catch (err: unknown) {
    pendingSend = Promise.reject(err);
  }
  const sendResult = await withTimeout(() => pendingSend, {
    timeoutMs: deps.opTimeoutMs,
    signal,
    label: 'send',
  }).catch((err: unknown): SendResult => ({
    ok: false,
    sentMessageId: undefined,
    ackAtMono: deps.clock.monotonic(),
    error: err,
  }));

  const outcome: PipelineOutcome = sendResult.ok ? 'dispatched' : 'send-failed';
  if (!sendResult.ok) {
    deps.logger.error('send failed', {
      ruleId: passed.ruleId,
      class: classifyError(sendResult.error),
    });
  } else if (sendResult.submittedAtMono !== undefined) {
    // Per-reply speed, on our own monotonic clock (no NTP/skew caveat —
    // see docs/phase-plan.md §3b on why cross-host timestamps alone can't
    // be trusted for this). codeMs is our own processing before the send
    // call; sendMs is the network round trip; totalMs (= codeMs + sendMs,
    // the "Σ actual" the operator asked to see) is what the sender actually
    // felt end to end. Same numbers `report()` below files into the
    // code/send/local_total percentile rings — this just also puts them on
    // one log line per reply instead of only in the aggregated snapshot.
    const codeMs = Math.max(0, sendResult.submittedAtMono - event.observedAtMono);
    const sendMs = Math.max(0, sendResult.ackAtMono - sendResult.submittedAtMono);
    deps.logger.info('reply timing', {
      ruleId: passed.ruleId,
      roomId: event.roomId,
      roomKind: roomKind(event.surface),
      codeMs: round1(codeMs),
      sendMs: round1(sendMs),
      totalMs: round1(codeMs + sendMs),
    });
  }
  report(outcome, event, deps, sendResult);
  return result(outcome, {
    jobKey: passed.jobKey,
    ruleId: passed.ruleId,
    sendResult,
    trace: NULL_TRACE,
  });
}
