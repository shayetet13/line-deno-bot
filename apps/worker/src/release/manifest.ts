import { ConfigError } from '../errors/base.ts';

/**
 * What is actually running, in a form you can compare across a rollout.
 *
 * Phases §19 asks for "Release แบบ pin versions, build hash และ config hash ที่
 * ย้อนกลับได้" and for first-response metrics split by version. Both need one
 * thing: a stable identity for a running worker that changes when — and only
 * when — something about it changes. A config edit with no code change must
 * produce a different id, or an A/B between two rollout groups compares
 * nothing.
 */

export interface ReleaseManifest {
  /** Worker version from deno.json. */
  version: string;
  /** Commit the build came from. Never a branch name. */
  commit: string;
  /** True when the build came from a modified working tree. Refused for prod:
   * a dirty build cannot be reproduced or rolled back to (Playbook §16.2). */
  dirty: boolean;
  runtime: string;
  /** Pinned dependency revisions — the LINEJS submodule above all. */
  dependencies: Readonly<Record<string, string>>;
  /** SHA-256 over version+commit+runtime+dependencies. */
  buildHash: string;
  /** SHA-256 over the effective configuration. */
  configHash: string;
  builtAtMs: number;
}

export interface ReleaseInput {
  version: string;
  commit: string;
  dirty: boolean;
  runtime: string;
  dependencies: Readonly<Record<string, string>>;
  config: unknown;
  builtAtMs: number;
}

/** Canonical JSON: object keys sorted at every depth, so two configs that
 * differ only in key order hash identically and a reordered file does not look
 * like a new release. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Short form for logs, dashboards and metric labels. */
export const shortHash = (hash: string): string => hash.slice(0, 12);

export async function buildManifest(input: ReleaseInput): Promise<ReleaseManifest> {
  const buildHash = await sha256Hex(canonicalize({
    version: input.version,
    commit: input.commit,
    runtime: input.runtime,
    dependencies: input.dependencies,
  }));
  const configHash = await sha256Hex(canonicalize(input.config));
  return {
    version: input.version,
    commit: input.commit,
    dirty: input.dirty,
    runtime: input.runtime,
    dependencies: { ...input.dependencies },
    buildHash,
    configHash,
    builtAtMs: input.builtAtMs,
  };
}

/** The label a metric or a log line carries. Two workers sharing this string
 * are running the same code against the same config. */
export const releaseLabel = (m: ReleaseManifest): string =>
  `${m.version}+${shortHash(m.buildHash)}/${shortHash(m.configHash)}${m.dirty ? '-dirty' : ''}`;

/** Gate a production deploy. Fails fast and names every problem at once. */
export function assertDeployable(m: ReleaseManifest): void {
  const problems: string[] = [];
  if (m.dirty) problems.push('built from a dirty working tree — cannot be reproduced');
  if (!/^[0-9a-f]{7,40}$/.test(m.commit)) {
    problems.push(`commit "${m.commit}" is not a hash — deploy from a commit, not a branch`);
  }
  for (const [name, revision] of Object.entries(m.dependencies)) {
    const lower = revision.toLowerCase();
    if (revision === '' || lower === 'latest' || revision === 'main' || lower === 'unknown') {
      problems.push(`dependency "${name}" is not pinned (got "${revision}")`);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`release is not deployable:\n- ${problems.join('\n- ')}`, { problems });
  }
}
