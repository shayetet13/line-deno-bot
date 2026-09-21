import { Buffer } from 'node:buffer';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * scrypt password hashing for the human account login (`users-store.ts`). Uses
 * `node:crypto` rather than a third-party dependency — Deno's node-compat
 * already backs `node:sqlite` elsewhere in this repo, so this adds no new
 * supply-chain surface.
 */

const SALT_BYTES = 16;
const KEY_LENGTH = 64;

function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/** Returns `<saltHex>:<hashHex>`, safe to store as a single string field. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** Constant-time compare against a `hashPassword` output. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const sep = stored.indexOf(':');
  if (sep === -1) return false;
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (salt.length !== SALT_BYTES || expected.length === 0) return false;
  const derived = await scryptAsync(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
