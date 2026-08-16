/**
 * The local-only CSP (egress-monitor-origin-axis-2026-08-02 P-006).
 *
 * The expensive mistake this file guards is not a typo in a directive — it is
 * shipping the ENFORCING header while believing it is report-only. That mistake
 * is invisible in review (the two constants differ by one word), it cannot be
 * caught by any test that only reads the policy STRING, and its symptom is the
 * desktop app silently failing to load assets in front of a user.
 *
 * The second guard is that the policy must not quietly acquire a foreign origin.
 * A CSP naming `https://cdn.example.com` is a POLICY-LEVEL blessing of exactly
 * the egress this plan exists to remove, and it would make the browser stop
 * reporting it — turning the prevention leg into a laundering mechanism.
 */
import { describe, expect, it } from 'vitest';
import {
  CSP_ENFORCING_HEADER,
  CSP_REPORT_ONLY_HEADER,
  LOCAL_ONLY_CSP,
  cspReportOnlyHeaders,
} from './csp-policy';

/**
 * Any http(s) host in a policy that is not loopback. Exported shape kept simple
 * on purpose: it is negative-controlled below, so it cannot rot into a regex
 * that matches nothing and reports every policy as clean.
 */
function foreignHostsIn(policy: string): string[] {
  // `*` must be INSIDE the char class: the policy port-wildcards every local
  // source (`http://localhost:*`), so excluding `*` here truncates the match to
  // `localhost:` and the wildcard-strip below never fires — which reported all
  // four local sources as foreign.
  return [...policy.matchAll(/https?:\/\/([^\s;]+)/g)]
    .map((m) => m[1].replace(/:\*$/, ''))
    .filter((host) => host !== 'localhost' && host !== '127.0.0.1');
}

describe('LOCAL_ONLY_CSP (P-006)', () => {
  it('is served REPORT-ONLY, never as the enforcing header', () => {
    const headers = cspReportOnlyHeaders();
    expect(Object.keys(headers)).toEqual([CSP_REPORT_ONLY_HEADER]);
    expect(CSP_REPORT_ONLY_HEADER).toBe('Content-Security-Policy-Report-Only');
    // The enforcing header must not appear ANYWHERE in what we serve. Report-only
    // cannot break the app; the enforcing one can, and this policy has never been
    // validated against a real session.
    expect(Object.keys(headers)).not.toContain(CSP_ENFORCING_HEADER);
  });

  it('names no foreign origin', () => {
    expect(foreignHostsIn(LOCAL_ONLY_CSP)).toEqual([]);
  });

  it('NEGATIVE CONTROL: the foreign-origin detector actually fires', () => {
    // Without this, a regex that silently matched nothing would report the real
    // policy as clean forever — the exact vacuous-pass shape this plan is about.
    expect(foreignHostsIn("default-src 'self' https://cdn.jsdelivr.net")).toEqual([
      'cdn.jsdelivr.net',
    ]);
    expect(foreignHostsIn("connect-src 'self' http://evil.example.com:8080")).toEqual([
      'evil.example.com:8080',
    ]);
  });

  it('permits every LOCAL source, so a local-only app produces zero reports', () => {
    for (const src of ["'self'", 'papercusp:', 'http://localhost:*', 'http://127.0.0.1:*']) {
      expect(LOCAL_ONLY_CSP).toContain(src);
    }
  });

  it('permits inline/eval/blob/data so the stream is not drowned in non-egress noise', () => {
    // These are about HOW code runs, not WHERE it is fetched from. Reporting them
    // would bury the one signal that matters, and a noisy report-only stream is
    // one nobody reads — which is how the enforcing step never happens.
    for (const relaxation of ["'unsafe-inline'", "'unsafe-eval'", 'blob:', 'data:']) {
      expect(LOCAL_ONLY_CSP).toContain(relaxation);
    }
  });

  it('spells out connect-src with websocket schemes', () => {
    // default-src does not reliably cover ws: across engines, so a same-origin
    // HMR/sync socket would otherwise report as a violation on every page load.
    expect(LOCAL_ONLY_CSP).toMatch(/connect-src[^;]*ws:\/\/localhost:\*/);
    expect(LOCAL_ONLY_CSP).toMatch(/connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/);
  });
});
