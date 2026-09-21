import { ValidationError } from '../errors/base.ts';

/**
 * Turns two sets of latency samples into a verdict.
 *
 * Written to make the failure mode in Phases §18 impossible: "ไม่ประกาศผ่านจาก
 * ครั้งที่ดีที่สุด" — you cannot adopt a technique because one run looked good.
 * A verdict needs the sample floor met AND a 95% interval on the difference
 * that stays on one side of zero.
 */

export type Verdict = 'adopt' | 'reject' | 'inconclusive';

export interface Arm {
  /** Latency samples, milliseconds. Order is irrelevant. */
  readonly samples: readonly number[];
  /** Jobs the arm failed to answer at all. Correctness beats speed. */
  readonly missed?: number;
  /** Jobs answered with an error or a wrong answer. */
  readonly errors?: number;
}

export interface EvaluateOptions {
  /** Per-arm sample floor from the experiment definition. */
  minSamples: number;
  /** How much worse the variant's missed/error rate may get before the
   * technique is rejected regardless of latency. Default: not at all. */
  correctnessToleranceRate?: number;
}

export interface ArmSummary {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  missedRate: number;
  errorRate: number;
}

export interface Evaluation {
  verdict: Verdict;
  /** One line a human can paste into the registry note. */
  reason: string;
  baseline: ArmSummary;
  variant: ArmSummary;
  /** variant − baseline, in ms. Negative means the variant is faster. */
  meanDeltaMs: number;
  p50DeltaMs: number;
  /** 95% interval on `meanDeltaMs`. Entirely below zero ⇒ a real speed-up. */
  ci95: readonly [number, number];
}

/** 95% two-sided normal quantile. Samples here are in the hundreds, so the
 * normal approximation to Welch's t is close enough and keeps this dependency-free. */
const Z95 = 1.959964;

export function evaluate(
  baseline: Arm,
  variant: Arm,
  options: EvaluateOptions,
): Evaluation {
  if (options.minSamples < 1) {
    throw new ValidationError('minSamples must be positive', { minSamples: options.minSamples });
  }

  const b = summarize(baseline);
  const v = summarize(variant);
  const meanDeltaMs = round(v.mean - b.mean);
  const p50DeltaMs = round(v.p50 - b.p50);
  const ci95 = confidenceInterval(baseline.samples, variant.samples);
  const base = { baseline: b, variant: v, meanDeltaMs, p50DeltaMs, ci95 };

  if (b.n < options.minSamples || v.n < options.minSamples) {
    return {
      ...base,
      verdict: 'inconclusive',
      reason:
        `below the sample floor (baseline ${b.n}, variant ${v.n}, need ${options.minSamples} each)`,
    };
  }

  // Correctness first. A technique that answers faster but drops jobs is a
  // net loss no matter how good the latency looks (Phases §17 pass criteria).
  const tolerance = options.correctnessToleranceRate ?? 0;
  const missedWorseBy = v.missedRate - b.missedRate;
  const errorWorseBy = v.errorRate - b.errorRate;
  if (missedWorseBy > tolerance || errorWorseBy > tolerance) {
    return {
      ...base,
      verdict: 'reject',
      reason: `correctness regressed (missed ${pct(b.missedRate)}→${pct(v.missedRate)}, ` +
        `errors ${pct(b.errorRate)}→${pct(v.errorRate)})`,
    };
  }

  const [lo, hi] = ci95;
  if (hi < 0) {
    return {
      ...base,
      verdict: 'adopt',
      reason: `mean ${fmt(-meanDeltaMs)}ms faster, 95% CI [${fmt(lo)}, ${
        fmt(hi)
      }] entirely below 0`,
    };
  }
  if (lo > 0) {
    return {
      ...base,
      verdict: 'reject',
      reason: `mean ${fmt(meanDeltaMs)}ms slower, 95% CI [${fmt(lo)}, ${fmt(hi)}] entirely above 0`,
    };
  }
  return {
    ...base,
    verdict: 'inconclusive',
    reason: `95% CI [${fmt(lo)}, ${fmt(hi)}] straddles 0 — no measurable difference at this n`,
  };
}

function summarize(arm: Arm): ArmSummary {
  const n = arm.samples.length;
  const sorted = [...arm.samples].sort((x, y) => x - y);
  const denominator = n + (arm.missed ?? 0);
  return {
    n,
    mean: round(mean(arm.samples)),
    p50: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
    missedRate: denominator === 0 ? 0 : (arm.missed ?? 0) / denominator,
    errorRate: n === 0 ? 0 : (arm.errors ?? 0) / n,
  };
}

/** Welch: the two arms are not assumed to share a variance, and need not be
 * the same size — an A/B that ran unevenly is still usable. */
function confidenceInterval(
  baseline: readonly number[],
  variant: readonly number[],
): readonly [number, number] {
  if (baseline.length < 2 || variant.length < 2) return [-Infinity, Infinity];
  const se = Math.sqrt(
    variance(baseline) / baseline.length + variance(variant) / variant.length,
  );
  const delta = mean(variant) - mean(baseline);
  return [round(delta - Z95 * se), round(delta + Z95 * se)];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

function variance(values: readonly number[]): number {
  const m = mean(values);
  let total = 0;
  for (const v of values) total += (v - m) ** 2;
  return total / (values.length - 1);
}

/** Nearest-rank, matching {@link ../metrics/ring.ts} so the numbers agree. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value;
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : String(value);
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
