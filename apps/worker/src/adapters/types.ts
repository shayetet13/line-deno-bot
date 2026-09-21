import type {
  BotId,
  InboundSource,
  MessageId,
  OwnerId,
  RoomId,
  SenderId,
  Surface,
} from '@line-first/contracts';

/**
 * A normalized inbound message, independent of which connector produced it.
 * Field names follow the Phase 2 trace points (Phases §5).
 */
export interface InboundEvent {
  surface: Surface;
  /** Which racing transport delivered it (Playbook §5.1). */
  source: InboundSource;
  botId: BotId;
  ownerId: OwnerId;
  roomId: RoomId;
  senderId: SenderId;
  messageId: MessageId;
  text: string;
  /** Epoch ms the service stamped on the message, or `undefined` if unknown
   * (Phases §5 — never fabricate 0). */
  serviceEventTimeMs: number | undefined;
  /** `performance.now()` value when our process first observed the event. */
  observedAtMono: number;
  /** `Date.now()` at the same moment as `observedAtMono`, wall-clock so it can
   * be compared against `serviceEventTimeMs` (LINE's clock). Optional: only
   * sources that plumb it through report inbound latency at all — an unset
   * value stays unset rather than being read as "instant" (Phases §5). */
  observedAtWallMs?: number | undefined;
  /** Explicit job id parsed from the text, when the game embeds one. */
  explicitJobId?: string | undefined;
}

/** Produces a stream of normalized events. The stream MUST already have drained
 * startup backlog so old keywords are not answered (Playbook §5.3). */
export interface InboundAdapter {
  /** Resolves once the underlying session is listening and backlog is drained. */
  start(signal: AbortSignal): Promise<void>;
  /** Async iterable of events until `signal` aborts or the stream ends. */
  events(): AsyncIterable<InboundEvent>;
  /** Best-effort teardown. Safe to call more than once. */
  stop(): Promise<void>;
}

/**
 * Optional zero-queue delivery path for latency-sensitive adapters.
 *
 * When a sink is installed, the adapter calls it in the same stack that first
 * observes the event and MUST NOT also enqueue that event in `events()`. This
 * lets a receiver start the network request before another microtask runs.
 */
export interface SynchronousInboundAdapter extends InboundAdapter {
  setSynchronousSink(sink: ((event: InboundEvent) => void) | undefined): void;
}

export const hasSynchronousInbound = (
  adapter: InboundAdapter,
): adapter is SynchronousInboundAdapter =>
  typeof (adapter as Partial<SynchronousInboundAdapter>).setSynchronousSink === 'function';

/** Health reported by the account-wide PUSH connection.  A listening event
 * emitter alone is not evidence that LINE accepted the long-lived stream. */
export interface PushHealth {
  ready: boolean;
  reason?: string | undefined;
}

/** Optional capability of an inbound adapter that owns a PUSH stream. */
export interface PushHealthSource {
  readonly pushHealth: PushHealth;
}

export const hasPushHealth = (
  adapter: InboundAdapter,
): adapter is InboundAdapter & PushHealthSource => 'pushHealth' in adapter;

export interface SendCommand {
  surface: Surface;
  roomId: RoomId;
  text: string;
}

export interface SendResult {
  ok: boolean;
  /** Id LINE assigned to our sent message, if the transport returns it. */
  sentMessageId: MessageId | undefined;
  /** `performance.now()` when the send call resolved. NOT proof of winning
   * (decision doc §4). */
  ackAtMono: number;
  /** `performance.now()` immediately before the transport call. This lets
   * post-ACK reporting derive code/send latency without trace allocations or
   * clock reads before dispatch in the pipeline itself. */
  submittedAtMono?: number | undefined;
  /** LINE's own timestamp for the message we just sent, when the transport's
   * response carries one — lets a caller compare trigger and reply purely on
   * LINE's clock, with no host clock skew in the number. */
  sentServiceEventTimeMs?: number | undefined;
  error?: unknown;
}

export interface Sender {
  send(cmd: SendCommand, signal: AbortSignal): Promise<SendResult>;
}
