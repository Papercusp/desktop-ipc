/**
 * The local-only CSP (egress-monitor-origin-axis-2026-08-02 P-006).
 *
 * The expensive mistake this file guards is collapsing two policies into one.
 * D-002 requires code/content origins to enforce while strict `connect-src`
 * remains report-only, because enforcing that connection rule breaks voice.
 *
 * The second guard is that the policy must not quietly acquire a foreign origin.
 * A CSP naming `https://cdn.example.com` is a POLICY-LEVEL blessing of exactly
 * the egress this plan exists to remove, and it would make the browser stop
 * reporting it — turning the prevention leg into a laundering mechanism.
 */
import { describe, expect, it } from 'vitest';
import {
  CODE_ORIGIN_ENFORCING_CSP,
  CSP_ENFORCING_HEADER,
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
  LOCAL_ONLY_CSP,
  cspHeaders,
  crossOriginIsolationHeaders,
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
    .filter((host) => !['localhost', '127.0.0.1', 'ipc.localhost'].includes(host));
}

function directiveSources(policy: string, directive: string): string[] {
  const directives = new Map(
    policy.split(';').map((entry) => {
      const [name, ...sources] = entry.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
  return directives.get(directive) ?? directives.get('default-src') ?? [];
}

function permitsOrigin(policy: string, directive: string, origin: string): boolean {
  const sources = directiveSources(policy, directive);
  const scheme = new URL(origin).protocol;
  return (
    sources.includes(origin) ||
    (sources.includes('*') && (scheme === 'http:' || scheme === 'https:')) ||
    sources.includes(scheme) ||
    (scheme === 'wss:' && sources.includes('ws:'))
  );
}

describe('split desktop CSP (P-005 / D-002)', () => {
  it('serves an enforcing code/content policy and a strict report-only connection policy', () => {
    const headers = cspHeaders();
    expect(Object.keys(headers)).toEqual([CSP_ENFORCING_HEADER, CSP_REPORT_ONLY_HEADER]);
    expect(CSP_HEADER).toBe('Content-Security-Policy');
    expect(CSP_ENFORCING_HEADER).toBe('Content-Security-Policy');
    expect(CSP_REPORT_ONLY_HEADER).toBe('Content-Security-Policy-Report-Only');
    expect(headers[CSP_ENFORCING_HEADER]).toBe(CODE_ORIGIN_ENFORCING_CSP);
    expect(headers[CSP_REPORT_ONLY_HEADER]).toBe(LOCAL_ONLY_CSP);
  });

  it('keeps ElevenLabs signaling usable while the strict policy observes it', () => {
    for (const origin of [
      'https://api.elevenlabs.io',
      'wss://livekit.rtc.elevenlabs.io',
    ]) {
      expect(permitsOrigin(CODE_ORIGIN_ENFORCING_CSP, 'connect-src', origin)).toBe(true);
      expect(permitsOrigin(LOCAL_ONLY_CSP, 'connect-src', origin)).toBe(false);
    }
  });

  it('still blocks foreign script and frame origins in the enforcing policy', () => {
    const foreignOrigin = 'https://cdn.example.invalid';
    for (const directive of ['script-src', 'frame-src']) {
      expect(permitsOrigin(CODE_ORIGIN_ENFORCING_CSP, directive, foreignOrigin)).toBe(false);
      // Negative control: the detector must fire when the code/content boundary
      // is actually widened, rather than blessing every fixture by construction.
      expect(permitsOrigin("default-src *; connect-src *", directive, foreignOrigin)).toBe(true);
    }
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
    for (const src of [
      "'self'",
      'papercusp:',
      'http://ipc.localhost',
      'http://localhost:*',
      'http://127.0.0.1:*',
    ]) {
      expect(LOCAL_ONLY_CSP).toContain(src);
    }
  });

  it('allows only the owned IPC pseudo-origin, not a lookalike remote host', () => {
    expect(foreignHostsIn("connect-src 'self' http://ipc.localhost")).toEqual([]);
    expect(foreignHostsIn("connect-src 'self' https://ipc.localhost.evil.example")).toEqual([
      'ipc.localhost.evil.example',
    ]);
  });

  it('permits inline/eval/blob/data so the stream is not drowned in non-egress noise', () => {
    // These are about HOW code runs, not WHERE it is fetched from. Reporting them
    // would bury the one signal that matters, and a noisy report-only stream is
    // one nobody reads — which is how the enforcing step never happens.
    for (const relaxation of ["'unsafe-inline'", "'unsafe-eval'", 'blob:', 'data:']) {
      expect(LOCAL_ONLY_CSP).toContain(relaxation);
    }
  });

  it('spells out the strict report-only connect-src with websocket schemes', () => {
    // default-src does not reliably cover ws: across engines, so a same-origin
    // HMR/sync socket would otherwise report as a violation on every page load.
    expect(LOCAL_ONLY_CSP).toMatch(/connect-src[^;]*ws:\/\/localhost:\*/);
    expect(LOCAL_ONLY_CSP).toMatch(/connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/);
  });
});

describe('crossOriginIsolationHeaders (P-005 / WI-4498)', () => {
  it('sets both COOP and COEP — either alone does not cross-origin-isolate', () => {
    const headers = crossOriginIsolationHeaders();
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['Cross-Origin-Embedder-Policy']).toBe('require-corp');
  });

  it('is ENFORCING, not report-only — there is no report-only variant of COOP/COEP', () => {
    // Distinct from the CSP pair above: unlike Content-Security-Policy, neither
    // header has a "-Report-Only" form, so this must never be gated behind the
    // report-only mechanism above — asserting the literal names catches a typo
    // (e.g. 'unsafe-none' / 'credentialless') silently downgrading isolation.
    const headers = crossOriginIsolationHeaders();
    expect(Object.keys(headers).sort()).toEqual([
      'Cross-Origin-Embedder-Policy',
      'Cross-Origin-Opener-Policy',
    ]);
  });
});
