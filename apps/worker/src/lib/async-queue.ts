/**
 * Single-consumer queue that turns pushed values into an async iterable.
 *
 * Producers call {@link push} from callbacks or event handlers; the consumer
 * drives it with `for await`. Values pushed before iteration starts are kept,
 * so no event is lost between `start()` and the first `next()`.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiters: (() => void)[] = [];
  #closed = false;
  #dropped = 0;

  constructor(private readonly maxPending = 10_000) {}

  /** Number of values discarded because the queue was full. */
  get dropped(): number {
    return this.#dropped;
  }

  get pending(): number {
    return this.#items.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Enqueues a value. Returns `false` if it was dropped or the queue is closed. */
  push(value: T): boolean {
    if (this.#closed) return false;
    if (this.#items.length >= this.maxPending) {
      this.#dropped += 1;
      return false;
    }
    this.#items.push(value);
    this.#wake();
    return true;
  }

  /** Ends the stream once buffered values are consumed. */
  close(): void {
    this.#closed = true;
    this.#wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}
