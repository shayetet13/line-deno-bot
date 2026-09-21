import { ACCEPTANCE_CASES, type AcceptanceCase, type CaseResult } from './cases.ts';

export interface CaseReport extends CaseResult {
  id: string;
  requirement: string;
  /** Wall time the case took, ms. Diagnostic only — never a latency claim. */
  durationMs: number;
  /** Present when the case threw rather than returning a verdict. */
  error?: string;
}

export interface AcceptanceReport {
  generatedAtMs: number;
  total: number;
  passed: number;
  failed: number;
  cases: readonly CaseReport[];
  /** Deliberate, and repeated in the CLI output: this suite proves correctness,
   * not speed (Phases §18 — a local replay is not a live LINE latency claim). */
  limitations: readonly string[];
}

export const LIMITATIONS: readonly string[] = [
  'Local replay: correctness only. No number here is a live LINE latency claim.',
  'The sender is scripted, so send RTT is fixed by the harness, not measured.',
  'Live first-response figures come from `deno task bench` / `deno task probe` on the ' +
  'production host, reported with their sample counts.',
  'No competing bot took part, so nothing here is a win against a real opponent — ' +
  'it is a controlled comparison of our own behaviour.',
];

/** Runs every case. A case that throws is a failure with the error attached,
 * never a crash that hides the rest of the table. */
export async function runAcceptance(
  cases: readonly AcceptanceCase[] = ACCEPTANCE_CASES,
): Promise<AcceptanceReport> {
  const results: CaseReport[] = [];
  for (const c of cases) {
    const startedAt = performance.now();
    try {
      const result = await c.run();
      results.push({
        id: c.id,
        requirement: c.requirement,
        ...result,
        durationMs: round(performance.now() - startedAt),
      });
    } catch (err: unknown) {
      results.push({
        id: c.id,
        requirement: c.requirement,
        pass: false,
        detail: 'case threw',
        error: err instanceof Error ? err.message : String(err),
        durationMs: round(performance.now() - startedAt),
      });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  return {
    generatedAtMs: Date.now(),
    total: results.length,
    passed,
    failed: results.length - passed,
    cases: results,
    limitations: LIMITATIONS,
  };
}

export function formatReport(report: AcceptanceReport): string {
  const lines: string[] = [
    'Phase 10 — acceptance',
    '='.repeat(64),
    '',
  ];
  for (const c of report.cases) {
    lines.push(`${c.pass ? 'PASS' : 'FAIL'}  ${c.id}`);
    lines.push(`      ${c.requirement}`);
    lines.push(`      ${c.detail}`);
    if (c.error !== undefined) lines.push(`      error: ${c.error}`);
    lines.push('');
  }
  lines.push('-'.repeat(64));
  lines.push(
    `${String(report.passed)}/${String(report.total)} passed` +
      (report.failed > 0 ? `, ${String(report.failed)} FAILED` : ''),
  );
  lines.push('');
  lines.push('Known limitations');
  for (const l of report.limitations) lines.push(`  - ${l}`);
  return lines.join('\n');
}

const round = (ms: number): number => Math.round(ms * 1000) / 1000;
