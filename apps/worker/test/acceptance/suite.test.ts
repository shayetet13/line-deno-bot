import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ACCEPTANCE_CASES } from '../../src/acceptance/cases.ts';
import { formatReport, runAcceptance } from '../../src/acceptance/report.ts';

/**
 * The acceptance table runs inside the normal gate. A regression that breaks
 * one of these rows fails the build rather than waiting to be noticed live.
 */
describe('Phase 10 acceptance table', () => {
  for (const c of ACCEPTANCE_CASES) {
    test(`${c.id} — ${c.requirement}`, async () => {
      const result = await c.run();
      // The detail line is in the assertion so a failure says what was observed.
      expect(`${c.id}: ${result.detail}`).toBe(`${c.id}: ${result.detail}`);
      expect(result.pass, result.detail).toBe(true);
    });
  }

  test('every row of the Phases §18 table has a case', () => {
    expect(ACCEPTANCE_CASES.length).toBe(12);
    const ids = new Set(ACCEPTANCE_CASES.map((c) => c.id));
    expect(ids.size).toBe(ACCEPTANCE_CASES.length);
    for (const c of ACCEPTANCE_CASES) expect(c.requirement.length).toBeGreaterThan(10);
  });
});

describe('acceptance report', () => {
  test('runs the whole table and counts pass/fail', async () => {
    const report = await runAcceptance();
    expect(report.total).toBe(ACCEPTANCE_CASES.length);
    expect(report.passed).toBe(report.total);
    expect(report.failed).toBe(0);
  });

  test('a throwing case is a failure, not a crash that hides the rest', async () => {
    const report = await runAcceptance([
      {
        id: 'boom',
        requirement: 'a case that throws',
        run: () => Promise.reject(new Error('kaboom')),
      },
      {
        id: 'fine',
        requirement: 'a case that passes',
        run: () => Promise.resolve({ pass: true, detail: 'ok' }),
      },
    ]);
    expect(report.failed).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.cases[0]?.error).toBe('kaboom');
  });

  test('the report states its limitations so no one quotes it as live latency', async () => {
    const text = formatReport(
      await runAcceptance([
        { id: 'x', requirement: 'y', run: () => Promise.resolve({ pass: true, detail: 'ok' }) },
      ]),
    );
    expect(text).toContain('Known limitations');
    expect(text).toContain('No number here is a live LINE latency claim');
    expect(text).toContain('1/1 passed');
  });
});
