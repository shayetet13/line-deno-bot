import {
  type MessageId,
  type OwnerId,
  type SenderId,
  unsafeBotId,
  unsafeMessageId,
  unsafeOwnerId,
  unsafeRoomId,
  unsafeSenderId,
} from '@line-first/contracts';
import type { InboundEvent, SendCommand, SendResult } from '../adapters/types.ts';
import { loadConfig } from '../config/env.ts';
import { ALLOW_ANY_SENDER, type SenderAllowlist } from '../core/allowlist.ts';
import { createCore } from '../core/core.ts';
import { compileRules } from '../core/rules/compile.ts';
import type { RuleSpec } from '../core/rules/types.ts';
import { FakeClock } from '../lib/clock.ts';
import { Logger } from '../logging/logger.ts';
import { MetricsRecorder } from '../metrics/recorder.ts';
import {
  type PipelineDeps,
  type PipelineResult,
  processInbound,
} from '../pipeline/process-inbound.ts';

/**
 * A deterministic pipeline for the Phase 10 acceptance cases.
 *
 * Everything is clock-injected and in-process, so a case is reproducible and
 * runs inside `deno task gate`. That also fixes what these numbers mean: this
 * is a CORRECTNESS harness. Latency figures it produces describe our own
 * processing only and must never be quoted as live LINE latency
 * (Phases §18: "Local replay ... ไม่อ้างเป็น live LINE latency").
 */

export const DEFAULT_RULES: readonly RuleSpec[] = [
  { id: 'open', priority: 10, kind: 'exact', pattern: 'go', reply: 'first!' },
  { id: 'open-broad', priority: 1, kind: 'exact', pattern: 'go', reply: 'second best' },
  { id: 'other', priority: 5, kind: 'exact', pattern: 'now', reply: 'now-reply' },
];

export interface SendBehaviour {
  /** Resolve as a failure instead of a success. */
  fail?: boolean;
  /** Never settle, so the pipeline's own timeout decides. Models an ACK that
   * never comes: the outcome must be reported honestly, not guessed. */
  hang?: boolean;
  /** Monotonic ms the send appears to take. */
  takesMs?: number;
}

/** A sender whose behaviour each case can script, and which records every call. */
export class ScriptedSender {
  readonly sent: SendCommand[] = [];
  behaviour: SendBehaviour = {};
  #seq = 0;

  constructor(private readonly clock: FakeClock) {}

  send(cmd: SendCommand, signal: AbortSignal): Promise<SendResult> {
    this.sent.push(cmd);
    const submittedAtMono = this.clock.monotonic();
    const b = this.behaviour;
    if (b.hang === true) {
      return new Promise<SendResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    this.clock.advance(b.takesMs ?? 1);
    this.#seq += 1;
    return Promise.resolve({
      ok: b.fail !== true,
      sentMessageId: b.fail === true ? undefined : unsafeMessageId(`sent-${String(this.#seq)}`),
      submittedAtMono,
      ackAtMono: this.clock.monotonic(),
      ...(b.fail === true ? { error: new Error('transport refused') } : {}),
    });
  }
}

export interface HarnessOptions {
  rules?: readonly RuleSpec[];
  allowlist?: SenderAllowlist;
  env?: Record<string, string>;
  /** Off by default so a correctness case is not also measuring the recorder. */
  metrics?: boolean;
}

export class AcceptanceHarness {
  readonly clock: FakeClock;
  readonly sender: ScriptedSender;
  readonly metrics: MetricsRecorder;
  readonly deps: PipelineDeps;
  #seq = 0;

  constructor(options: HarnessOptions = {}) {
    this.clock = new FakeClock(1_700_000_000_000);
    this.sender = new ScriptedSender(this.clock);
    this.metrics = new MetricsRecorder({ enabled: options.metrics ?? false });
    this.deps = {
      core: createCore(loadConfig(options.env ?? {}), this.clock),
      rules: compileRules(options.rules ?? DEFAULT_RULES),
      sender: this.sender,
      allowlist: options.allowlist ?? ALLOW_ANY_SENDER,
      clock: this.clock,
      logger: new Logger({ level: 'error', sink: () => {} }),
      opTimeoutMs: 1_000,
      metrics: this.metrics,
    };
  }

  /** A fresh event with a unique message id, unless one is given. */
  event(over: Partial<InboundEvent> = {}): InboundEvent {
    this.#seq += 1;
    return {
      surface: 'square',
      source: 'push',
      botId: unsafeBotId('bot-1'),
      ownerId: unsafeOwnerId('owner-1'),
      roomId: unsafeRoomId('room-1'),
      senderId: unsafeSenderId('admin-1'),
      messageId: unsafeMessageId(`m-${String(this.#seq)}`),
      text: 'go',
      serviceEventTimeMs: this.clock.now(),
      observedAtMono: this.clock.monotonic(),
      ...over,
    };
  }

  run(over: Partial<InboundEvent> = {}, signal?: AbortSignal): Promise<PipelineResult> {
    return processInbound(this.event(over), this.deps, signal ?? new AbortController().signal);
  }

  /** Replays an event object verbatim — for duplicate-delivery cases. */
  replay(event: InboundEvent, signal?: AbortSignal): Promise<PipelineResult> {
    return processInbound(event, this.deps, signal ?? new AbortController().signal);
  }

  /** Transport time for the last run, derived after ACK from sender stamps. */
  localSpan(result: PipelineResult): number | undefined {
    const sent = result.sendResult;
    return sent?.submittedAtMono === undefined ? undefined : sent.ackAtMono - sent.submittedAtMono;
  }
}

export const owner = (id: string): OwnerId => unsafeOwnerId(id);
export const sender = (id: string): SenderId => unsafeSenderId(id);
export const message = (id: string): MessageId => unsafeMessageId(id);
