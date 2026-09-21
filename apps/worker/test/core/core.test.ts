import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  unsafeBotId,
  unsafeMessageId,
  unsafeOwnerId,
  unsafeRoomId,
  unsafeSenderId,
} from '@line-first/contracts';
import { loadConfig } from '../../src/config/env.ts';
import { type CorrectnessCore, createCore } from '../../src/core/core.ts';
import { compileRules } from '../../src/core/rules/compile.ts';
import { deriveJobKey } from '../../src/core/jobs/job-key.ts';
import { FakeClock } from '../../src/lib/clock.ts';

const bot = unsafeBotId('bot-1');
const owner = unsafeOwnerId('owner-1');
const room = unsafeRoomId('room-1');
const sender = unsafeSenderId('sender-1');

const rules = compileRules([
  { id: 'start', priority: 10, kind: 'exact', pattern: 'go', reply: 'first!' },
]);

type Outcome = 'dispatched' | 'deduped' | 'no-rule' | 'blocked';

/** One pass of the Phase 1 pipeline for a single inbound delivery. */
function processOnce(core: CorrectnessCore, text: string, messageId: string): Outcome {
  const msg = unsafeMessageId(messageId);
  if (!core.claims.incomingMessage(bot, 'square', msg)) return 'deduped';
  const rule = rules.match(text);
  if (rule === null) return 'no-rule';
  if (!core.claims.reply(bot, room, rule.id, msg)) return 'deduped';
  if (!core.claims.roomAnswer(owner, room, msg)) return 'deduped';
  if (!core.rateLimiter.tryAdmit(bot, room)) return 'blocked';
  const jobKey = deriveJobKey({
    sourceMessageId: msg,
    senderId: sender,
    roomId: room,
    ruleId: rule.id,
  });
  core.jobs.markEligible(jobKey);
  core.jobs.markDispatched(jobKey);
  return 'dispatched';
}

describe('createCore — Phase 1 pipeline', () => {
  test('a duplicate delivery from push + poll dispatches exactly once', () => {
    const core = createCore(loadConfig({}), new FakeClock());
    expect(processOnce(core, 'go', 'm-1')).toBe('dispatched');
    expect(processOnce(core, 'go', 'm-1')).toBe('deduped');
    expect(core.jobs.size).toBe(1);
  });

  test('the same keyword in a later round (new message id) dispatches again', () => {
    const core = createCore(loadConfig({}), new FakeClock());
    expect(processOnce(core, 'go', 'm-1')).toBe('dispatched');
    expect(processOnce(core, 'go', 'm-2')).toBe('dispatched');
    expect(core.jobs.size).toBe(2);
  });

  test('non-matching text never reaches dispatch', () => {
    const core = createCore(loadConfig({}), new FakeClock());
    expect(processOnce(core, 'unrelated chatter', 'm-9')).toBe('no-rule');
    expect(core.jobs.size).toBe(0);
  });

  test('rate limit blocks once the bucket is spent', () => {
    const core = createCore(
      loadConfig({ RATE_LIMIT_CAPACITY: '1', RATE_LIMIT_REFILL_PER_SEC: '1' }),
      new FakeClock(),
    );
    expect(processOnce(core, 'go', 'm-1')).toBe('dispatched');
    expect(processOnce(core, 'go', 'm-2')).toBe('blocked');
  });
});
