import { unsafeMessageId } from '@line-first/contracts';
import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../logging/logger.ts';
import type { SendCommand, Sender, SendResult } from './types.ts';

/**
 * A sender that runs the whole reply path but never posts.
 *
 * This is how the first live run against a real account should happen: every
 * gate, every claim, every rule match and every trace point behaves exactly as
 * it will in production, and the only difference is that the request is not
 * handed to LINE. It answers "would we have replied, to what, and how fast did
 * we get there" without putting a word into someone's room.
 *
 * It deliberately does NOT simulate latency. Send RTT measured in dry run
 * would be a fiction, and a fiction in a latency number is worse than a gap.
 */
export class DryRunSender implements Sender {
  #count = 0;

  constructor(
    private readonly clock: Clock,
    private readonly logger: Logger,
    /** Print the reply text. Off by default — rooms are private. */
    private readonly showText = false,
  ) {}

  get count(): number {
    return this.#count;
  }

  send(cmd: SendCommand, _signal: AbortSignal): Promise<SendResult> {
    const submittedAtMono = this.clock.monotonic();
    this.#count += 1;
    this.logger.info('DRY RUN — would send', {
      surface: cmd.surface,
      roomId: mask(cmd.roomId),
      length: cmd.text.length,
      ...(this.showText ? { text: cmd.text } : {}),
    });
    return Promise.resolve({
      ok: true,
      sentMessageId: unsafeMessageId(`dry-run-${String(this.#count)}`),
      submittedAtMono,
      ackAtMono: this.clock.monotonic(),
    });
  }
}

const mask = (id: string): string => (id.length <= 10 ? id : `${id.slice(0, 8)}…`);
