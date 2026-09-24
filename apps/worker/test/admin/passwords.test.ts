import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { hashPassword, verifyPassword } from '../../src/admin/passwords.ts';

describe('hashPassword / verifyPassword', () => {
  test('a hash verifies against the same password', async () => {
    const hash = await hashPassword('correct-horse-7');
    expect(await verifyPassword('correct-horse-7', hash)).toBe(true);
  });

  test('a hash does not verify against a different password', async () => {
    const hash = await hashPassword('correct-horse-7');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  test('two hashes of the same password differ (random salt)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  test('a malformed stored hash fails closed instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-real-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });
});
