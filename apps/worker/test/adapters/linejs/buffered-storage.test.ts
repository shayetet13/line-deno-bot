import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as fs from 'node:fs';
import { BufferedFileStorage } from '../../../src/adapters/linejs/buffered-storage.ts';

const tmpPath = (): string => Deno.makeTempFileSync({ prefix: 'buffered-storage-test-' });

const readJson = (path: string): unknown => {
  const raw = fs.readFileSync(path, 'utf-8');
  return raw.trim() === '' ? {} : JSON.parse(raw);
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('BufferedFileStorage', () => {
  test('creates the file with an empty object when none exists', () => {
    const path = tmpPath();
    Deno.removeSync(path);
    new BufferedFileStorage(path);
    expect(readJson(path)).toEqual({});
    Deno.removeSync(path);
  });

  test('loads existing content into the cache at construction', async () => {
    const path = tmpPath();
    fs.writeFileSync(path, JSON.stringify({ reqseq: { sq: 5 } }), 'utf-8');
    const storage = new BufferedFileStorage(path);
    expect(await storage.get('reqseq')).toEqual({ sq: 5 });
    Deno.removeSync(path);
  });

  test('a corrupt existing file throws rather than being silently discarded', () => {
    const path = tmpPath();
    fs.writeFileSync(path, '{not json', 'utf-8');
    expect(() => new BufferedFileStorage(path)).toThrow();
    Deno.removeSync(path);
  });

  test('get answers from cache immediately after set — no disk round trip needed', async () => {
    const path = tmpPath();
    const storage = new BufferedFileStorage(path, 50);
    await storage.set('reqseq', { sq: 1 });
    expect(await storage.get('reqseq')).toEqual({ sq: 1 });
    // Nothing forced a flush yet — the point of the whole class.
    expect(readJson(path)).toEqual({});
    Deno.removeSync(path);
  });

  test('multiple sets inside the debounce window coalesce into one disk write', async () => {
    const path = tmpPath();
    const storage = new BufferedFileStorage(path, 30);
    await storage.set('a', 1);
    await storage.set('b', 2);
    await storage.set('a', 3);
    await wait(80);
    expect(readJson(path)).toEqual({ a: 3, b: 2 });
    Deno.removeSync(path);
  });

  test('flushNow writes immediately without waiting out the debounce window', async () => {
    const path = tmpPath();
    const storage = new BufferedFileStorage(path, 5_000); // would not fire on its own within this test
    await storage.set('reqseq', { sq: 7 });
    await storage.flushNow();
    expect(readJson(path)).toEqual({ reqseq: { sq: 7 } });
    Deno.removeSync(path);
  });

  test('flushNow with nothing pending resolves immediately and touches nothing', async () => {
    const path = tmpPath();
    const storage = new BufferedFileStorage(path);
    await storage.flushNow();
    const before = readJson(path);
    await storage.flushNow();
    expect(readJson(path)).toEqual(before);
    Deno.removeSync(path);
  });

  test('a set arriving while a flush is in flight is not lost', async () => {
    const path = tmpPath();
    const storage = new BufferedFileStorage(path, 10);
    await storage.set('a', 1);
    // Race a second set against the in-flight flushNow write.
    const flushing = storage.flushNow();
    await storage.set('b', 2);
    await flushing;
    await storage.flushNow();
    expect(readJson(path)).toEqual({ a: 1, b: 2 });
    Deno.removeSync(path);
  });

  test('delete removes the key from both cache and the next flush', async () => {
    const path = tmpPath();
    fs.writeFileSync(path, JSON.stringify({ a: 1, b: 2 }), 'utf-8');
    const storage = new BufferedFileStorage(path);
    await storage.delete('a');
    await storage.flushNow();
    expect(readJson(path)).toEqual({ b: 2 });
    Deno.removeSync(path);
  });

  test('clear empties both the cache and the file', async () => {
    const path = tmpPath();
    fs.writeFileSync(path, JSON.stringify({ a: 1 }), 'utf-8');
    const storage = new BufferedFileStorage(path);
    await storage.clear();
    expect(await storage.get('a')).toBeUndefined();
    await storage.flushNow();
    expect(readJson(path)).toEqual({});
    Deno.removeSync(path);
  });

  test('getAll reflects the cache, including unflushed writes', async () => {
    const path = tmpPath();
    const storage = new BufferedFileStorage(path, 5_000);
    await storage.set('x', 'y');
    expect(await storage.getAll()).toEqual({ x: 'y' });
    Deno.removeSync(path);
  });

  test('migrate copies every cached key into the target storage', async () => {
    const path = tmpPath();
    const targetPath = tmpPath();
    fs.writeFileSync(path, JSON.stringify({ a: 1, b: 2 }), 'utf-8');
    const storage = new BufferedFileStorage(path);
    const target = new BufferedFileStorage(targetPath);
    await storage.migrate(target);
    expect(await target.getAll()).toEqual({ a: 1, b: 2 });
    Deno.removeSync(path);
    Deno.removeSync(targetPath);
  });
});
