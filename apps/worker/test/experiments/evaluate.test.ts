import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ValidationError } from '../../src/errors/base.ts';
import { evaluate } from '../../src/experiments/evaluate.ts';

/** Deterministic pseudo-samples: a fixed mean with a repeatable wobble, so a
 * verdict in these tests is a property of the maths, not of a lucky seed. */
const samples = (n: number, mean: number, spread: number): number[] =>
  Array.from({ length: n }, (_, i) => mean + spread * Math.sin(i * 2.399963));

describe('evaluate', () => {
  test('refuses a verdict below the sample floor', () => {
    const r = evaluate(
      { samples: samples(10, 30, 2) },
      { samples: samples(10, 20, 2) },
      { minSamples: 200 },
    );
    expect(r.verdict).toBe('inconclusive');
    expect(r.reason).toContain('sample floor');
  });

  test('one great run cannot adopt a technique', () => {
    const r = evaluate(
      { samples: samples(200, 30, 3) },
      // A single outstanding sample among ordinary ones.
      { samples: [1, ...samples(199, 30, 3)] },
      { minSamples: 200 },
    );
    expect(r.verdict).toBe('inconclusive');
  });

  test('a consistent speed-up is adopted, with the interval quoted', () => {
    const r = evaluate(
      { samples: samples(300, 30, 2) },
      { samples: samples(300, 22, 2) },
      { minSamples: 200 },
    );
    expect(r.verdict).toBe('adopt');
    expect(r.meanDeltaMs).toBeLessThan(0);
    expect(r.ci95[1]).toBeLessThan(0);
    expect(r.reason).toContain('95% CI');
  });

  test('a consistent slow-down is rejected', () => {
    const r = evaluate(
      { samples: samples(300, 22, 2) },
      { samples: samples(300, 30, 2) },
      { minSamples: 200 },
    );
    expect(r.verdict).toBe('reject');
    expect(r.ci95[0]).toBeGreaterThan(0);
  });

  test('noise around zero stays inconclusive rather than becoming a win', () => {
    const r = evaluate(
      { samples: samples(300, 30, 8) },
      { samples: samples(300, 29.9, 8) },
      { minSamples: 200 },
    );
    expect(r.verdict).toBe('inconclusive');
    expect(r.ci95[0]).toBeLessThan(0);
    expect(r.ci95[1]).toBeGreaterThan(0);
  });

  test('faster but dropping jobs is a rejection — correctness outranks latency', () => {
    const r = evaluate(
      { samples: samples(300, 30, 2), missed: 0 },
      { samples: samples(300, 15, 2), missed: 9 },
      { minSamples: 200 },
    );
    expect(r.verdict).toBe('reject');
    expect(r.reason).toContain('correctness regressed');
    // The speed-up is still reported; it just does not win.
    expect(r.meanDeltaMs).toBeLessThan(0);
  });

  test('faster but answering wrong is also a rejection', () => {
    const r = evaluate(
      { samples: samples(300, 30, 2), errors: 1 },
      { samples: samples(300, 15, 2), errors: 20 },
      { minSamples: 200 },
    );
    expect(r.verdict).toBe('reject');
    expect(r.reason).toContain('errors');
  });

  test('an explicit tolerance allows a tiny correctness cost to be traded away', () => {
    const arms = [
      { samples: samples(300, 30, 2), missed: 0 },
      { samples: samples(300, 15, 2), missed: 1 },
    ] as const;
    expect(evaluate(arms[0], arms[1], { minSamples: 200 }).verdict).toBe('reject');
    expect(
      evaluate(arms[0], arms[1], { minSamples: 200, correctnessToleranceRate: 0.01 }).verdict,
    ).toBe('adopt');
  });

  test('summaries carry n, p50 and p95 for both arms', () => {
    const r = evaluate(
      { samples: samples(250, 30, 4), missed: 5, errors: 2 },
      { samples: samples(250, 20, 4) },
      { minSamples: 200 },
    );
    expect(r.baseline.n).toBe(250);
    expect(r.baseline.p95).toBeGreaterThan(r.baseline.p50);
    expect(r.baseline.missedRate).toBeCloseTo(5 / 255, 6);
    expect(r.baseline.errorRate).toBeCloseTo(2 / 250, 6);
    expect(r.variant.missedRate).toBe(0);
  });

  test('a degenerate arm cannot produce a verdict', () => {
    const r = evaluate({ samples: [30] }, { samples: [1] }, { minSamples: 1 });
    expect(r.verdict).toBe('inconclusive');
    expect(r.ci95).toEqual([-Infinity, Infinity]);
  });

  test('minSamples must be positive', () => {
    expect(() => evaluate({ samples: [] }, { samples: [] }, { minSamples: 0 }))
      .toThrow(ValidationError);
  });
});
