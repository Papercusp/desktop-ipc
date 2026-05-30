/**
 * `ipcFetch` — `fetch()` over the IPC `sys:http` bridge.
 *
 * Drop-in for `window.fetch` on the desktop, routing same-origin
 * `/api/*` requests through Tauri IPC → Node sidecar → the operator's
 * own loopback HTTP. The webview opens no HTTP connection itself, so
 * these calls don't compete against the browser's per-host connection
 * pool with the long-lived SSE streams.
 *
 * Phase 1 scope: string bodies only. Binary request bodies (ArrayBuffer,
 * Blob, FormData with files, ReadableStream) throw — the bridge has the
 * mechanism (the wire's `body` slot accepts strings; raw bytes need an
 * extra encoding step), but no current consumer needs it. Easy to
 * extend when one does.
 *
 * `aborted` and `upstream_error` from the bridge become a thrown
 * `AbortError` (matching native fetch) and a `TypeError`, respectively.
 */

import { dispatchEndpointStreamIpc } from './ipc-stream';
import type { DispatchEndpointStreamFn } from './types';

export interface IpcFetchOptions {
  /** Override the dispatch fn (for tests). Defaults to the real Tauri IPC. */
  dispatch?: DispatchEndpointStreamFn;
}

function pathFromUrl(url: string): string {
  try {
    const base =
      typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const u = new URL(url, base);
    // For same-origin (or no window — SSR/tests), use the relative path.
    // The bridge's path validator rejects absolute URLs, so this guards
    // against accidentally passing a cross-origin URL through ipcFetch.
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

export async function ipcFetch(
  input: string | URL,
  init: RequestInit = {},
  opts: IpcFetchOptions = {},
): Promise<Response> {
  const dispatch = opts.dispatch ?? (dispatchEndpointStreamIpc as DispatchEndpointStreamFn);

  const path = pathFromUrl(typeof input === 'string' ? input : input.toString());

  const headers: Record<string, string> = {};
  if (init.headers) {
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
  }

  let body: string | undefined;
  if (typeof init.body === 'string') {
    body = init.body;
  } else if (init.body != null) {
    throw new TypeError(
      'ipcFetch: only string request bodies are supported (Phase 1). ' +
        'Use ipcFetch with a JSON string, or extend the sys:http wire for binary bodies.',
    );
  }

  const ipcInput = {
    method: init.method ?? 'GET',
    path,
    headers,
    body,
  };

  let head: { status: number; headers: Record<string, string> } | null = null;
  const bodyChunks: Uint8Array[] = [];
  let terminal: { code: string; message: string } | null = null;

  const signal = init.signal ?? undefined;

  for await (const ev of dispatch('sys:http', ipcInput, { signal: signal ?? undefined })) {
    if (ev.kind === 'event' && ev.name === 'head') {
      head = ev.data as { status: number; headers: Record<string, string> };
    } else if (ev.kind === 'binary' && ev.name === 'body') {
      bodyChunks.push(ev.data);
    } else if (ev.kind === 'event' && ev.name === 'sse-chunk' && typeof ev.data === 'string') {
      // The bridge routed an SSE response through here. Callers wanting
      // SSE should use IpcEventSource, but degrade gracefully: append
      // each chunk as bytes so the assembled Response body still holds
      // the full wire output.
      bodyChunks.push(new TextEncoder().encode(ev.data));
    } else if (ev.kind === 'done') {
      break;
    } else if (ev.kind === 'error') {
      terminal = { code: ev.code, message: ev.message };
      break;
    }
  }

  if (terminal) {
    if (terminal.code === 'aborted') {
      throw new DOMException(terminal.message || 'aborted', 'AbortError');
    }
    throw new TypeError(`ipcFetch failed [${terminal.code}]: ${terminal.message}`);
  }
  if (!head) {
    throw new TypeError('ipcFetch: stream ended without a head event');
  }

  // Reassemble body bytes.
  let total = 0;
  for (const c of bodyChunks) total += c.length;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of bodyChunks) {
    bytes.set(c, offset);
    offset += c.length;
  }

  return new Response(bytes, {
    status: head.status,
    headers: head.headers,
  });
}
