/**
 * `ipcFetch` — `fetch()` over the IPC `sys:http` bridge.
 *
 * Drop-in for `window.fetch` on the desktop, routing same-origin
 * `/api/*` requests through Tauri IPC → Node sidecar → the operator's
 * own loopback HTTP. The webview opens no HTTP connection itself, so
 * these calls don't compete against the browser's per-host connection
 * pool with the long-lived SSE streams.
 *
 * Streaming: the returned `Response` has a live `ReadableStream` body.
 * The `head` event resolves the `Response` (status + headers); each
 * subsequent `sse-chunk` (text/event-stream) or `body` (binary) event is
 * enqueued into the body stream **as it arrives**. So a POST consumer
 * that does `fetch(...).then(r => r.body.getReader())` — e.g. the oracle
 * and agent-chat bubbles, which can't use `IpcEventSource` because SSE
 * over POST isn't an `EventSource` — streams deltas incrementally on the
 * desktop, exactly as it would over plain HTTP. (The earlier version
 * buffered the whole response to `DONE` before resolving, which made
 * those chats render their reply all at once after generation finished.)
 * Non-streaming JSON callers (`await r.json()` / `r.text()`) drain the
 * stream transparently and are unaffected.
 *
 * The stream is pull-based, so it honors consumer backpressure and never
 * buffers ahead of what the consumer reads. Cancelling the body
 * (`reader.cancel()` / a discarded `Response`) aborts the upstream call,
 * so closing a chat mid-stream tears down the server-side agent spawn
 * instead of leaking it.
 *
 * Phase 1 scope: string bodies only. Binary request bodies (ArrayBuffer,
 * Blob, FormData with files, ReadableStream) throw — the bridge has the
 * mechanism (the wire's `body` slot accepts strings; raw bytes need an
 * extra encoding step), but no current consumer needs it. Easy to
 * extend when one does.
 *
 * `aborted` and `upstream_error` from the bridge become a thrown
 * `AbortError` (matching native fetch) and a `TypeError`, respectively —
 * before `head` they reject the `ipcFetch` promise; after `head` (i.e.
 * mid-body) they error the body stream so the consumer's pending
 * `read()` rejects, matching how native fetch surfaces a dropped
 * response body.
 */

import { dispatchEndpointStreamIpc } from './ipc-stream';
import type { DispatchEndpointStreamFn, EndpointStreamEvent } from './types';

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

function terminalError(code: string, message: string): Error {
  if (code === 'aborted') {
    return new DOMException(message || 'aborted', 'AbortError');
  }
  return new TypeError(`ipcFetch failed [${code}]: ${message}`);
}

/**
 * Build the body `ReadableStream` that continues draining the IPC event
 * iterator from right after the `head` event. Pull-based: one
 * `iterator.next()` per `pull`, enqueuing exactly one chunk (or
 * closing/erroring), so consumer backpressure naturally paces the bridge.
 */
function makeBodyStream(
  iterator: AsyncIterator<EndpointStreamEvent>,
  abort: AbortController,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Loop past non-body events (a stray 'event'/extra 'head') until we
        // enqueue one chunk or hit a terminal.
        for (;;) {
          const { value: ev, done } = await iterator.next();
          if (done) {
            controller.close();
            return;
          }
          if (ev.kind === 'binary' && ev.name === 'body') {
            controller.enqueue(ev.data);
            return;
          }
          if (ev.kind === 'event' && ev.name === 'sse-chunk' && typeof ev.data === 'string') {
            controller.enqueue(encoder.encode(ev.data));
            return;
          }
          if (ev.kind === 'done') {
            controller.close();
            return;
          }
          if (ev.kind === 'error') {
            controller.error(terminalError(ev.code, ev.message));
            return;
          }
          // Unknown/non-body event — keep pulling.
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      // Consumer cancelled the body → abort the upstream call and let the
      // generator run its finally (which sends a CANCEL frame).
      abort.abort();
      void iterator.return?.(undefined);
    },
  });
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

  const callerSignal = init.signal ?? undefined;
  // Native fetch rejects synchronously when handed an already-aborted signal.
  if (callerSignal?.aborted) {
    throw new DOMException('request aborted', 'AbortError');
  }

  // Combine the caller's signal with an internal controller so cancelling
  // the Response body stream (`reader.cancel()`) aborts the upstream call —
  // otherwise closing a chat mid-stream would leak the server-side agent
  // spawn that's still producing tokens.
  const abort = new AbortController();
  if (callerSignal) {
    callerSignal.addEventListener('abort', () => abort.abort(), { once: true });
  }

  const ipcInput = {
    method: init.method ?? 'GET',
    path,
    headers,
    body,
  };

  const iterator = dispatch('sys:http', ipcInput, { signal: abort.signal })[
    Symbol.asyncIterator
  ]();

  // Pull events until the first `head`. The server always sends `head`
  // before any body chunk; a terminal before `head` is an error (or the
  // "no head" case the prior buffering impl surfaced as a TypeError).
  for (;;) {
    const { value: ev, done } = await iterator.next();
    if (done) {
      throw new TypeError('ipcFetch: stream ended without a head event');
    }
    if (ev.kind === 'event' && ev.name === 'head') {
      const head = ev.data as { status: number; headers: Record<string, string> };
      return new Response(makeBodyStream(iterator, abort), {
        status: head.status,
        headers: head.headers,
      });
    }
    if (ev.kind === 'done') {
      throw new TypeError('ipcFetch: stream ended without a head event');
    }
    if (ev.kind === 'error') {
      throw terminalError(ev.code, ev.message);
    }
    // A body chunk before `head` shouldn't happen — ignore and keep reading.
  }
}
