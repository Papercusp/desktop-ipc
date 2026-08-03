/**
 * `installDesktopIpcPolyfills` — Tauri-only install of `IpcEventSource`
 * (as `window.EventSource`) and an `ipcFetch` wrapper (as `window.fetch`
 * for same-origin /api/* requests).
 *
 * After install, every existing consumer that does
 * `new EventSource('/api/...')` or `fetch('/api/...')` — including
 * `createResilientEventSource`, which reads `globalThis.EventSource` —
 * transparently rides the IPC bridge instead of opening a webview HTTP
 * connection. That removes the webview's HTTP-pool-per-host pressure
 * entirely (the connection-pool bug that hangs the live agent-thinking
 * popover on the harness page).
 *
 * Scope:
 *  - Only runs in the Tauri webview (`__TAURI_INTERNALS__.invoke` present).
 *  - Skipped when the host's force-HTTP escape hatch is set (see
 *    `configureDesktopIpc` / `DESKTOP_IPC_FORCE_HTTP`) — same kill-switch
 *    the tool transport picker honors.
 *  - `fetch` wrapper: same-origin /api/* → ipcFetch; everything else
 *    (cross-origin PostHog/LLM/asset traffic, same-origin non-/api/*)
 *    falls through to the native fetch unchanged.
 *  - `EventSource` install is unconditional once we decide to install
 *    at all. Current consumers are all same-origin /api/*; a future
 *    cross-origin EventSource consumer would surface a `bad_path` error
 *    from the bridge and we'd add a routing wrapper at that point.
 *  - Idempotent: a second call returns null without re-patching.
 */

import {
  _resetContentOriginCacheForTests,
  isContentOriginScopedPath,
  isForceHttp,
  isRequireIpc,
  resolveIpcOwnerIsContentOrigin,
} from './config';
import { installEgressMonitor, _resetEgressMonitorForTests } from './egress-monitor';
import { isIpcNotWired, isIpcUnavailable } from './ipc-availability';
import { IpcEventSource, setNativeEventSourceFallback, _resetIpcEventSourceFallback } from './ipc-event-source';
import { ipcFetch } from './ipc-fetch';
import { installXhrGuard, _resetXhrGuardForTests } from './xhr-guard';

interface InstallHandle {
  uninstall: () => void;
}

let installed = false;

/** Paths already reported as running on the declared HTTP exemption. */
const reportedExemptions = new Set<string>();

/**
 * Announce, ONCE per path, that a request is taking the one remaining native-HTTP
 * route inside the shell.
 *
 * D-005 rules that HTTP from the webview is a loud failure and never a silent
 * fallback — the silence is the whole reason WI-6512 survived two months. But
 * these callers poll every 30 s, so an unconditional log would emit thousands of
 * identical lines and become its own kind of silence. Deduping by path keeps the
 * signal readable while still naming every escaping endpoint exactly once.
 *
 * `warn`, not `error`: unlike an unexplained egress this route is DECLARED and
 * its cause is known (the IPC bridge belongs to a different operator than the one
 * serving this document), so it is a diagnosable condition rather than a defect
 * in the transport. A genuine unexplained escape is still logged as an error by
 * the egress monitor below.
 */
function reportDeclaredHttpExemption(url: string): void {
  let pathname = url;
  try {
    pathname = new URL(url, window.location.origin).pathname;
  } catch {
    /* keep the raw string — a malformed URL is still worth naming once */
  }
  if (reportedExemptions.has(pathname)) return;
  reportedExemptions.add(pathname);
  // `window.console` first, matching the console this module already patches for
  // the Tauri warn-filter. The two are the same object in a webview, but not in
  // a non-DOM host — and reporting through a different console than the one the
  // shell observes is how an "it logs loudly" claim quietly becomes untrue.
  const host =
    (window as unknown as { console?: Console }).console ??
    (typeof globalThis !== 'undefined' ? globalThis.console : undefined);
  host?.warn?.(
    `[desktop-ipc] DECLARED HTTP EXEMPTION: ${pathname} is staying on the native ` +
      `transport because the IPC bridge's owner is NOT the operator that served this ` +
      `document, and this path describes the serving operator. This is the only ` +
      `sanctioned HTTP route in the shell; every other /api call must ride IPC.`,
  );
}

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__
      ?.invoke,
  );
}

function isSameOriginApiPath(url: string | URL): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const u = new URL(typeof url === 'string' ? url : url.toString(), window.location.origin);
    if (u.origin !== window.location.origin) return false;
    return u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * True when this same-origin /api path is bound to the operator that SERVED this
 * document rather than to whichever operator owns the IPC bridge.
 *
 * This used to be an unconditional `return false` for the whole `/api/desktop/*`
 * prefix inside {@link isSameOriginApiPath} — a permanent, undeclared HTTP
 * carve-out on every platform. D-008 measured what that cost: it is the ENTIRE
 * reason webview HTTP egress is nonzero. The escapes recur on the 30 s poll tick
 * ~30 s after the polyfill installs (t=31029/31040/31714 ms, with `window.fetch`
 * confirmed patched), so they were never the startup race P-011 blamed — earlier
 * installation would not have stopped one of them.
 *
 * The underlying concern was real: these endpoints describe the serving operator,
 * and on a dev box the IPC bridge may target a different build where they 404 and
 * silently hide the env-switcher bar. So the prefix is no longer excluded — it is
 * routed on a DECLARED capability the Rust resolver already computes
 * (`SocketResolution::owner_is_content_origin`), satisfying D-005's requirement
 * that any surviving HTTP path be explicit rather than inferred.
 */
function isContentOriginScopedApiPath(url: string | URL): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const u = new URL(typeof url === 'string' ? url : url.toString(), window.location.origin);
    return isContentOriginScopedPath(u.pathname);
  } catch {
    return false;
  }
}

/**
 * True when an `ipcFetch` rejection means the IPC backend isn't there to
 * answer — as opposed to a genuine HTTP-level failure from the operator.
 *
 * `invoke_failed` is the code `ipc-stream.ts` emits when the Tauri
 * command itself couldn't run. The ways that happens:
 *  - **dev mode, operator down or not yet advertising** — `tauri dev` skips
 *    the SIDECAR spawn, but it does NOT leave dev without IPC: main.rs
 *    (`#[cfg(debug_assertions)]`) still `.manage()`s a *reconnecting*
 *    `IpcClientHandle` whose socket source re-reads
 *    `~/.papercusp/endpoint-ipc.<selected-port>.json` on every (re)connect,
 *    precisely so dev `/api` fetch + EventSource ride IPC and escape
 *    libsoup's 6-socket pool. So in dev this branch means the ADVERTISEMENT
 *    is missing/stale (no file for the selected port, dead pid, or vanished
 *    socket) — not "dev has no IPC". Check that file before concluding the
 *    transport is unavailable.
 *    ⚠ Do NOT restore the older claim that dev "never `.manage()`s an
 *    IpcClient / errors with 'state not managed'" — that predates the
 *    reconnecting dev handle and sent at least one investigation (2026-07-26)
 *    down the wrong path.
 *  - **prod startup window** — between webview mount and the sidecar's
 *    `PAPERCUSP_IPC_READY` handshake (up to 30s), the client isn't
 *    connected yet.
 *
 * In both cases the right move is exactly what main.rs's handshake
 * comment says: fall back to HTTP. `upstream_error` / `aborted` / etc.
 * mean IPC *did* run, so those are real and must NOT be retried.
 */
export { isIpcUnavailable, isIpcNotWired, isIpcNotReady } from './ipc-availability';

export function installDesktopIpcPolyfills(): InstallHandle | null {
  if (typeof window === 'undefined') return null;

  // P-003(a): the egress detector installs BEFORE every remaining guard, and that
  // ordering is the whole point.
  //
  // It used to sit further down, after the `!isTauri() || isForceHttp()` return —
  // i.e. INSIDE the branch it exists to audit. That meant the one configuration
  // where HTTP egress is guaranteed (the shell fell back to HTTP, or the rollback
  // lever was pulled) was also the one configuration where the detector was
  // guaranteed ABSENT. The packaged perf suite caught it on its first real run:
  // `webview-http-egress = -1` (detector absent) rather than a count, from a shell
  // that was in fact talking HTTP the entire time.
  //
  // A detector that goes quiet exactly when the fault is present is worse than no
  // detector, because "-1/unknown" and "0/clean" are one careless `>= 0` apart.
  // Nothing here depends on the IPC path: it is a passive PerformanceObserver over
  // resource timings, so it is installable — and meaningful — in every shell.
  //
  // `buffered: true` still replays entries recorded before this call (that is what
  // catches the known t=480-783ms offenders), so moving the install EARLIER only
  // widens what it can see; it can never narrow it. `installEgressMonitor` is
  // idempotent (`if (active) return active`), so the re-entry paths below are safe.
  const expectsIpc = isTauri() && !isForceHttp();
  const egress = installEgressMonitor({
    onEgress: (e) => {
      const host = typeof globalThis !== 'undefined' ? globalThis.console : undefined;

      // The DESTINATION axis is loud in EVERY shell, and deliberately does not
      // inherit the expectsIpc suppression below. That suppression is correct
      // for the transport axis — HTTP genuinely is the sanctioned transport in a
      // browser — but there is no shell in which fetching from a host we do not
      // own is fine. Scoping this one to the desktop would have hidden all six
      // public-CDN fetches found in cdn-egress-fixes-2026-08-02 from anyone
      // running in a browser, which is where most of them were first reachable.
      if (e.axis === 'foreign-origin') {
        host?.error?.(
          `[desktop-ipc] FOREIGN-ORIGIN EGRESS: ${e.url} at ` +
            `t=${Math.round(e.startMs)}ms. Nothing may be fetched from a host we do not ` +
            `own — this is almost always a third-party library's baked-in CDN default ` +
            `(see cdn-egress-fixes-2026-08-02 for the six already fixed, and the local ` +
            `runtime mirrors under apps/operator/public that replaced them).`,
        );
        return;
      }

      // Loudness is scoped to shells that were SUPPOSED to use IPC. In a browser
      // (or under the deliberate forceHttp rollback) HTTP is the sanctioned
      // transport, so an error per request would be noise — but the report is
      // still recorded, so the invariant can always be READ.
      if (!expectsIpc) return;
      host?.error?.(
        `[desktop-ipc] HTTP EGRESS: ${e.path} went over the network stack at ` +
          `t=${Math.round(e.startMs)}ms (${Math.round(e.durationMs)}ms). Inside the desktop ` +
          `shell every /api call must travel over IPC — this one did not.`,
      );
    },
  });

  if (installed) return null;
  if (!expectsIpc) return null;

  // Hold both the original reference (for identity-preserving uninstall)
  // and a bound version (for internal use — Tauri webviews tend to keep
  // `this===window` invariant on host objects but `.bind` is cheap
  // insurance).
  const originalFetchRef = window.fetch;
  const originalFetchBound = originalFetchRef.bind(window);
  const OriginalEventSource = window.EventSource;

  /**
   * Route one same-origin /api request over IPC, falling back to the native
   * transport only when the bridge itself is unavailable.
   *
   * Shared by both /api branches so the requireIpc rules cannot drift apart
   * between them — a content-origin-scoped call that reaches IPC must fail as
   * loudly as any other, per D-005.
   */
  const ipcFetchWithFallback = (input: string | URL, init?: RequestInit): Promise<Response> =>
    ipcFetch(input, init ?? {}).catch((err: unknown) => {
      if (isIpcUnavailable(err)) {
        // requireIpc (the DEFAULT): fail LOUD instead of silently replaying
        // over HTTP. The silent replay is why WI-6512 survived two months of
        // being "fixed" — the desktop kept working, just slowly, with no
        // signal that the transport had reverted. A visible error names the
        // real fault (the bridge) instead of presenting as mystery latency.
        // Not-wired (PAPERCUSP_DESKTOP_IPC=0, no IPC in this build, a
        // webview refusing ipc://) is the operator deliberately choosing
        // HTTP — same meaning as forceHttp, so honour it rather than
        // erroring every /api call for the life of the process.
        if (isRequireIpc() && !isIpcNotWired(err)) {
          const host = typeof globalThis !== 'undefined' ? globalThis.console : undefined;
          host?.error?.(
            `[desktop-ipc] IPC bridge unavailable for ${String(input)} — refusing the ` +
              `HTTP fallback (requireIpc). Check that the operator's endpoint-ipc socket ` +
              `exists AND has connections; set DESKTOP_IPC_FORCE_HTTP=1 to roll back.`,
          );
          throw new Error(
            `desktop-ipc: IPC bridge unavailable and HTTP fallback is disabled (requireIpc). ` +
              `Underlying: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return originalFetchBound(input as RequestInfo, init);
      }
      throw err;
    });

  /**
   * Convert a Request into the `(url, init)` pair {@link ipcFetch} takes.
   *
   * WI-6618 (plan no-http-anywhere-2026-07-28 P-009). `ipcFetch` rejects a
   * non-string body outright, so the body is read via `.text()` — which buffers
   * a stream body too, closing the "especially with a streaming body" gap that
   * kept the Request form on HTTP. The Request is CLONED first so a caller
   * holding its own reference can still read the body afterwards.
   *
   * `mode` is deliberately NOT copied: a navigated Request reports
   * `mode: 'navigate'`, which is invalid in a RequestInit and would throw. It
   * carries no meaning over IPC, where there is no CORS to negotiate.
   */
  const initFromRequest = async (req: Request): Promise<RequestInit> => {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const init: RequestInit = {
      method: req.method,
      headers,
      credentials: req.credentials,
      cache: req.cache,
      redirect: req.redirect,
      integrity: req.integrity,
      referrer: req.referrer,
      signal: req.signal,
    };
    // GET/HEAD cannot carry one, and `.text()` on a bodyless Request is just ''.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = await req.clone().text();
    }
    return init;
  };

  // Patch fetch: same-origin /api/* → ipcFetch; everything else native.
  // Returns null when this input is not ours to route (the caller then goes
  // native), so the Request form below can reuse the EXACT same rules rather
  // than growing a second copy that drifts.
  const routeUrlForm = (input: string | URL, init?: RequestInit): Promise<Response> | null => {
    // ipc-cors-2026-06-24: Tauri's IPC init script tries the `ipc://localhost/<cmd>`
      // custom-protocol fetch FIRST on non-Android. On Linux/WebKitGTK, when the frontend is
      // served from a REMOTE origin (Papercusp loads the operator over http://127.0.0.1:<port>,
      // not the bundled tauri:// asset protocol), wry registers custom schemes secure-only — never
      // CORS-enabled — so WebKitGTK floods the console with "Fetch API cannot load
      // ipc://localhost/<cmd> due to access control checks" on every invoke. Reject the ipc://
      // fetch HERE, before the native fetch is ever issued, so the engine never evaluates (and
      // never logs) it. Tauri's init script catches this and transparently retries the invoke over
      // its postMessage transport — the path that already carries every IPC call on this platform
      // (the custom-protocol path was never usable here). Net: identical behavior, zero console
      // noise. The matching `IPC custom protocol failed …` warn is filtered below.
      const urlStr = typeof input === 'string' ? input : input.toString();
      if (urlStr.startsWith('ipc://')) {
        return Promise.reject(
          new DOMException(
            'papercusp: ipc custom-protocol fetch disabled on remote-origin WebKitGTK — using postMessage',
            'NotAllowedError',
          ),
        );
      }
      if (isSameOriginApiPath(input) && isContentOriginScopedApiPath(input)) {
        // Content-origin-scoped: ride IPC only when the bridge's owner is PROVABLY
        // the operator that served this document. Awaiting rather than reading a
        // cached-or-default flag is deliberate — a synchronous check would answer
        // "unknown" for the whole startup window, which is exactly when the
        // first-paint burst of these calls happens, so the carve-out would survive
        // in miniature for the requests that matter most. The resolution is one
        // filesystem-backed invoke, cached for the session, shared by all callers.
        return resolveIpcOwnerIsContentOrigin().then((sameOperator) => {
          if (!sameOperator) {
            reportDeclaredHttpExemption(String(input));
            return originalFetchBound(input as RequestInfo, init);
          }
          return ipcFetchWithFallback(input, init);
        });
      }
      if (isSameOriginApiPath(input)) {
        // Try IPC; if the IPC backend isn't available (dev mode has no
        // sidecar; prod has a startup window before the handshake),
        // fall back to a direct HTTP fetch. ipcFetch only accepts
        // string bodies, so `init` is always safe to replay.
        return ipcFetchWithFallback(input, init);
    }
    return null;
  };

  const patchedFetch: typeof window.fetch = (input, init) => {
    if (typeof input === 'string' || input instanceof URL) {
      return routeUrlForm(input, init) ?? originalFetchBound(input as RequestInfo, init);
    }
    // WI-6618 (P-009): the Request form used to fall straight through to the
    // native transport here, which is SILENT HTTP EGRESS from the webview —
    // exactly what D-005 forbids ("HTTP is a loud failure, never a fallback").
    // It is invisible precisely because it works: the request succeeds, just
    // over the transport the plan exists to eliminate.
    if (typeof Request !== 'undefined' && input instanceof Request) {
      // Decide OURS-vs-NOT from the Request's own url first, before any
      // conversion can fail — otherwise a conversion failure is indistinguishable
      // from "not ours" and silently becomes HTTP, which is the very bug.
      const rawUrl = typeof input.url === 'string' ? input.url : '';
      if (!rawUrl || !isSameOriginApiPath(rawUrl)) {
        return originalFetchBound(input as RequestInfo, init);
      }
      // Let the PLATFORM do the spec-correct (request, init) merge — init
      // overrides the Request's own fields — instead of hand-merging two
      // shapes and getting the precedence subtly wrong.
      let merged: Request;
      try {
        merged = new Request(input, init);
      } catch (err) {
        // D-005: this IS a same-origin /api call, so it may not quietly revert
        // to the transport this plan exists to eliminate. A Request we cannot
        // re-read (a already-consumed body being the realistic case) is a caller
        // bug — surface it loudly rather than hiding it behind working HTTP.
        return Promise.reject(
          new Error(
            `desktop-ipc: cannot route the Request-form fetch for ${rawUrl} over IPC ` +
              `(the Request could not be cloned — an already-consumed body?), and the ` +
              `HTTP fallback is disabled for same-origin /api calls (D-005). ` +
              `Underlying: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
      return initFromRequest(merged).then((converted) => {
        const routed = routeUrlForm(merged.url, converted);
        // isSameOriginApiPath already matched, so routeUrlForm routes it; the
        // fallback is only for the ipc:// / non-/api shapes it can still decline.
        return routed ?? originalFetchBound(input as RequestInfo, init);
      });
    }
    return originalFetchBound(input as RequestInfo, init);
  };
  window.fetch = patchedFetch;

  // ipc-cors-2026-06-24: silence Tauri's own one-per-load warn that fires when our patchedFetch
  // rejects the ipc:// custom-protocol attempt above (`console.warn('IPC custom protocol failed,
  // Tauri will now use the postMessage interface instead', …)`). On this platform the postMessage
  // fallback is the intended, working path — the warn is pure noise. Scoped to that exact message
  // so every other warning passes through untouched. Guarded: `window.console` is always present
  // in a webview but may be absent in non-DOM hosts (tests/SSR).
  const consoleHost = (window as unknown as { console?: Console }).console;
  const originalWarn = consoleHost?.warn?.bind(consoleHost);
  const filteredWarn: ((...args: unknown[]) => void) | undefined = originalWarn
    ? (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].includes('IPC custom protocol failed')) return;
        originalWarn(...args);
      }
    : undefined;
  if (consoleHost && filteredWarn) consoleHost.warn = filteredWarn as typeof console.warn;

  // Patch EventSource. IpcEventSource implements the same interface; a
  // future cross-origin EventSource would surface `bad_path` from the
  // bridge — fix-forward when that consumer appears.
  //
  // Hand IpcEventSource the native ctor first: when IPC streaming is
  // unavailable (dev mode / prod-startup window / unwired backend) it falls
  // back to a native EventSource, mirroring ipcFetch's HTTP fallback above.
  setNativeEventSourceFallback(OriginalEventSource);
  (window as unknown as { EventSource: typeof window.EventSource }).EventSource =
    IpcEventSource as unknown as typeof window.EventSource;

  // P-010: the THIRD transport door. fetch and EventSource are routed above;
  // XMLHttpRequest has no IPC route at all, so the guard refuses a same-origin
  // /api call rather than letting it reach the network stack unannounced. It
  // installs INSIDE the expectsIpc block on purpose — in a browser, or under the
  // forceHttp rollback, HTTP is the sanctioned transport and there is nothing to
  // police. See xhr-guard.ts for what was measured before it was written.
  const xhrGuard = installXhrGuard();

  installed = true;

  return {
    uninstall: () => {
      // FIRST, by the same LIFO rule the egress note below states: this wrapper
      // was installed last, so it unwinds first.
      xhrGuard?.uninstall();
      window.fetch = originalFetchRef;
      if (consoleHost && originalWarn && consoleHost.warn === filteredWarn) {
        consoleHost.warn = originalWarn as typeof console.warn;
      }
      (window as unknown as { EventSource: typeof window.EventSource }).EventSource =
        OriginalEventSource;
      setNativeEventSourceFallback(undefined);
      // LAST, and that ordering is load-bearing. The egress monitor wraps
      // `EventSource` BEFORE this function captured `OriginalEventSource`, so
      // `OriginalEventSource` IS the monitor's wrapper — the two patches are
      // nested, and nested patches must unwind in LIFO order. Stopping the
      // monitor first left its wrapper reinstated by the line above and the
      // true native ctor stranded behind a detached recorder.
      egress?.stop();
      installed = false;
    },
  };
}

/**
 * Internal — tests reset module state.
 *
 * The egress monitor MUST be reset here too. `installEgressMonitor` is idempotent
 * via a module-level `active` handle, and `PerformanceObserver` is a real global in
 * Node — so without this line the first test to run captures the monitor and every
 * later test's freshly-built `window` never receives `__papercusp_egress__`, since
 * the installer returns the stale handle before it can attach. That reads as "the
 * detector does not install", which is indistinguishable from the wiring bug these
 * tests exist to catch. A reset that clears only part of a module's state is a trap
 * for whoever writes the next test.
 */
export function _resetForTests(): void {
  installed = false;
  reportedExemptions.clear();
  _resetContentOriginCacheForTests();
  _resetIpcEventSourceFallback();
  _resetEgressMonitorForTests();
  // Same reason as the egress reset above: the guard holds module-level state
  // (the installed handle and the reported-path set), so a partial reset leaves
  // the next test running against the previous test's globals.
  _resetXhrGuardForTests();
}
