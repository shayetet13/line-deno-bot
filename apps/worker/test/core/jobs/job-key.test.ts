import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { unsafeMessageId, unsafeRoomId, unsafeRuleId, unsafeSenderId } from '@line-first/contracts';
import { deriveJobKey, type JobKeyInput } from '../../../src/core/jobs/job-key.ts';

const base: JobKeyInput = {
  sourceMessageId: unsafeMessageId('m-1'),
  senderId: unsafeSenderId('s-1'),
  roomId: unsafeRoomId('r-1'),
  ruleId: unsafeRuleId('rule-1'),
};

describe('deriveJobKey', () => {
  test('uses an explicit job id when present (trimmed)', () => {
    expect(String(deriveJobKey({ ...base, explicitJobId: '  job-42  ' }))).toBe('id:job-42');
  });

  test('is stable for identical inputs', () => {
    expect(deriveJobKey(base)).toBe(deriveJobKey({ ...base }));
  });

  test('a different sourceMessageId is a different job (same keyword, new round)', () => {
    const a = deriveJobKey(base);
    const b = deriveJobKey({ ...base, sourceMessageId: unsafeMessageId('m-2') });
    expect(a).not.toBe(b);
  });

  test('falls back to a derived key when the explicit id is blank', () => {
    expect(deriveJobKey({ ...base, explicitJobId: '   ' }).startsWith('drv:')).toBe(true);
  });

  test('sender, room and rule all participate in the derived key', () => {
    const keys = new Set([
      deriveJobKey(base),
      deriveJobKey({ ...base, senderId: unsafeSenderId('s-2') }),
      deriveJobKey({ ...base, roomId: unsafeRoomId('r-2') }),
      deriveJobKey({ ...base, ruleId: unsafeRuleId('rule-2') }),
    ]);
    expect(keys.size).toBe(4);
  });
});
