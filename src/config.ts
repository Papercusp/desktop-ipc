/**
 * Host seam for `@papercusp/desktop-ipc`.
 *
 * The transport picker (`index.ts`) and the polyfill installer
 * (`desktop-bootstrap.ts`) both honor a "force HTTP" rollback escape
 * hatch — a way to flip every IPC call back to HTTP without shipping a
 * new Rust binary. To keep this package free of any consuming-app
 * branding, the host decides how that flag is resolved:
 *
 *   import { configureDesktopIpc } from '@papercusp/desktop-ipc';
 *   configureDesktopIpc({
 *     forceHttp: () => myEnv.FORCE_HTTP === '1',
 *   });
 *
 * When left unconfigured, it falls back to the generic, unbranded
 * `DESKTOP_IPC_FORCE_HTTP` (or `NEXT_PUBLIC_DESKTOP_IPC_FORCE_HTTP`) env
 * var, so a no-wiring escape hatch still exists for plain consumers.
 */
export interface DesktopIpcConfig {
  /**
   * Force the HTTP transport even on Tauri. Pass a boolean, or a lazy
   * resolver evaluated on each check (so build-time env inlining in the
   * host bundler still works).
   */
  forceHttp?: boolean | (() => boolean);

  /**
   * Require IPC: NEVER silently fall back to the webview's HTTP transport.
   * **Defaults to `true`** — the silent fallback is a footgun, not a safety net.
   *
   * ⚠ The fallback it disables was the single highest-cost defect this package
   * has produced, because failing SILENTLY made it invisible for two months.
   * Observed live 2026-07-28 (WI-6512, owner-reported): the operator was
   * LISTENING on its IPC socket with **zero** connections to it, while the
   * webview held 6 TCP connections carrying 5 long-lived SSE streams — i.e. the
   * fix was installed, connected to nothing, and had reverted to the exact
   * libsoup 6-socket exhaustion it exists to prevent, with no signal anywhere.
   * The owner's symptom was "clicking an agent takes several seconds".
   *
   * With `requireIpc` on:
   *  - **Streams** never construct a native EventSource. An unavailable bridge
   *    stays RETRYABLE forever (the `ipc-wait` path), so a stream waits for the
   *    bridge instead of burning one of ~6 per-host sockets for the session.
   *    This is strictly better than falling back: the stream connects the moment
   *    the bridge is up, and boot is unaffected.
   *  - **Fetch** rejects loudly with a named error instead of replaying the
   *    request over HTTP, so a broken bridge surfaces as a visible failure
   *    rather than a slow, mysterious degradation.
   *
   * `forceHttp` still overrides this — it stays the deliberate rollback lever.
   */
  requireIpc?: boolean | (() => boolean);

  /**
   * How long (ms) IPC streaming stays latched as "unavailable" — routing new
   * EventSources straight to the native ctor — after an invoke proves the
   * backend isn't answering. When the window expires the next construction
   * re-probes IPC once; a fresh failure re-latches for another window, and a
   * successful connect clears it immediately.
   *
   * This is a COOLDOWN rather than a permanent session flag on purpose: every
   * condition that sets it is transient (the prod pre-handshake startup window,
   * a momentarily stale dev socket advertisement), so a one-way latch stranded
   * every SSE consumer on native HTTP for the life of the webview (WI-6255).
   * Lower = faster recovery, more doomed invokes while genuinely down.
   * Default {@link DEFAULT_IPC_STREAM_FALLBACK_COOLDOWN_MS}.
   */
  ipcStreamFallbackCooldownMs?: number;

  /**
   * Startup grace (ms, from a stream's construction) during which "the IPC
   * bridge isn't up YET" is treated as a RETRYABLE condition rather than a
   * dead backend. Inside the window the stream stays CONNECTING and retries;
   * only after it expires does the stream latch + fall back to native HTTP.
   *
   * This is what keeps boot streams OFF native HTTP. The fallback's benefit is
   * transient (it only covers the window where the operator serves HTTP but the
   * IPC bridge hasn't connected) while its cost is permanent: a long-lived SSE
   * connection holds one of WebKitGTK/libsoup's ~6 per-host sockets for the
   * whole session. Waiting a beat is the better trade for a stream that will
   * live for hours; it is NOT the better trade for a one-shot fetch, which is
   * why `ipcFetch` still falls back per call. Default
   * {@link DEFAULT_IPC_STARTUP_GRACE_MS}.
   */
  ipcStartupGraceMs?: number;

  /**
   * Retry interval (ms) between IPC attempts INSIDE the startup grace. Shorter
   * than the post-open reconnect backoff so several attempts fit in the window.
   * Default {@link DEFAULT_IPC_STARTUP_RETRY_MS}.
   */
  ipcStartupRetryMs?: number;
}

/**
 * Default startup grace before a stream gives up on IPC and falls back.
 *
 * ⚠ Deliberately conservative. A comment in `ipc-event-source.ts` long claimed a
 * consumer open-watchdog ("DesktopAttentionNotifier") fires at ~4s, which would
 * cap this — but that component does NOT exist anywhere in the tree (checked
 * 2026-07-27), so the figure is UNVERIFIED and must not be treated as a
 * measured constraint. Kept under it anyway, and made configurable, so a host
 * that measures a real watchdog can tune rather than patch. If you confirm the
 * true bound, record it here with the evidence.
 */
export const DEFAULT_IPC_STARTUP_GRACE_MS = 3_000;

/** Default retry interval inside the startup grace. */
export const DEFAULT_IPC_STARTUP_RETRY_MS = 400;

/** Default cooldown before a latched IPC streaming backend is re-probed. */
export const DEFAULT_IPC_STREAM_FALLBACK_COOLDOWN_MS = 5_000;

let cfg: DesktopIpcConfig = {};

/** Install host configuration. Merges over any previous call. */
export function configureDesktopIpc(config: DesktopIpcConfig): void {
  cfg = { ...cfg, ...config };
}

/**
 * Resolve the IPC-stream fallback cooldown. Host config first; a non-finite or
 * negative value falls back to the default rather than disabling the re-probe.
 * `0` is honored (re-probe on every construction) — useful in tests.
 */
export function getIpcStreamFallbackCooldownMs(): number {
  const v = cfg.ipcStreamFallbackCooldownMs;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? v
    : DEFAULT_IPC_STREAM_FALLBACK_COOLDOWN_MS;
}

/** Resolve the startup grace during which IPC-unavailable is retryable, not fatal. */
export function getIpcStartupGraceMs(): number {
  const v = cfg.ipcStartupGraceMs;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? v
    : DEFAULT_IPC_STARTUP_GRACE_MS;
}

/** Resolve the retry interval used inside the startup grace. */
export function getIpcStartupRetryMs(): number {
  const v = cfg.ipcStartupRetryMs;
  return typeof v === 'number' && Number.isFinite(v) && v > 0
    ? v
    : DEFAULT_IPC_STARTUP_RETRY_MS;
}

/**
 * Resolve whether IPC is REQUIRED (no silent HTTP fallback). Defaults to `true`.
 *
 * `forceHttp` wins: an operator who has deliberately pulled the rollback lever
 * wants HTTP, and a require-IPC assertion on top of that would just break the
 * escape hatch. Env opt-out (`DESKTOP_IPC_REQUIRE=0`) exists for the same
 * no-wiring reason `DESKTOP_IPC_FORCE_HTTP` does.
 */
export function isRequireIpc(): boolean {
  if (isForceHttp()) return false;
  const r = cfg.requireIpc;
  if (r !== undefined) return typeof r === 'function' ? Boolean(r()) : Boolean(r);
  if (typeof process !== 'undefined') {
    const v = process.env?.DESKTOP_IPC_REQUIRE ?? process.env?.NEXT_PUBLIC_DESKTOP_IPC_REQUIRE;
    if (v === '0' || v === 'false') return false;
  }
  return true;
}

/** Resolve the force-HTTP escape hatch: host config first, generic env fallback otherwise. */
export function isForceHttp(): boolean {
  const f = cfg.forceHttp;
  if (f !== undefined) return typeof f === 'function' ? Boolean(f()) : Boolean(f);
  if (typeof process !== 'undefined') {
    const v = process.env?.DESKTOP_IPC_FORCE_HTTP ?? process.env?.NEXT_PUBLIC_DESKTOP_IPC_FORCE_HTTP;
    return v === '1' || v === 'true';
  }
  return false;
}
