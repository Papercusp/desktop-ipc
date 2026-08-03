/**
 * XMLHttpRequest guard — the third transport door (no-http-anywhere P-010).
 *
 * `installDesktopIpcPolyfills` patches `fetch` and `EventSource`. It has never
 * patched `XMLHttpRequest`, so an XHR to `/api/*` inside the desktop shell goes
 * straight to the network stack — the exact egress D-005 forbids ("HTTP is a
 * loud failure, never a fallback").
 *
 * WHAT WAS MEASURED BEFORE WRITING THIS (2026-08-03), because the plan's own
 * rule is to re-measure a premise rather than inherit it (D-006/D-008/D-037/
 * D-038 were each refuted on contact):
 *
 *  - The premise HOLDS. In two live shells (`:3055` and `:3270`),
 *    `String(XMLHttpRequest.prototype.open)` is still native code while
 *    `window.fetch` is patched — XHR is genuinely unguarded.
 *  - But NOTHING currently reaches `/api` through it. Zero XHR call sites exist
 *    in our own source. Five bundle chunks reference `XMLHttpRequest`, all
 *    third-party and none able to target `/api`: two Emscripten loaders (sync
 *    GET for their own `.wasm`), Prism's `data-src` highlighter, vditor (its
 *    upload path is the only `/api`-shaped one and `upload` is not configured
 *    at our single `new Vditor(...)` call site, so it is unreachable), and
 *    posthog-js (whose `api_host` resolves to `https://flags.papercuspai.com`,
 *    a foreign origin — the OTHER axis, not this one).
 *  - Live confirmation, with its limit stated: both shells reported
 *    `initiatorType === 'xmlhttprequest'` COUNT ZERO. That zero is bounded —
 *    both buffers sat at exactly 250 entries, the resource-timing cap, so it
 *    covers the retained window rather than all history.
 *
 * So this file is P-010's second branch ("prove nothing reaches /api via XHR and
 * add a guard that throws if anything ever does"), not its first. Routing XHR
 * over IPC was rejected: it would build a whole XHR→IPC adapter for zero
 * consumers, and the static audit above is a SNAPSHOT that expires the next time
 * someone adds a dependency. A guard is the part that does not expire.
 *
 * WHY THIS REUSES `isRequireIpc()` INSTEAD OF ADDING A DEV-MODE FLAG. P-010 asks
 * for a "dev-mode guard", but a new knob would be both redundant and unreachable:
 *
 *  1. `requireIpc` ALREADY is this policy — "never silently fall back to the
 *     webview's HTTP transport", default ON. `ipcFetchWithFallback` throws under
 *     it. Giving XHR its own switch is exactly the drift `desktop-bootstrap.ts`
 *     guards against when it routes both `/api` branches through one helper "so
 *     the requireIpc rules cannot drift apart between them". One policy, three
 *     transports.
 *  2. A `process.env`-based dev flag could not work here anyway. In the shipped
 *     Vite bundle `process.env` is compiled to the literal `{}`, so every env
 *     lever in `config.ts` reads `undefined` — measured 2026-08-03 against
 *     `dist/assets/configure-*.js`, where `DESKTOP_IPC_FORCE_HTTP`,
 *     `DESKTOP_IPC_REQUIRE` and three siblings all appear as `{}.NAME`. A guard
 *     keyed to `NODE_ENV` would therefore be inert in precisely the webview it
 *     exists to protect.
 *
 * Net: the guard is armed wherever `requireIpc` is armed, and the existing
 * `forceHttp` lever disables it along with the rest of the polyfill block — the
 * documented rollback path, not a second one.
 *
 * WHY IT DOES NOT RECORD INTO THE EGRESS MONITOR. Tempting, and wrong in both
 * directions. When the guard THROWS, nothing reaches the network — recording it
 * would be a false positive in a signal that D-009 makes a release-gate-BLOCKING
 * invariant, and false reds are the expensive direction there. When the guard
 * only warns, the request does go out and resource timing records it by itself —
 * recording again would double-count. The monitor stays the single source of
 * truth for what actually escaped; this file only decides whether the call is
 * allowed to happen and names who made it.
 *
 * WHAT IT ADDS THAT RESOURCE TIMING CANNOT. Attribution and timing. A resource
 * entry says `/api/x` was fetched, never by whom; throwing at `.open()` puts the
 * offending call site on the stack. And an entry only appears once a request
 * COMPLETES, so an XHR that hangs is invisible to the monitor forever — this
 * sees it at open().
 */

import { isContentOriginScopedPath, isRequireIpc } from './config';

const API_PREFIX = '/api/';

/** Paths already reported, so a 30 s poll cannot turn a warning into a flood. */
const reported = new Set<string>();

/**
 * Classify one XHR target. Split out from the wrapper so the RULE is testable
 * without a DOM, an XMLHttpRequest, or a live shell — the same reason
 * `classifyEgress` is a pure function.
 *
 * `documentOrigin` is passed in rather than read from `window` so a test can
 * state the origin it means instead of mutating a global.
 */
export type XhrVerdict =
  /** Not ours to police — cross-origin, non-/api, or unparseable. */
  | { kind: 'pass' }
  /** Same-origin /api, but bound to the content origin: a DECLARED HTTP route. */
  | { kind: 'declared-exemption'; path: string }
  /** Same-origin /api with no sanctioned HTTP route. This is the violation. */
  | { kind: 'violation'; path: string };

export function classifyXhrTarget(url: string | URL, documentOrigin: string): XhrVerdict {
  let u: URL;
  try {
    u = new URL(typeof url === 'string' ? url : url.toString(), documentOrigin);
  } catch {
    // An unparseable target cannot be shown to be ours, and a guard that throws
    // on garbage input is an outage rather than a tripwire.
    return { kind: 'pass' };
  }
  if (u.origin !== documentOrigin) return { kind: 'pass' };
  if (!u.pathname.startsWith(API_PREFIX)) return { kind: 'pass' };

  // Mirrors the fetch path's content-origin carve-out (D-008): these describe the
  // operator that SERVED this document, and when the IPC bridge belongs to a
  // different operator they are sanctioned to stay on HTTP.
  //
  // Deliberately permissive, and the reason is a boundary rather than a policy:
  // fetch decides this by AWAITING `resolveIpcOwnerIsContentOrigin()`, but
  // `XMLHttpRequest.open` is synchronous and cannot await anything. Rather than
  // guess the async answer, the guard declines to throw on the whole prefix and
  // says so out loud. The prefix is one line in `DEFAULT_CONTENT_ORIGIN_API_PREFIXES`,
  // not an open-ended hole, and the egress monitor still counts whatever actually
  // leaves.
  if (isContentOriginScopedPath(u.pathname)) {
    return { kind: 'declared-exemption', path: u.pathname };
  }
  return { kind: 'violation', path: u.pathname };
}

export interface XhrGuardOptions {
  /** Defaults to `window.location.origin`. */
  documentOrigin?: string;
  /**
   * Override the throw/warn decision. Defaults to {@link isRequireIpc} — see the
   * header for why this is not its own dev-mode flag.
   */
  strict?: () => boolean;
}

/** Restores the original `open`, or null when there was nothing to wrap. */
export type XhrGuardHandle = { uninstall: () => void } | null;

/**
 * Wrap `XMLHttpRequest.prototype.open` so a same-origin `/api` call is refused
 * (strict) or named (non-strict) instead of quietly reaching the network.
 *
 * Idempotent per module: a second install returns the existing handle rather
 * than nesting a second wrapper.
 */
let installedHandle: XhrGuardHandle = null;

export function installXhrGuard(opts: XhrGuardOptions = {}): XhrGuardHandle {
  if (installedHandle) return installedHandle;
  if (typeof window === 'undefined') return null;
  const XHR = (window as unknown as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
  if (typeof XHR !== 'function' || typeof XHR.prototype?.open !== 'function') return null;

  const originalOpen = XHR.prototype.open;
  const strict = opts.strict ?? isRequireIpc;

  function guardedOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    // Resolve the origin at CALL time, not install time: the guard installs during
    // boot and `window.location` is the authority on where the document actually
    // came from (dev serves http://127.0.0.1:3055, the packaged shell a custom
    // scheme). Reading it once at install would pin a stale answer.
    const origin = opts.documentOrigin ?? window.location?.origin ?? '';
    let verdict: XhrVerdict;
    try {
      verdict = classifyXhrTarget(url, origin);
    } catch {
      // Classification must never be what breaks a request.
      verdict = { kind: 'pass' };
    }

    if (verdict.kind === 'violation') {
      const host = typeof globalThis !== 'undefined' ? globalThis.console : undefined;
      if (strict()) {
        // Thrown from `.open()`, BEFORE `.send()`, so nothing reaches the network
        // and the caller is on the stack. This mirrors `ipcFetch`'s rejection
        // under requireIpc rather than inventing a second failure mode.
        throw new Error(
          `desktop-ipc: XMLHttpRequest to ${verdict.path} is refused — inside the desktop ` +
            `shell every /api call must travel over IPC, and XHR has no IPC route (only ` +
            `fetch and EventSource are patched). Use fetch(), which is routed for you. ` +
            `Set DESKTOP_IPC_FORCE_HTTP=1 (or configureDesktopIpc({ requireIpc: false })) ` +
            `to roll the whole no-HTTP policy back.`,
        );
      }
      if (!reported.has(verdict.path)) {
        reported.add(verdict.path);
        host?.error?.(
          `[desktop-ipc] XHR EGRESS: ${verdict.path} is being requested over ` +
            `XMLHttpRequest, which is not routed over IPC — this call is leaving over the ` +
            `network stack. Use fetch() instead; it is patched to ride the bridge.`,
        );
      }
    } else if (verdict.kind === 'declared-exemption' && !reported.has(verdict.path)) {
      reported.add(verdict.path);
      const host = typeof globalThis !== 'undefined' ? globalThis.console : undefined;
      host?.warn?.(
        `[desktop-ipc] DECLARED HTTP EXEMPTION (xhr): ${verdict.path} is content-origin ` +
          `scoped, so it stays on the native transport. Unlike the fetch path this is not ` +
          `conditional on the bridge's owner — XMLHttpRequest.open is synchronous and ` +
          `cannot await that resolution.`,
      );
    }

    return (originalOpen as unknown as (...a: unknown[]) => unknown).call(
      this,
      method,
      url,
      ...rest,
    );
  }

  XHR.prototype.open = guardedOpen as typeof XHR.prototype.open;

  installedHandle = {
    uninstall: () => {
      // Only restore when nobody wrapped on top of us — clobbering a later
      // wrapper is worse than leaving ours in place (same rule as
      // `wrapConstructor` in egress-monitor.ts).
      if (XHR.prototype.open === guardedOpen) XHR.prototype.open = originalOpen;
      installedHandle = null;
    },
  };
  return installedHandle;
}

/** Test-only: drop module state so each test starts from a clean global. */
export function _resetXhrGuardForTests(): void {
  installedHandle?.uninstall();
  installedHandle = null;
  reported.clear();
}
