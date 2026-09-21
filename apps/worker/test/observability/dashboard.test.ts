import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DASHBOARD_HTML } from '../../src/observability/dashboard.ts';

describe('dashboard latency labels', () => {
  test('shows independent distributions without inventing arithmetic', () => {
    expect(DASHBOARD_HTML).toContain('latency breakdown · rolling p50');
    expect(DASHBOARD_HTML).toContain('LINE trigger→reply');
    expect(DASHBOARD_HTML).toContain(
      "tile('LINE trigger → reply', crossHost.line_round_trip, undefined, 'line-trigger-reply')",
    );
    expect(DASHBOARD_HTML).toContain('.lb-tile.line-trigger-reply');
    expect(DASHBOARD_HTML).toContain("tile('CODE ถึง transport', spans.code)");
    expect(DASHBOARD_HTML).not.toContain('spans.sequence_prep');
    expect(DASHBOARD_HTML).not.toContain('spans.protocol_prep');
    expect(DASHBOARD_HTML).toContain("Math.round(v * 1000) + 'µs'");
    expect(DASHBOARD_HTML).not.toContain('p50 − p50');
    expect(DASHBOARD_HTML).not.toContain('Go เตรียม upstream request');
    expect(DASHBOARD_HTML).not.toContain('<span class="lb-op">');
    expect(DASHBOARD_HTML).toContain('<th>app p95</th>');
    expect(DASHBOARD_HTML).toContain('<th>route est.</th>');
    expect(DASHBOARD_HTML).toContain('<th>warm rtt</th>');
    expect(DASHBOARD_HTML).toContain('ms(l.tailRttMs)');
    expect(DASHBOARD_HTML).toContain('ms(l.predictedRttMs)');
    expect(DASHBOARD_HTML).toContain('ms(l.warmRttMs)');
    expect(DASHBOARD_HTML).toContain('ไม่ถูกนับเป็นเวลาส่งข้อความ');
  });
});
