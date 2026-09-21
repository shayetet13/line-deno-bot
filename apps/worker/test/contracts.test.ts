import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  INBOUND_SOURCES,
  isSurface,
  isTerminalJobState,
  type JobState,
  SURFACES,
  unsafeBotId,
} from '@line-first/contracts';

describe('@line-first/contracts', () => {
  test('isSurface accepts the known surfaces and nothing else', () => {
    for (const s of SURFACES) expect(isSurface(s)).toBe(true);
    expect(isSurface('email')).toBe(false);
    expect(isSurface('')).toBe(false);
  });

  test('inbound sources are the three racing transports', () => {
    expect([...INBOUND_SOURCES]).toEqual(['push', 'normal-poll', 'dedicated-poll']);
  });

  test('isTerminalJobState is true only for settled outcomes', () => {
    const terminal: JobState[] = ['won', 'lost', 'unknown'];
    const live: JobState[] = ['waiting', 'eligible-trigger', 'first-response-dispatched'];
    for (const s of terminal) expect(isTerminalJobState(s)).toBe(true);
    for (const s of live) expect(isTerminalJobState(s)).toBe(false);
  });

  test('brand constructors are identity at runtime', () => {
    expect(unsafeBotId('abc')).toBe('abc' as ReturnType<typeof unsafeBotId>);
  });
});
