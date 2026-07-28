/**
 * @vitest-environment jsdom
 *
 * The egress invariant: inside the desktop shell, an `/api/*` request that
 * reaches the real network stack is a bug (no-http-anywhere-2026-07-28 D-005,
 * P-003a). These tests pin the CLASSIFIER, which is deliberately pure so the
 * rule can be verified without the environment whose bug it detects.
 *
 * The fixture in "the measured 2026-07-28 shell" is real data, not invented:
 * it is the 9 escapes read out of a live Tauri webview's resource timing.
 */
import { describe, expect, it } from 'vitest';
import { classifyEgress, EGRESS_RING_SIZE, type ResourceTimingLike } from './egress-monitor';

const r = (name: string, startTime: number, duration = 5): ResourceTimingLike => ({
  name,
  startTime,
  duration,
});

const ORIGIN = 'http://127.0.0.1:3270';

describe('classifyEgress', () => {
  it('reports zero for a shell whose /api traffic all went over IPC', () => {
    // IPC-routed requests produce NO resource-timing entry at all — that is the
    // whole reason this sensor is exact. A clean shell still loads assets.
    const report = classifyEgress(
      [r(`${ORIGIN}/assets/client-abc.js`, 120), r(`${ORIGIN}/assets/app.css`, 130)],
      { origin: ORIGIN },
    );
    expect(report.total).toBe(0);
    expect(report.firstAtMs).toBeNull();
    expect(report.entries).toEqual([]);
  });

  it('flags every /api escape from the measured 2026-07-28 shell', () => {
    const report = classifyEgress(
      [
        r(`${ORIGIN}/api/desktop/dev-operators`, 480, 8),
        r(`${ORIGIN}/api/desktop/telemetry-config`, 495, 3),
        r(`${ORIGIN}/api/desktop/version`, 501, 1),
        r(`${ORIGIN}/api/desktop/dev-operators`, 569, 8),
        r(`${ORIGIN}/api/desktop/telemetry-config`, 577, 4),
        r(`${ORIGIN}/api/desktop/version`, 578, 2),
        r(`${ORIGIN}/api/desktop/setup-wizard-state`, 637, 4),
        r(`${ORIGIN}/api/desktop/git-pipeline`, 783, 1816),
        r(`${ORIGIN}/api/desktop/git-pipeline`, 783, 1816),
        r(`${ORIGIN}/assets/client-abc.js`, 120),
      ],
      { origin: ORIGIN },
    );
    expect(report.total).toBe(9);
    expect(report.firstAtMs).toBe(480);
    // Per-path rollup makes the repeat offender obvious without reading entries.
    expect(report.byPath['/api/desktop/dev-operators'].count).toBe(2);
    expect(report.byPath['/api/desktop/git-pipeline']).toEqual({
      count: 2,
      totalMs: 3632,
      firstAtMs: 783,
    });
    expect(Object.keys(report.byPath)).toHaveLength(5);
  });

  it('ignores a cross-origin /api call — only OUR api is the invariant', () => {
    const report = classifyEgress([r('https://api.example.com/api/thing', 200)], { origin: ORIGIN });
    expect(report.total).toBe(0);
  });

  it('honours declared exemptions by path prefix', () => {
    const entries = [r(`${ORIGIN}/api/desktop/version`, 100), r(`${ORIGIN}/api/zero-harness/rest-query`, 200)];
    const report = classifyEgress(entries, { origin: ORIGIN, exemptPrefixes: ['/api/desktop/'] });
    expect(report.total).toBe(1);
    expect(report.byPath['/api/zero-harness/rest-query'].count).toBe(1);
  });

  it('survives a malformed entry name instead of reporting a false clean', () => {
    // A detector that throws reports zero, which is indistinguishable from a pass —
    // the exact failure mode this whole item exists to eliminate.
    const report = classifyEgress(
      [{ name: '::::not a url', startTime: 1, duration: 1 }, r(`${ORIGIN}/api/desktop/version`, 2)],
      { origin: ORIGIN },
    );
    expect(report.total).toBe(1);
  });

  it('orders entries by start time and bounds the ring', () => {
    const many = Array.from({ length: EGRESS_RING_SIZE + 40 }, (_, i) =>
      r(`${ORIGIN}/api/x/${i}`, EGRESS_RING_SIZE + 40 - i),
    );
    const report = classifyEgress(many, { origin: ORIGIN });
    expect(report.total).toBe(EGRESS_RING_SIZE + 40);
    expect(report.entries).toHaveLength(EGRESS_RING_SIZE);
    // Sorted ascending, and it is the LATEST window that is retained.
    expect(report.entries[0].startMs).toBeLessThan(report.entries[report.entries.length - 1].startMs);
  });

  it('counts an XHR-issued /api call the fetch polyfill never saw (P-010)', () => {
    // Resource timing is transport-agnostic: this is why the sensor sits here
    // rather than inside the patched fetch, which XHR bypasses entirely.
    const report = classifyEgress([r(`${ORIGIN}/api/desktop/version`, 300)], { origin: ORIGIN });
    expect(report.total).toBe(1);
  });
});
