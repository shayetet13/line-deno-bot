import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigError } from '../../src/errors/base.ts';
import {
  assertDeployable,
  buildManifest,
  canonicalize,
  type ReleaseInput,
  releaseLabel,
  sha256Hex,
} from '../../src/release/manifest.ts';

const input = (over: Partial<ReleaseInput> = {}): ReleaseInput => ({
  version: '0.1.0',
  commit: 'ef6c3d9f70dd41fa51053615d47f071f58cf8db3',
  dirty: false,
  runtime: 'deno 2.9.6',
  dependencies: { linejs: 'ef6c3d9f70dd41fa51053615d47f071f58cf8db3' },
  config: { rateLimit: { capacity: 5 }, logLevel: 'info' },
  builtAtMs: 1_700_000_000_000,
  ...over,
});

describe('canonicalize', () => {
  test('key order does not change the encoding', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  test('it sorts at every depth, not just the top', () => {
    expect(canonicalize({ x: { b: 1, a: 2 } })).toBe(canonicalize({ x: { a: 2, b: 1 } }));
  });

  test('array order is preserved — order is meaning there', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  test('undefined members are dropped rather than encoded', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  test('null, numbers and strings round-trip', () => {
    expect(canonicalize({ a: null, b: 1, c: 'x' })).toBe('{"a":null,"b":1,"c":"x"}');
  });
});

describe('buildManifest', () => {
  test('the same inputs give the same hashes', async () => {
    const a = await buildManifest(input());
    const b = await buildManifest(input());
    expect(a.buildHash).toBe(b.buildHash);
    expect(a.configHash).toBe(b.configHash);
  });

  test('a config-only change moves the config hash, not the build hash', async () => {
    const a = await buildManifest(input());
    const b = await buildManifest(input({ config: { rateLimit: { capacity: 9 } } }));
    expect(b.buildHash).toBe(a.buildHash);
    expect(b.configHash).not.toBe(a.configHash);
    expect(releaseLabel(b)).not.toBe(releaseLabel(a));
  });

  test('a dependency bump moves the build hash', async () => {
    const a = await buildManifest(input());
    const b = await buildManifest(input({ dependencies: { linejs: 'aaaaaaa' } }));
    expect(b.buildHash).not.toBe(a.buildHash);
  });

  test('the label marks a dirty build so it cannot be mistaken for a release', async () => {
    expect(releaseLabel(await buildManifest(input({ dirty: true })))).toContain('-dirty');
    expect(releaseLabel(await buildManifest(input()))).not.toContain('-dirty');
  });

  test('sha256Hex is the real digest', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('assertDeployable', () => {
  test('a clean pinned release passes', async () => {
    assertDeployable(await buildManifest(input()));
  });

  test('a dirty build is refused', async () => {
    const m = await buildManifest(input({ dirty: true }));
    expect(() => assertDeployable(m)).toThrow(ConfigError);
  });

  test('deploying a branch name instead of a commit is refused', async () => {
    const m = await buildManifest(input({ commit: 'main' }));
    expect(() => assertDeployable(m)).toThrow(ConfigError);
  });

  test('an unpinned dependency is refused, and every problem is named at once', async () => {
    const m = await buildManifest(input({
      dirty: true,
      commit: 'main',
      dependencies: { linejs: 'latest' },
    }));
    try {
      assertDeployable(m);
      throw new Error('expected a throw');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).context['problems'] as string[];
      expect(problems).toHaveLength(3);
    }
  });

  test('a dependency describe.ts could not resolve is refused, not waved through', async () => {
    // "unknown" is what a git-archive release with no .git and no stamp
    // reports; letting it pass would defeat rollback traceability entirely.
    const m = await buildManifest(input({ dependencies: { linejs: 'unknown' } }));
    expect(() => assertDeployable(m)).toThrow(ConfigError);
  });
});
