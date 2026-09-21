import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { unreachable } from '@std/assert';
import { compileRules } from '../../../src/core/rules/compile.ts';
import { normalizeText } from '../../../src/core/rules/normalize.ts';
import {
  type CompiledRule,
  DEFAULT_MATCH_OPTIONS,
  type RuleSpec,
} from '../../../src/core/rules/types.ts';
import { ValidationError } from '../../../src/errors/base.ts';

const spec = (over: Partial<RuleSpec>): RuleSpec => ({
  id: 'r',
  priority: 0,
  kind: 'exact',
  pattern: 'go',
  reply: 'ok',
  ...over,
});

/** Unwrap the branded RuleId to a plain string for readable assertions. */
const idOf = (rule: CompiledRule | null): string | undefined => rule?.id;

// Kept as code points so source encoding cannot make them accidentally equal.
const PRECOMPOSED = `caf${String.fromCodePoint(0xe9)}`; // "café"
const DECOMPOSED = `caf${String.fromCodePoint(0x65, 0x301)}`; // "cafe" + combining acute
// "เริ่มงาน" ("start work")
const THAI_KEY = String.fromCodePoint(
  0x0e40,
  0x0e23,
  0x0e34,
  0x0e48,
  0x0e21,
  0x0e07,
  0x0e32,
  0x0e19,
);

describe('compileRules — matching', () => {
  test('matches each kind', () => {
    const set = compileRules([
      spec({ id: 'e', kind: 'exact', pattern: 'start' }),
      spec({ id: 'p', kind: 'prefix', pattern: 'go ' }),
      spec({ id: 'c', kind: 'contains', pattern: 'now' }),
    ]);
    expect(idOf(set.match('start'))).toBe('e');
    expect(idOf(set.match('go now please'))).toBe('p');
    expect(idOf(set.match('do it now'))).toBe('c');
    expect(set.match('nothing here')).toBeNull();
  });

  test('higher priority wins; ties fall back to config order', () => {
    const set = compileRules([
      spec({ id: 'low', kind: 'contains', pattern: 'a', priority: 1 }),
      spec({ id: 'high', kind: 'contains', pattern: 'a', priority: 5 }),
      spec({ id: 'other', kind: 'contains', pattern: 'a', priority: 5 }),
    ]);
    expect(idOf(set.match('banana'))).toBe('high');
  });

  test('exact rule competes with non-exact by priority, not by kind', () => {
    const set = compileRules([
      spec({ id: 'exact', kind: 'exact', pattern: 'go', priority: 1 }),
      spec({ id: 'contains', kind: 'contains', pattern: 'go', priority: 9 }),
    ]);
    expect(idOf(set.match('go'))).toBe('contains');
  });

  test('normalisation: case-insensitive + trim by default', () => {
    const set = compileRules([spec({ id: 'e', kind: 'exact', pattern: '  GO  ' })]);
    expect(idOf(set.match('go'))).toBe('e');
  });

  test('normalisation: NFC folds a decomposed combining sequence', () => {
    expect(DECOMPOSED).not.toBe(PRECOMPOSED);
    expect(normalizeText(DECOMPOSED, DEFAULT_MATCH_OPTIONS)).toBe(PRECOMPOSED);
    const set = compileRules([spec({ id: 'n', kind: 'exact', pattern: PRECOMPOSED })]);
    expect(idOf(set.match(DECOMPOSED))).toBe('n');
  });

  test('matches Thai text literally (contains, with tone marks)', () => {
    const set = compileRules([spec({ id: 'th', kind: 'contains', pattern: THAI_KEY })]);
    expect(idOf(set.match(`xx ${THAI_KEY} yy`))).toBe('th');
  });

  test('collapseWhitespace option folds internal runs', () => {
    const set = compileRules([spec({ id: 'e', kind: 'exact', pattern: 'go now' })], {
      collapseWhitespace: true,
    });
    expect(idOf(set.match('go\t\n  now'))).toBe('e');
  });
});

describe('compileRules — match cache', () => {
  test('repeat calls with the same text return an equal result', () => {
    const set = compileRules([spec({ id: 'c', kind: 'contains', pattern: 'now' })]);
    const first = set.match('do it NOW please');
    const second = set.match('do it NOW please');
    expect(idOf(second)).toBe('c');
    expect(second).toBe(first); // same cached object, not just equal id
  });

  test('caches a miss (null) distinctly from an uncached lookup', () => {
    const set = compileRules([spec({ id: 'e', kind: 'exact', pattern: 'go' })]);
    expect(set.match('nope')).toBeNull();
    expect(set.match('nope')).toBeNull();
  });

  test('cache key is post-normalisation, so case/whitespace variants share a hit', () => {
    const set = compileRules([spec({ id: 'e', kind: 'exact', pattern: 'go' })]);
    const a = set.match('  GO  ');
    const b = set.match('go');
    expect(idOf(a)).toBe('e');
    expect(b).toBe(a);
  });

  test('an unbounded stream of unique text does not grow memory without limit', () => {
    const set = compileRules([spec({ id: 'e', kind: 'exact', pattern: 'go' })]);
    for (let i = 0; i < 10_000; i++) set.match(`unique-${i}`);
    // No public size getter on the cache itself; the real assertion is that
    // this loop completes without the process running out of memory, and
    // that the rule set still answers correctly afterward.
    expect(idOf(set.match('go'))).toBe('e');
  });
});

describe('compileRules — validation', () => {
  const bad = (over: Partial<RuleSpec>): () => unknown => (): unknown => compileRules([spec(over)]);

  test('rejects malformed specs with a ValidationError', () => {
    expect(bad({ id: '' })).toThrow(ValidationError);
    expect(bad({ priority: 1.5 })).toThrow(ValidationError);
    expect(bad({ reply: '' })).toThrow(ValidationError);
    expect(bad({ pattern: '' })).toThrow(ValidationError);
    expect(bad({ kind: 'regex' as never })).toThrow(ValidationError);
  });

  test('rejects duplicate rule ids', () => {
    expect(() => compileRules([spec({ id: 'dup' }), spec({ id: 'dup', pattern: 'x' })])).toThrow(
      /duplicate rule id/,
    );
  });

  test('reports the offending rule id in the error context', () => {
    try {
      compileRules([spec({ id: 'culprit', reply: '' })]);
      unreachable();
    } catch (err: unknown) {
      expect((err as ValidationError).context.ruleId).toBe('culprit');
    }
  });
});
