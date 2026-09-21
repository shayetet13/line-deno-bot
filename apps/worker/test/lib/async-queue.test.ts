import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AsyncQueue } from '../../src/lib/async-queue.ts';

const drain = async <T>(queue: AsyncQueue<T>): Promise<T[]> => {
  const seen: T[] = [];
  for await (const value of queue) seen.push(value);
  return seen;
};

describe('AsyncQueue', () => {
  test('keeps values pushed before iteration starts', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();
    expect(await drain(queue)).toEqual([1, 2]);
  });

  test('delivers values pushed while the consumer waits', async () => {
    const queue = new AsyncQueue<string>();
    const pending = drain(queue);
    queue.push('late');
    queue.close();
    expect(await pending).toEqual(['late']);
  });

  test('close ends the stream after buffered values drain', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.close();
    expect(queue.closed).toBe(true);
    expect(await drain(queue)).toEqual([1]);
  });

  test('push after close is refused', () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    expect(queue.push(1)).toBe(false);
  });

  test('drops instead of growing past maxPending', async () => {
    const queue = new AsyncQueue<number>(2);
    expect(queue.push(1)).toBe(true);
    expect(queue.push(2)).toBe(true);
    expect(queue.push(3)).toBe(false);
    expect(queue.dropped).toBe(1);
    expect(queue.pending).toBe(2);
    queue.close();
    expect(await drain(queue)).toEqual([1, 2]);
  });
});
