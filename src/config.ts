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
}

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
