/**
 * Serialises only connection-establishment work shared by many LINE accounts:
 * session resume, PUSH creation, reply-lane prime and Square preflight.
 *
 * It is deliberately not a send queue. Once a bot is ARMED, live replies do
 * not enter this gate and every account may submit its reply immediately.
 */
export interface ConnectionWarmupGate {
  run<T>(work: () => Promise<T>): Promise<T>;
}

interface PendingWork {
  run(): Promise<void>;
}

export class BoundedConnectionWarmupGate implements ConnectionWarmupGate {
  readonly #limit: number;
  readonly #pending: PendingWork[] = [];
  #active = 0;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('connection warmup concurrency must be an integer >= 1');
    }
    this.#limit = limit;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#pending.push({
        run: async (): Promise<void> => {
          try {
            resolve(await work());
          } catch (error: unknown) {
            reject(error);
          }
        },
      });
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < this.#limit && this.#pending.length > 0) {
      const next = this.#pending.shift();
      if (next === undefined) return;
      this.#active += 1;
      void next.run().finally(() => {
        this.#active -= 1;
        this.#drain();
      });
    }
  }
}
