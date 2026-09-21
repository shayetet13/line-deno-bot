import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { unsafeOwnerId, unsafeSenderId } from '@line-first/contracts';
import { ALLOW_ANY_SENDER, IdSenderAllowlist } from '../../src/core/allowlist.ts';

const o = (id: string) => unsafeOwnerId(id);
const s = (id: string) => unsafeSenderId(id);

describe('IdSenderAllowlist', () => {
  test('an owner with a list admits only the ids on it', () => {
    const list = new IdSenderAllowlist({ 'owner-1': ['admin-1', 'admin-2'] });
    expect(list.allows(o('owner-1'), s('admin-1'))).toBe(true);
    expect(list.allows(o('owner-1'), s('admin-2'))).toBe(true);
    expect(list.allows(o('owner-1'), s('stranger'))).toBe(false);
  });

  test('a near-miss id is not a match — this is the impersonation case', () => {
    const list = new IdSenderAllowlist({ 'owner-1': ['admin-1'] });
    for (const impostor of ['admin-1 ', ' admin-1', 'admin-11', 'Admin-1', 'admin-1​']) {
      expect(list.allows(o('owner-1'), s(impostor))).toBe(false);
    }
  });

  test('an owner with no list is unrestricted', () => {
    const list = new IdSenderAllowlist({ 'owner-1': ['admin-1'] });
    expect(list.allows(o('owner-2'), s('anyone'))).toBe(true);
    expect(list.isRestricted(o('owner-2'))).toBe(false);
    expect(list.isRestricted(o('owner-1'))).toBe(true);
  });

  test('an empty list closes the owner completely — distinct from unconfigured', () => {
    const list = new IdSenderAllowlist({ 'owner-1': [] });
    expect(list.allows(o('owner-1'), s('admin-1'))).toBe(false);
    expect(list.isRestricted(o('owner-1'))).toBe(true);
  });

  test('one owner’s list never leaks to another', () => {
    const list = new IdSenderAllowlist({ 'owner-1': ['a'], 'owner-2': ['b'] });
    expect(list.allows(o('owner-1'), s('b'))).toBe(false);
    expect(list.allows(o('owner-2'), s('a'))).toBe(false);
  });

  test('the default allows everyone, so an unconfigured bot is unchanged', () => {
    expect(ALLOW_ANY_SENDER.allows(o('any'), s('any'))).toBe(true);
  });
});
