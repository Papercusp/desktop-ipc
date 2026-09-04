import cspPolicy from './csp-policy.json';

/**
 * The Content-Security-Policy for a local-first desktop app
 * (egress-monitor-origin-axis-2026-08-02 P-006).
 *
 * THE POINT OF THIS FILE is the DESTINATION invariant, the same one
 * `egress-monitor.ts` observes: nothing may be fetched from a host we do not own.
 * The egress monitor OBSERVES violations after the fact; a CSP PREVENTS them.
 * That is why the plan calls them complementary legs (D-003) rather than
 * alternatives — and why this policy is deliberately permissive about
 * everything EXCEPT origin.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS REPORT-ONLY, AND WHY THAT IS NOT AVAILABLE FROM tauri.conf.json.
 *
 * See plan decision D-004. Tauri 2.11.3 emits exactly one header name across its
 * whole source tree — the ENFORCING `Content-Security-Policy` — and
 * `tauri-utils` exposes exactly one field, `pub csp: Option<Csp>`. There is no
 * report-only variant. Nor can the usual escape hatch help:
 * `Content-Security-Policy-Report-Only` is header-only BY SPEC, so a
 * `<meta http-equiv>` tag is ignored by browsers.
 *
 * So the header is set by the servers that actually serve the SPA document,
 * which is what this module exists to keep consistent between them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS PERMISSIVE ABOUT EVERYTHING EXCEPT ORIGIN.
 *
 * A textbook `default-src 'self'` also bans inline styles, `eval`, blob workers
 * and data: URIs. Those are all things this app legitimately does, and every one
 * of them would generate violation reports that have NOTHING to do with egress.
 * A report-only stream that is 95% inline-style noise is a stream nobody reads —
 * and then the enforcing step never happens because "the reports are messy",
 * which is how a security control dies quietly.
 *
 * So `'unsafe-inline'`, `'unsafe-eval'`, `blob:` and `data:` are ALLOWED here on
 * purpose. They are not an oversight and tightening them is a SEPARATE piece of
 * work with a separate rationale. This policy is scoped to answer exactly one
 * question — *did something contact a host we do not own?* — which makes every
 * report it produces actionable, and makes the eventual flip to enforcing safe.
 */

/**
 * The report-only header name. Report-only is HEADER-ONLY by spec: setting this
 * as a `<meta http-equiv>` does nothing at all.
 */
export const CSP_REPORT_ONLY_HEADER = cspPolicy.reportOnlyHeader;

/** The enforcing header name, for the eventual flip. Not used yet. */
export const CSP_ENFORCING_HEADER = 'Content-Security-Policy';

/**
 * Sources that are "ours" and therefore never egress. Mirrors the loopback
 * family in `egress-monitor.ts`'s LOCAL_HOSTNAMES plus the desktop's custom
 * scheme, so the two legs agree on what "local" means.
 *
 * A port-wildcarded `http://localhost:*` is required because the app is served
 * on several ports (3055 vite, 3070 operator, 3170 staging, 3270 desktop, and
 * whatever an isolated e2e run picks).
 */
/**
 * The policy. One directive: `default-src` covers every fetch directive that is
 * not otherwise specified, which is exactly the breadth we want — a foreign
 * script, style, image, font, frame, worker or fetch all report identically.
 *
 * `connect-src` is spelled out separately ONLY because it must also carry the
 * websocket schemes; `default-src` does not reliably cover `ws:` across engines.
 */
export const LOCAL_ONLY_CSP: string = cspPolicy.policy;

/**
 * The header pair to attach to an SPA **document** response. A CSP applies to
 * the document it is served with, so attaching it to a .js or .css response
 * accomplishes nothing.
 */
export function cspReportOnlyHeaders(): Record<string, string> {
  return { [CSP_REPORT_ONLY_HEADER]: LOCAL_ONLY_CSP };
}

/**
 * Cross-origin isolation headers (P-005 wake-word investigation, WI-4498).
 *
 * `SharedArrayBuffer` — and therefore onnxruntime-web's THREADED wasm backend,
 * which is the only backend it ships at the pinned version (no single-threaded
 * `ort-wasm-simd.wasm` asset exists) — is only available to a document that is
 * "cross-origin isolated". A document becomes cross-origin isolated when it is
 * served with BOTH of these headers together; either one alone does nothing.
 *
 * Unlike the CSP above this pair is safe to set unconditionally here: every
 * subresource this app loads is same-origin (the SPA document, its hashed JS/
 * CSS/wasm bundle, and the `/api`+`/internal/docs` proxy targets are all served
 * by the SAME Hono host that serves this document — see host-spa.ts / this
 * file's other call site in operator-vite's dev server). A `require-corp`
 * embedder policy only requires an explicit `Cross-Origin-Resource-Policy`
 * header on CROSS-origin subresources; same-origin ones are exempt by spec, so
 * this app's asset responses need no matching change.
 *
 * `Cross-Origin-Opener-Policy: same-origin` additionally isolates the
 * document's browsing-context group from any cross-origin window that could
 * hold a reference to it — required for isolation, and harmless here since
 * this app never opens/is-opened-by a cross-origin window (`window.open` isn't
 * used against a foreign origin; the desktop shell is single-window).
 */
export function crossOriginIsolationHeaders(): Record<string, string> {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
}
