import type { WorkerConfig } from '../config/env.ts';
import { buildManifest, type ReleaseManifest } from './manifest.ts';

/**
 * Reads the running build's identity from the checkout.
 *
 * Everything here is best-effort: a release directory produced by
 * `deploy/release.sh` is a `git archive` extract with no `.git`, so `git` will
 * not be there to ask. Rather than fail, the unknown fields say `unknown` and
 * `assertDeployable()` refuses them later — which is the correct outcome,
 * because a build whose commit cannot be established is not one you can roll
 * back to.
 */

const UNKNOWN = 'unknown';

async function run(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const output = await new Deno.Command(cmd, {
      args,
      stdout: 'piped',
      stderr: 'null',
    }).output();
    if (!output.success) return undefined;
    return new TextDecoder().decode(output.stdout).trim();
  } catch {
    // No git, no permission, not a repo — all the same answer here.
    return undefined;
  }
}

async function readVersion(): Promise<string> {
  try {
    const text = await Deno.readTextFile(new URL('../../../../deno.json', import.meta.url));
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** A release stamp written by the deploy script, for builds with no `.git`. */
interface ReleaseStamp {
  commit?: unknown;
  linejs?: unknown;
  builtAtMs?: unknown;
}

async function readStamp(baseDir: string): Promise<ReleaseStamp | undefined> {
  try {
    const text = await Deno.readTextFile(`${baseDir}/.release.json`);
    return JSON.parse(text) as ReleaseStamp;
  } catch {
    return undefined;
  }
}

export interface DescribeReleaseOptions {
  /** Where to look for `.release.json`. Defaults to the process cwd; a test
   * passes a scratch directory instead of touching global process state. */
  baseDir?: string;
}

export async function describeRelease(
  config: WorkerConfig,
  options: DescribeReleaseOptions = {},
): Promise<ReleaseManifest> {
  const stamp = await readStamp(options.baseDir ?? '.');
  const stamped = typeof stamp?.commit === 'string' ? stamp.commit : undefined;

  const commit = stamped ?? await run('git', ['rev-parse', 'HEAD']) ?? UNKNOWN;
  const status = stamped === undefined ? await run('git', ['status', '--porcelain']) : '';
  // A git-archive release has no .git to ask, so the deploy script stamps the
  // submodule pin it already resolved; only fall back to git for a checkout
  // that still has its history (e.g. running straight from a dev clone).
  const stampedLinejs = typeof stamp?.linejs === 'string' && stamp.linejs !== ''
    ? stamp.linejs
    : undefined;
  const linejs = stampedLinejs ?? await run('git', ['rev-parse', 'HEAD:vendor/linejs']);

  return buildManifest({
    version: await readVersion(),
    commit,
    // A stamped release was built from a clean checkout by definition; an
    // unknown status means we could not check, which is not proof of clean.
    dirty: status === undefined ? true : status.length > 0,
    runtime: `deno ${Deno.version.deno}`,
    dependencies: { linejs: linejs ?? UNKNOWN },
    config,
    builtAtMs: typeof stamp?.builtAtMs === 'number' ? stamp.builtAtMs : Date.now(),
  });
}
