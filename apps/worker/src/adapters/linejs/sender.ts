import type { Client } from '@evex/linejs';
import { unsafeMessageId } from '@line-first/contracts';
import { ValidationError } from '../../errors/base.ts';
import type { Clock } from '../../lib/clock.ts';
import type { SendCommand, Sender, SendResult } from '../types.ts';
import { toEpochMs } from './normalize.ts';
import type { SquarePollQuietGate } from './poll-quiet.ts';

/**
 * Sends through LINEJS, one call per surface.
 *
 * NOTE (Playbook §7.12): LINEJS exposes no AbortSignal on send, so the pipeline's
 * deadline can stop us *waiting* but cannot un-send a request that already
 * reached LINE. A timed-out send is therefore `UNKNOWN`, never automatically
 * retried — sending is not idempotent.
 */
export class LinejsSender implements Sender {
  constructor(
    private readonly client: Client,
    private readonly clock: Clock,
    private readonly pollQuiet?: SquarePollQuietGate,
  ) {}

  async send(cmd: SendCommand, _signal: AbortSignal): Promise<SendResult> {
    if (cmd.surface === 'square') this.pollQuiet?.markReplyStarted(cmd.roomId);
    const submittedAtMono = this.clock.monotonic();
    try {
      const { sentMessageId, sentServiceEventTimeMs } = await this.#dispatch(cmd);
      return {
        ok: true,
        sentMessageId,
        sentServiceEventTimeMs,
        submittedAtMono,
        ackAtMono: this.clock.monotonic(),
      };
    } catch (error: unknown) {
      return {
        ok: false,
        sentMessageId: undefined,
        submittedAtMono,
        ackAtMono: this.clock.monotonic(),
        error,
      };
    }
  }

  async #dispatch(cmd: SendCommand): Promise<DispatchResult> {
    if (cmd.surface === 'square') {
      // Encode timing is not taken here: it is reported per-RPC by the
      // listener installed in thrift-timing.ts, which anchors on
      // `RequestClient.request` because `sendMessage` awaits `getReqseq()`
      // before it ever reaches the encoder.
      const res = await this.client.base.square.sendMessage(dispatchArgs(cmd));
      return readSquareResult(res);
    }
    if (cmd.surface === 'talk') {
      // Compact `/CA5` is the smaller Talk wire format (Playbook §6.4).
      const res = await this.client.sendCompactMessage(cmd.roomId, cmd.text);
      return readCompactResult(res);
    }
    throw new ValidationError(`sender: unsupported surface "${cmd.surface}"`, {
      surface: cmd.surface,
    });
  }
}

const dispatchArgs = (cmd: SendCommand) => ({
  squareChatMid: cmd.roomId,
  text: cmd.text,
});

interface DispatchResult {
  sentMessageId: ReturnType<typeof unsafeMessageId> | undefined;
  sentServiceEventTimeMs: number | undefined;
}

type MessageInfo = DispatchResult;

/** `square.sendMessage` resolves `SendMessageResponse`, i.e.
 * `{ createdSquareMessage: { message: { id, createdTime, ... }, ... } }`. */
function readSquareResult(res: unknown): MessageInfo {
  const message =
    (res as { createdSquareMessage?: { message?: { id?: unknown; createdTime?: unknown } } })
      .createdSquareMessage?.message;
  const id = message?.id;
  return {
    sentMessageId: typeof id === 'string' ? unsafeMessageId(id) : undefined,
    sentServiceEventTimeMs: toEpochMs(message?.createdTime),
  };
}

/** `sendCompactMessage` resolves a flat `CompactMessageResponse`:
 * `{ sequenceId, messageId: bigint, createdTime: number }`. */
function readCompactResult(res: unknown): MessageInfo {
  const { messageId, createdTime } = res as { messageId?: unknown; createdTime?: unknown };
  return {
    sentMessageId: typeof messageId === 'bigint' || typeof messageId === 'string'
      ? unsafeMessageId(String(messageId))
      : undefined,
    sentServiceEventTimeMs: toEpochMs(createdTime),
  };
}
