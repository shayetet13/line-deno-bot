import { unsafeMessageId } from '@line-first/contracts';
import { TransientTransportError } from '../errors/base.ts';
import { AsyncQueue } from '../lib/async-queue.ts';
import type { InboundAdapter, InboundEvent, SendCommand, Sender, SendResult } from './types.ts';

/** Records what was sent and lets a test force the next send to fail. */
export class MockSender implements Sender {
  readonly sent: SendCommand[] = [];
  #failNext = false;
  #mono = 0;

  failNextSend(): void {
    this.#failNext = true;
  }

  send(cmd: SendCommand, _signal: AbortSignal): Promise<SendResult> {
    this.sent.push(cmd);
    const submittedAtMono = this.#mono;
    this.#mono += 1;
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.resolve({
        ok: false,
        sentMessageId: undefined,
        submittedAtMono,
        ackAtMono: this.#mono,
        error: new TransientTransportError('mock send failure'),
      });
    }
    return Promise.resolve({
      ok: true,
      sentMessageId: unsafeMessageId(`sent-${String(this.sent.length)}`),
      sentServiceEventTimeMs: 1_700_000_000_050,
      submittedAtMono,
      ackAtMono: this.#mono,
    });
  }
}

/** Hand-fed event stream. `push()` delivers, `end()` closes the iterator. */
export class MockInboundAdapter implements InboundAdapter {
  readonly #queue = new AsyncQueue<InboundEvent>();

  start(_signal: AbortSignal): Promise<void> {
    return Promise.resolve();
  }

  push(event: InboundEvent): void {
    this.#queue.push(event);
  }

  end(): void {
    this.#queue.close();
  }

  stop(): Promise<void> {
    this.end();
    return Promise.resolve();
  }

  events(): AsyncIterable<InboundEvent> {
    return this.#queue;
  }
}
