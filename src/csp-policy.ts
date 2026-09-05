import cspPolicy from './csp-policy.json';

/**
 * The Content-Security-Policy for a local-first desktop app
 * (egress-monitor-origin-axis-2026-08-02 P-006).
 *
 * THE POINT OF THIS FILE is to enforce the origin boundary for executable and
 * rendered content while continuing to observe the stricter destination
 * invariant for connections. Plan D-002 requires that split because the
 * ElevenLabs voice path must signal over foreign HTTPS/WSS origins, while
 * foreign script/frame/content must never execute inside trusted app chrome.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE POLICY IS SPLIT, AND WHY IT IS NOT SET FROM tauri.conf.json.
 *
 * The code/content leg is enforcing after the P-005 live sweep proved the
 * trusted routes clean. The connection leg remains report-only: an enforcing
 * local-only `connect-src` blocks the ElevenLabs HTTPS/WSS signaling that D-001
 * explicitly preserves. The enforcing policy therefore gives `connect-src` a
 * wildcard while the paired report-only policy retains the local-only list.
 * Naming the voice vendor in either policy is deliberately avoided: the
 * observation policy stays vendor-neutral and detects every foreign destination.
 *
 * The header is still set by the servers rather than tauri.conf.json (D-004):
 * Tauri 2.11.3 exposes exactly one field, `pub csp: Option<Csp>`, and its own
 * asset-CSP rewriting is disabled here, so keeping all three servers on this one
 * shared JSON is what stops them drifting apart.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY BOTH POLICIES ARE PERMISSIVE ABOUT EXECUTION SHAPE.
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
 * question — *did content come from, or a connection reach, a host we do not
 * own?* — while D-002 decides which half is safe to enforce.
 */

/**
 * The enforcing header name — what we now actually serve.
 *
 * CSP is HEADER-ONLY for our purposes: a `<meta http-equiv>` tag cannot express
 * report-only at all, and Tauri exposes no report-only field (D-004), which is
 * why the servers below set the header themselves rather than tauri.conf.json.
 */
export const CSP_ENFORCING_HEADER: string = cspPolicy.enforcingHeader;

/**
 * Compatibility alias for callers that historically imported the one served
 * header. It remains the enforcing name; new code should use the explicit pair.
 */
export const CSP_HEADER: string = CSP_ENFORCING_HEADER;

/**
 * The report-only header name for the strict destination-observation leg.
 */
export const CSP_REPORT_ONLY_HEADER: string = cspPolicy.reportOnlyHeader;

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
 * The strict local-only policy retained under the report-only header. Its
 * `default-src` covers content directives and its `connect-src` observes every
 * non-local connection without blocking a preserved workflow.
 *
 * `connect-src` is spelled out separately ONLY because it must also carry the
 * websocket schemes; `default-src` does not reliably cover `ws:` across engines.
 */
export const LOCAL_ONLY_CSP: string = cspPolicy.reportOnlyPolicy;

/**
 * The enforcing code/content policy. `default-src` remains local-only, while an
 * explicit wildcard `connect-src` prevents that fallback from blocking voice or
 * another legitimate integration. The stricter connection rule lives in
 * [`LOCAL_ONLY_CSP`] and reports the same request without enforcing it.
 */
export const CODE_ORIGIN_ENFORCING_CSP: string = cspPolicy.enforcingPolicy;

/**
 * The header pair to attach to an SPA **document** response. A CSP applies to
 * the document it is served with, so attaching it to a .js or .css response
 * accomplishes nothing.
 */
export function cspHeaders(): Record<string, string> {
  return {
    [CSP_ENFORCING_HEADER]: CODE_ORIGIN_ENFORCING_CSP,
    [CSP_REPORT_ONLY_HEADER]: LOCAL_ONLY_CSP,
  };
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
