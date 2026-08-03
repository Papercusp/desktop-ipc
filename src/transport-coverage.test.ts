/**
 * P-022 (no-http-anywhere-2026-07-28), built RE-SCOPED per that plan's D-062.
 *
 * ── WHY THIS IS NOT THE LINT P-022'S TITLE ASKS FOR ─────────────────────────
 *
 * P-022 reads "lint: no native fetch / EventSource / WebSocket / XMLHttpRequest
 * in app code — the guard that makes a fifth recurrence impossible." The goal is
 * right; the mechanism cannot deliver it, and D-062 records the measurement:
 *
 *   - The literal rule flags 478 call sites across 198 files, on correct code.
 *     `scripts/check-no-cdn-egress.mjs` documents that exact failure in its own
 *     header ("a guard whose first run reports 500 findings on correct code is a
 *     guard someone silences"). A 478-row baseline is ceremony, not safety.
 *   - Worse, it would have caught NONE of the four recurrences it exists to
 *     prevent. Every one was a hole in the POLYFILL, not app code misusing a
 *     transport: P-009 an unhandled `fetch(new Request(...))` FORM, P-010 an
 *     entirely unpatched global, P-011 an install that ran too LATE, P-013 an
 *     unguarded global. App code calling `fetch('/api/x')` is CORRECT — the
 *     polyfill replaces `window.fetch`, so ordinary call sites are routed.
 *
 * A fifth recurrence is therefore, by definition, a network-capable surface
 * reachable from the webview that is in NEITHER the routed nor the guarded set.
 * That is what this file asserts: coverage COMPLETENESS over a declared
 * inventory, not a ban over call sites. It is small, stable and needs no
 * baseline, because it scales with the web platform rather than with our code.
 *
 * ── HOW IT MAKES A FIFTH RECURRENCE HARD ────────────────────────────────────
 *
 * `NETWORK_CAPABLE_SURFACES` below is the curated list of ways webview code can
 * reach the network. Every entry MUST carry a treatment, and `uncovered` MUST
 * carry a reason. So a new transport cannot be adopted silently: whoever adds it
 * has to classify it here and say why, in a file whose whole subject is that
 * decision. That converts "nobody thought about it" — the actual failure mode
 * all four times — into a deliberate, reviewable act.
 *
 * The list is knowledge, not something derivable: the runtime cannot enumerate
 * "APIs that can reach the network". Adding to it as the platform grows IS the
 * maintenance burden, and it is the right one to carry.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Treatment = 'routed' | 'guarded' | 'uncovered';

interface Surface {
  /** The global as webview code names it. */
  readonly name: string;
  readonly treatment: Treatment;
  /**
   * For routed/guarded: a symbol that MUST appear in desktop-bootstrap.ts, so
   * deleting the wiring fails here rather than silently reopening the door.
   */
  readonly wiredBy?: string;
  /** For uncovered: why it is acceptable that nothing handles this today. */
  readonly reason?: string;
}

const NETWORK_CAPABLE_SURFACES: readonly Surface[] = [
  // ---- ROUTED: traffic is carried over the IPC channel ----
  { name: 'fetch', treatment: 'routed', wiredBy: 'window.fetch = patchedFetch' },
  { name: 'EventSource', treatment: 'routed', wiredBy: 'IpcEventSource' },

  // ---- GUARDED: not carried, but refused/flagged so it cannot silently escape ----
  { name: 'XMLHttpRequest', treatment: 'guarded', wiredBy: 'installXhrGuard' },
  { name: 'WebSocket', treatment: 'guarded', wiredBy: 'installWsGuard' },

  // ---- UNCOVERED: deliberate, with the reason recorded ----
  {
    name: 'Worker',
    treatment: 'uncovered',
    reason:
      'THE STRONGEST fifth-recurrence candidate (D-062). A worker gets a FRESH ' +
      'global scope, so the main-window patches above simply do not apply and a ' +
      'fetch() inside one bypasses every treatment. Acceptable ONLY because the ' +
      'webview currently constructs no Worker: the two `new Worker` sites in the ' +
      'repo are Node worker_threads in server-side libs (tooldef/code-orchestration ' +
      'run-script.ts, memory/local-embedder-worker.ts), which never run in the ' +
      'webview. This is a coverage gap, not a live bug — which is exactly the ' +
      'state XMLHttpRequest and WebSocket were in before someone used them. ' +
      'Introducing a webview Worker REQUIRES routing or guarding its scope first.',
  },
  {
    name: 'SharedWorker',
    treatment: 'uncovered',
    reason: 'Same fresh-global-scope problem as Worker, and likewise unused by the webview.',
  },
  {
    name: 'sendBeacon',
    treatment: 'uncovered',
    reason:
      'Unused by our code. Note the RUNTIME leg is ahead of the static one here: ' +
      'egress-monitor.ts already records sendBeacon, so an actual use would be ' +
      'observed live even though nothing prevents it statically.',
  },
  {
    name: 'WebTransport',
    treatment: 'uncovered',
    reason: 'Not used, and not implemented by the WebKitGTK build the Linux desktop ships.',
  },
  {
    name: 'RTCPeerConnection',
    treatment: 'uncovered',
    reason:
      'Not used for /api traffic. The p2p-voice stack is a separate LISTENER on its ' +
      'own origin, which ws-guard.ts deliberately exempts as one that "must keep its ' +
      'native socket" — so it is out of scope for this plan, not an oversight.',
  },
  {
    name: 'serviceWorker',
    treatment: 'uncovered',
    reason:
      'None registered. A service worker would intercept requests from OUTSIDE the ' +
      'patched document scope, so registering one requires re-deciding this file.',
  },
];

const bootstrapSource = readFileSync(
  fileURLToPath(new URL('./desktop-bootstrap.ts', import.meta.url)),
  'utf8',
);

describe('transport coverage (P-022 / D-062)', () => {
  it('classifies every network-capable surface — no surface may be left unclassified', () => {
    for (const s of NETWORK_CAPABLE_SURFACES) {
      expect(
        ['routed', 'guarded', 'uncovered'],
        `${s.name} has no valid treatment`,
      ).toContain(s.treatment);
    }
    // Guards against a duplicate entry quietly shadowing a real classification.
    const names = NETWORK_CAPABLE_SURFACES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('requires a REASON for every uncovered surface', () => {
    for (const s of NETWORK_CAPABLE_SURFACES.filter((x) => x.treatment === 'uncovered')) {
      expect(s.reason?.trim(), `${s.name} is uncovered with no stated reason`).toBeTruthy();
      // A one-word "n/a" defeats the purpose: the reason is the review artifact.
      expect(s.reason!.length, `${s.name}'s reason is too thin to review`).toBeGreaterThan(40);
    }
  });

  it('holds the four covered doors OPEN — each must still be wired in desktop-bootstrap', () => {
    // The four recurrences this plan closed. If wiring is deleted or renamed,
    // this fails here instead of at runtime in a shipped desktop.
    const covered = NETWORK_CAPABLE_SURFACES.filter(
      (s) => s.treatment === 'routed' || s.treatment === 'guarded',
    );
    expect(covered).toHaveLength(4);
    for (const s of covered) {
      expect(s.wiredBy, `${s.name} is ${s.treatment} but names no wiring symbol`).toBeTruthy();
      expect(
        bootstrapSource.includes(s.wiredBy!),
        `${s.name} is declared ${s.treatment} via "${s.wiredBy}", but that symbol is ` +
          `absent from desktop-bootstrap.ts — the door it closed may be open again`,
      ).toBe(true);
    }
  });

  it('keeps the egress monitor installed BEFORE the guards (the P-011 class)', () => {
    // P-011 was not a missing patch but a LATE one: 7 /api/desktop/* calls went
    // native at 481-606 ms because install ran after them. Coverage that arrives
    // late is indistinguishable from absent for everything that already ran, so
    // ordering is part of the contract, not an implementation detail.
    const egressAt = bootstrapSource.indexOf('installEgressMonitor(');
    const xhrAt = bootstrapSource.indexOf('installXhrGuard()');
    const wsAt = bootstrapSource.indexOf('installWsGuard()');
    expect(egressAt, 'installEgressMonitor( not found').toBeGreaterThan(-1);
    expect(xhrAt, 'installXhrGuard() not found').toBeGreaterThan(-1);
    expect(wsAt, 'installWsGuard() not found').toBeGreaterThan(-1);
    expect(egressAt, 'the egress monitor must install before the XHR guard').toBeLessThan(xhrAt);
    expect(egressAt, 'the egress monitor must install before the WS guard').toBeLessThan(wsAt);
  });
});
