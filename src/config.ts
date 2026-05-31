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
}

let cfg: DesktopIpcConfig = {};

/** Install host configuration. Merges over any previous call. */
export function configureDesktopIpc(config: DesktopIpcConfig): void {
  cfg = { ...cfg, ...config };
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
