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

function forceHttp(): boolean {
  // Rollback escape hatch — set this in Tauri's app config or the
  // operator's env to flip every IPC call back to HTTP without
  // shipping a new Rust binary.
  if (typeof process !== 'undefined') {
    const v = process.env?.NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT;
    if (v === '1' || v === 'true') return true;
  }
  return false;
}

/**
 * Resolved at first call rather than at module-load, so feature-detect
 * survives early script execution before __TAURI_INTERNALS__ is injected.
 */
let cached: DispatchEndpointStreamFn | null = null;
function resolveTransport(): DispatchEndpointStreamFn {
  if (cached) return cached;
  cached = !forceHttp() && isTauri()
    ? dispatchEndpointStreamIpc
    : dispatchEndpointStreamHttp;
  return cached;
}

export const dispatchEndpointStream: DispatchEndpointStreamFn = (toolName, input, options) =>
  resolveTransport()(toolName, input, options);

export { dispatchEndpointStreamHttp, dispatchEndpointStreamIpc };
export type {
  EndpointStreamEvent,
  DispatchEndpointStreamOptions,
  DispatchEndpointStreamFn,
} from './types';
