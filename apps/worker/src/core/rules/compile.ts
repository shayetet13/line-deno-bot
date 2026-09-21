import { unsafeRuleId } from '@line-first/contracts';
import { ValidationError } from '../../errors/base.ts';
import { normalizeText } from './normalize.ts';
import {
  type CompiledRule,
  type CompiledRuleSet,
  DEFAULT_MATCH_OPTIONS,
  MATCH_KINDS,
  type MatchOptions,
  type RuleSpec,
} from './types.ts';

/**
 * Compiles author rules once, at config-load time — never per message.
 *
 * @throws {ValidationError} on any malformed rule (permanent — fix the config).
 */
export function compileRules(
  specs: readonly RuleSpec[],
  overrides: Partial<MatchOptions> = {},
): CompiledRuleSet {
  const options: MatchOptions = { ...DEFAULT_MATCH_OPTIONS, ...overrides };
  const seen = new Set<string>();
  const compiled = specs.map((spec, index) => {
    assertUniqueId(spec.id, seen);
    return compileOne(spec, index, options);
  });

  const exact = indexExact(compiled, specs, options);
  const nonExact = compiled.filter((rule) => rule.kind !== 'exact');
  // Repeat questions are common (FAQ-shaped rule sets), and the exact-match
  // path already costs one Map lookup — caching the decision by normalized
  // text also skips the O(nonExact) contains/prefix scan on a repeat.
  const cache = new Map<string, CompiledRule | null>();
  return {
    options,
    size: compiled.length,
    match: (rawText) => {
      const text = normalizeText(rawText, options);
      const cached = cache.get(text);
      if (cached !== undefined) return cached;
      const matched = selectBest(collectCandidates(text, exact, nonExact));
      rememberMatch(cache, text, matched);
      return matched;
    },
  };
}

const MATCH_CACHE_MAX_ENTRIES = 500;

/** FIFO eviction via `Map` insertion order once the cap is reached, so an
 * adversarial stream of unique messages cannot grow this without bound. */
function rememberMatch(
  cache: Map<string, CompiledRule | null>,
  text: string,
  rule: CompiledRule | null,
): void {
  if (cache.size >= MATCH_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(text, rule);
}

function compileOne(spec: RuleSpec, index: number, options: MatchOptions): CompiledRule {
  assertValidSpec(spec);
  const base = {
    id: unsafeRuleId(spec.id),
    priority: spec.priority,
    kind: spec.kind,
    reply: spec.reply,
    configIndex: index,
  };
  return { ...base, test: buildTest(spec, options) };
}

function buildTest(spec: RuleSpec, options: MatchOptions): (text: string) => boolean {
  const needle = normalizeText(spec.pattern, options);
  if (spec.kind === 'prefix') return (text) => text.startsWith(needle);
  if (spec.kind === 'contains') return (text) => text.includes(needle);
  return (text) => text === needle;
}

function indexExact(
  compiled: readonly CompiledRule[],
  specs: readonly RuleSpec[],
  options: MatchOptions,
): ReadonlyMap<string, CompiledRule> {
  const map = new Map<string, CompiledRule>();
  compiled.forEach((rule, index) => {
    if (rule.kind !== 'exact') return;
    const key = normalizeText(specs[index]?.pattern ?? '', options);
    const existing = map.get(key);
    if (existing === undefined || beats(rule, existing)) map.set(key, rule);
  });
  return map;
}

function collectCandidates(
  text: string,
  exact: ReadonlyMap<string, CompiledRule>,
  nonExact: readonly CompiledRule[],
): CompiledRule[] {
  const hits: CompiledRule[] = [];
  const exactHit = exact.get(text);
  if (exactHit !== undefined) hits.push(exactHit);
  for (const rule of nonExact) if (rule.test(text)) hits.push(rule);
  return hits;
}

const selectBest = (candidates: readonly CompiledRule[]): CompiledRule | null =>
  candidates.reduce<CompiledRule | null>(
    (best, rule) => (best === null || beats(rule, best) ? rule : best),
    null,
  );

/** Higher priority wins; ties go to the earlier rule in config order. */
const beats = (a: CompiledRule, b: CompiledRule): boolean =>
  a.priority > b.priority || (a.priority === b.priority && a.configIndex < b.configIndex);

function assertUniqueId(id: string, seen: Set<string>): void {
  if (seen.has(id)) throw new ValidationError('duplicate rule id', { ruleId: id });
  seen.add(id);
}

function assertValidSpec(spec: RuleSpec): void {
  const fail = (reason: string): never => {
    throw new ValidationError(`invalid rule: ${reason}`, { ruleId: spec.id, reason });
  };
  if (typeof spec.id !== 'string' || spec.id.length === 0) fail('id must be a non-empty string');
  if (!Number.isInteger(spec.priority)) fail('priority must be an integer');
  if (!MATCH_KINDS.includes(spec.kind)) fail(`unknown kind "${spec.kind}"`);
  if (typeof spec.reply !== 'string' || spec.reply.length === 0) fail('reply must be non-empty');
  if (typeof spec.pattern !== 'string' || spec.pattern.length === 0) {
    fail('pattern must be non-empty');
  }
}
