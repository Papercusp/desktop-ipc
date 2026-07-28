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
export { configureDesktopIpc, type DesktopIpcConfig } from './config';
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
