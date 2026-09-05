/**
 * Transport picker. Default consumer entry-point for endpoint-stream
 * tools — picks IPC on Tauri, HTTP elsewhere. Env override flips
 * everything back to HTTP without rebuilding the Rust side.
 *
 * Usage:
 *
 *   import { dispatchEndpointStream } from '@/lib/transport-adapters';
 *
 *   for await (const ev of dispatchEndpointStream('operator:scan', input, { signal })) {
 *     if (ev.kind === 'event' && ev.name === 'delta') ...
 *     else if (ev.kind === 'done') ...
 *   }
 *
 * For tools whose Hono shim lives at a non-default URL, use
 * `dispatchEndpointStreamHttp` directly with `{ overrideUrl: '...' }`.
 */

import { isForceHttp } from './config';
import { dispatchEndpointStreamHttp } from './http-stream';
import { dispatchEndpointStreamIpc } from './ipc-stream';
import type { DispatchEndpointStreamFn } from './types';

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  // @tauri-apps/api 2.x feature-detect. Matches `wsl-tauri.ts` /
  // `pty-tauri.ts` shape; do not import `@tauri-apps/api/core`'s
  // `isTauri` directly because it's not statically importable from
  // SSR contexts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Boolean((window as any).__TAURI_INTERNALS__?.invoke);
}

/**
 * Resolved at first call rather than at module-load, so feature-detect
 * survives early script execution before __TAURI_INTERNALS__ is injected.
 */
let cached: DispatchEndpointStreamFn | null = null;
function resolveTransport(): DispatchEndpointStreamFn {
  if (cached) return cached;
  cached = !isForceHttp() && isTauri()
    ? dispatchEndpointStreamIpc
    : dispatchEndpointStreamHttp;
  return cached;
}

export const dispatchEndpointStream: DispatchEndpointStreamFn = (toolName, input, options) =>
  resolveTransport()(toolName, input, options);

export { dispatchEndpointStreamHttp, dispatchEndpointStreamIpc };
export {
  configureDesktopIpc,
  type DesktopIpcConfig,
  type DesktopIpcEnvOverrides,
  DEFAULT_CONTENT_ORIGIN_API_PREFIXES,
  isContentOriginScopedPath,
  resolveIpcOwnerIsContentOrigin,
} from './config';
// The EventSource-over-IPC class. The desktop bootstrap installs it as
// `window.EventSource`; also exported for direct use + cross-layer tests.
export { IpcEventSource, type IpcEventSourceOptions } from './ipc-event-source';
export { ipcFetch, type IpcFetchOptions } from './ipc-fetch';
// P-003(a): the webview-HTTP-egress invariant. `classifyEgress` is the pure rule
// (assert it anywhere); `getEgressReport` reads the live shell — null means
// UNKNOWN (no monitor), never "clean".
export {
  installEgressMonitor,
  getEgressReport,
  classifyEgress,
  EGRESS_RING_SIZE,
  _resetEgressMonitorForTests,
  type EgressEntry,
  type EgressReport,
  type EgressOptions,
  type EgressMonitorHandle,
  type ResourceTimingLike,
} from './egress-monitor';
// P-010: the third transport door. fetch and EventSource are ROUTED over IPC;
// XMLHttpRequest has no IPC route, so it is REFUSED instead. `classifyXhrTarget`
// is the pure rule, testable without a DOM — same split as `classifyEgress`.
export {
  installXhrGuard,
  classifyXhrTarget,
  _resetXhrGuardForTests,
  type XhrVerdict,
  type XhrGuardOptions,
  type XhrGuardHandle,
} from './xhr-guard';
// P-013: the fourth and last transport door. Like XHR it is REFUSED rather than
// routed — and for a stronger reason, measured in D-042: the operator serves no
// WebSocket endpoint at all, so there is nothing to route to. `classifyWsTarget`
// matches on AUTHORITY (host:port), not the origin string, because `ws://h:p` and
// `http://h:p` are the same operator but never the same origin.
export {
  installWsGuard,
  classifyWsTarget,
  _resetWsGuardForTests,
  type WsVerdict,
  type WsGuardOptions,
  type WsGuardHandle,
} from './ws-guard';
// P-006: the destination invariant expressed as a CSP (the PREVENTION leg, vs
// the monitor above which OBSERVES). One shared constant so the vite dev server,
// the SPA host and the desktop cannot drift apart on what "local" means.
export {
  CODE_ORIGIN_ENFORCING_CSP,
  LOCAL_ONLY_CSP,
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
  CSP_ENFORCING_HEADER,
  cspHeaders,
} from './csp-policy';
export type {
  EndpointStreamEvent,
  DispatchEndpointStreamOptions,
  DispatchEndpointStreamFn,
} from './types';

// IPC traffic inspector (dev-only observability seam). The app's dev bootstrap
// installs a recorder via `setIpcInspector`; production leaves it unset so the
// in-transport hooks stay no-ops. Plan: calltool-endpoint-seam (Phase C).
export {
  setIpcInspector,
  isIpcInspectorEnabled,
  // Producer side of the seam (transport authors / instrumentation tests emit).
  emitIpcTrace,
  nextIpcTraceId,
  type IpcTraceEvent,
  type IpcTraceKind,
  type IpcInspectorFn,
} from './ipc-inspector';
