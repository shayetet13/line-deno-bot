import { afterEach, beforeEach, describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { loadConfig } from '../../src/config/env.ts';
import { assertDeployable } from '../../src/release/manifest.ts';
import { describeRelease } from '../../src/release/describe.ts';

/**
 * `describeRelease` shells out to `git`, so these tests only exercise the one
 * path that does not depend on an ambient git checkout: a stamped release
 * directory, which is exactly what `deploy/release.sh` produces and the only
 * shape that is ever deployed for real (Playbook §16 / ADR-0008).
 */

let dir: string;

beforeEach(async () => {
  dir = await Deno.makeTempDir({ prefix: 'lfr-describe-' });
});

afterEach(async () => {
  await Deno.remove(dir, { recursive: true });
});

const writeStamp = (body: Record<string, unknown>): Promise<void> =>
  Deno.writeTextFile(`${dir}/.release.json`, JSON.stringify(body));

describe('describeRelease — stamped release', () => {
  test('a stamp with a linejs pin is trusted over git, and the build is deployable', async () => {
    await writeStamp({
      commit: 'e850559b0814deeee8cd5e222ddfee4387c67aec',
      linejs: 'ef6c3d9f70dd41fa51053615d47f071f58cf8db3',
      builtAtMs: 1_700_000_000_000,
    });
    const manifest = await describeRelease(loadConfig({}), { baseDir: dir });
    expect(manifest.commit).toBe('e850559b0814deeee8cd5e222ddfee4387c67aec');
    expect(manifest.dependencies['linejs']).toBe('ef6c3d9f70dd41fa51053615d47f071f58cf8db3');
    expect(manifest.dirty).toBe(false);
    // This is the whole point of stamping it: the manifest must actually be
    // usable as a deploy record, not just present.
    expect(() => assertDeployable(manifest)).not.toThrow();
  });

  test('no stamp AND no git (the real git-archive shape) resolves to "unknown" and is refused', async () => {
    // A directory with no .release.json and no .git of its own is exactly
    // what deploy/release.sh must never produce without a stamp — this is the
    // regression this whole fix is for.
    const originalCwd = Deno.cwd();
    Deno.chdir(dir);
    try {
      const manifest = await describeRelease(loadConfig({}), { baseDir: dir });
      expect(manifest.dependencies['linejs']).toBe('unknown');
      expect(() => assertDeployable(manifest)).toThrow();
    } finally {
      Deno.chdir(originalCwd);
    }
  });

  test('a missing stamp file falls back cleanly instead of throwing', async () => {
    // No .release.json written — describeRelease must not crash the worker
    // over an optional file.
    const manifest = await describeRelease(loadConfig({}), { baseDir: dir });
    expect(manifest.commit).toBeDefined();
  });

  test('builtAtMs from the stamp is preserved verbatim', async () => {
    await writeStamp({ commit: 'abc1234', linejs: 'def5678', builtAtMs: 1_234_567_890 });
    const manifest = await describeRelease(loadConfig({}), { baseDir: dir });
    expect(manifest.builtAtMs).toBe(1_234_567_890);
  });
});
