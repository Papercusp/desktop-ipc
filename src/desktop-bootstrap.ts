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

import { isForceHttp, isRequireIpc } from './config';
import { IpcEventSource, setNativeEventSourceFallback, _resetIpcEventSourceFallback } from './ipc-event-source';
import { ipcFetch } from './ipc-fetch';

interface InstallHandle {
  uninstall: () => void;
}

let installed = false;

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
    // `/api/desktop/*` describes the operator SERVING THIS webview (its version,
    // env list, setup state, voice port, pipeline) — so it MUST hit the content
    // origin, NOT the IPC-owning operator the reroute targets. On the dev box the
    // IPC owner is often a DIFFERENT build (a sibling on another port) that may not
    // even serve these endpoints → 404, which silently HIDES the env-switcher bar
    // (it self-hides when /api/desktop/dev-operators returns no data). These are a
    // few small one-shot/30s polls, so native HTTP is cheap; the IPC reroute (the
    // libsoup SSE-socket-starvation fix) stays for the heavy shared /api traffic.
    // Holds in public release too: there's no reroute there, so native = the only
    // operator. See agent-insights/verifying-desktop-fixes-on-the-right-instance.
    if (u.pathname.startsWith('/api/desktop/')) return false;
    return u.pathname.startsWith('/api/');
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
export function isIpcUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('invoke_failed') ||
    msg.includes('state not managed') ||
    // WebKitGTK / WKWebView reject the `ipc://localhost/<cmd>` invoke fetch at the
    // WEBVIEW layer ("Fetch API cannot load ipc://… due to access control checks")
    // BEFORE it reaches Rust — so it never returns 'state not managed'. Same meaning:
    // IPC isn't usable → fall back to HTTP (dev skips the sidecar spawn; the operator is
    // reachable over HTTP). Any `ipc://` fetch failure ⇒ IPC-layer problem ⇒ fall back.
    msg.includes('access control') ||
    msg.includes('ipc://')
  );
}

export function installDesktopIpcPolyfills(): InstallHandle | null {
  if (typeof window === 'undefined') return null;
  if (installed) return null;
  if (!isTauri() || isForceHttp()) return null;

  // Hold both the original reference (for identity-preserving uninstall)
  // and a bound version (for internal use — Tauri webviews tend to keep
  // `this===window` invariant on host objects but `.bind` is cheap
  // insurance).
  const originalFetchRef = window.fetch;
  const originalFetchBound = originalFetchRef.bind(window);
  const OriginalEventSource = window.EventSource;

  // Patch fetch: same-origin /api/* → ipcFetch; everything else native.
  // Reject the Request-form input by falling through to native — Phase 1
  // ipcFetch wants a URL + init, and converting a Request faithfully
  // (especially with a streaming body) is more code than it's worth
  // until a real consumer needs it.
  const patchedFetch: typeof window.fetch = (input, init) => {
    if (typeof input === 'string' || input instanceof URL) {
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
      if (isSameOriginApiPath(input)) {
        // Try IPC; if the IPC backend isn't available (dev mode has no
        // sidecar; prod has a startup window before the handshake),
        // fall back to a direct HTTP fetch. ipcFetch only accepts
        // string bodies, so `init` is always safe to replay.
        return ipcFetch(input, init ?? {}).catch((err: unknown) => {
          if (isIpcUnavailable(err)) {
            // requireIpc (the DEFAULT): fail LOUD instead of silently replaying
            // over HTTP. The silent replay is why WI-6512 survived two months of
            // being "fixed" — the desktop kept working, just slowly, with no
            // signal that the transport had reverted. A visible error names the
            // real fault (the bridge) instead of presenting as mystery latency.
            if (isRequireIpc()) {
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
      }
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

  installed = true;

  return {
    uninstall: () => {
      window.fetch = originalFetchRef;
      if (consoleHost && originalWarn && consoleHost.warn === filteredWarn) {
        consoleHost.warn = originalWarn as typeof console.warn;
      }
      (window as unknown as { EventSource: typeof window.EventSource }).EventSource =
        OriginalEventSource;
      setNativeEventSourceFallback(undefined);
      installed = false;
    },
  };
}

/** Internal — tests reset module state. */
export function _resetForTests(): void {
  installed = false;
  _resetIpcEventSourceFallback();
}
