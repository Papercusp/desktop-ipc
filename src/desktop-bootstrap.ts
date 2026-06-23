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

import { isForceHttp } from './config';
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
    return u.origin === window.location.origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * True when an `ipcFetch` rejection means the IPC backend isn't there to
 * answer — as opposed to a genuine HTTP-level failure from the operator.
 *
 * `invoke_failed` is the code `ipc-stream.ts` emits when the Tauri
 * command itself couldn't run. The two ways that happens:
 *  - **dev mode** — `tauri dev` skips the sidecar spawn (the operator is
 *    served externally on :3055), so `endpoint_invoke`'s `IpcClient`
 *    state is never `.manage()`'d — the command errors with
 *    "state not managed".
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
      if (isSameOriginApiPath(input)) {
        // Try IPC; if the IPC backend isn't available (dev mode has no
        // sidecar; prod has a startup window before the handshake),
        // fall back to a direct HTTP fetch. ipcFetch only accepts
        // string bodies, so `init` is always safe to replay.
        return ipcFetch(input, init ?? {}).catch((err: unknown) => {
          if (isIpcUnavailable(err)) {
            return originalFetchBound(input as RequestInfo, init);
          }
          throw err;
        });
      }
    }
    return originalFetchBound(input as RequestInfo, init);
  };
  window.fetch = patchedFetch;

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
