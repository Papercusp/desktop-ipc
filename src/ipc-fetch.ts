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

export interface IpcFetchRetryOptions {
  /** Number of retries (additional attempts beyond the first) for an
   *  idempotent request that fails pre-head with `connection_lost`.
   *  Defaults to `backoffMs.length`. */
  attempts?: number;
  /** Per-retry backoff in ms; the attempt index is clamped to the last
   *  entry. Defaults to {@link DEFAULT_RETRY_BACKOFF_MS}. */
  backoffMs?: number[];
  /** Injectable delay (tests pass a no-op). Honors the caller's signal. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface IpcFetchOptions {
  /** Override the dispatch fn (for tests). Defaults to the real Tauri IPC. */
  dispatch?: DispatchEndpointStreamFn;
  /** Tune/disable the transparent `connection_lost` retry. */
  retry?: IpcFetchRetryOptions;
}

/** The only error code retried transparently: the IPC socket dropped (most
 *  often the operator/sidecar restarting) while a call was in flight. The
 *  reconnecting Rust `IpcClientHandle` re-opens on the next invoke, so the
 *  retry rides the fresh connection. Every other terminal code means IPC
 *  *did* run (a real HTTP/handler outcome) and must NOT be replayed. */
const RETRYABLE_ERROR_CODE = 'connection_lost';

/** Default backoff schedule — short enough not to hang a loading spinner,
 *  long enough to span a reader-loop reconnect (~120ms observed) and a
 *  quick sidecar bounce. ~1.55s total across 3 retries. */
const DEFAULT_RETRY_BACKOFF_MS = [150, 400, 1000];

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
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

  // A dropped IPC socket — most often the operator/sidecar restarting, whose
  // Rust reader loop fires `connection_lost` at every in-flight call — is
  // transient: the reconnecting `IpcClientHandle` re-opens on the next
  // invoke. So for an idempotent request that fails *before any response
  // body is delivered*, we transparently re-dispatch; the retry rides the
  // fresh connection. Without this, a restart landing mid-load fails the
  // whole batch of concurrent reads (e.g. the /adv Plans tab "loading a lot
  // of things") with a hard error only a manual refresh clears.
  //
  // Three guards keep the replay safe:
  //  - Idempotent methods only (GET/HEAD). A mutation may have been applied
  //    server-side before the drop, so it's never silently replayed — the
  //    error surfaces and the user retries deliberately.
  //  - Pre-head only. Once `head` resolves the Response, bytes may already
  //    be in the consumer's hands; a mid-body drop errors the stream
  //    (makeBodyStream) — it can't be transparently re-run.
  //  - `connection_lost` only (not `invoke_failed`). `invoke_failed` means
  //    the IPC backend is absent (dev no-sidecar / prod pre-handshake) and
  //    is handled by the patched-fetch HTTP fallback — retrying it here
  //    would make dev mode eat a backoff on every /api call.
  const method = (init.method ?? 'GET').toUpperCase();
  const idempotent = method === 'GET' || method === 'HEAD';
  const backoffMs = opts.retry?.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const maxRetries = idempotent ? opts.retry?.attempts ?? backoffMs.length : 0;
  const sleep = opts.retry?.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    const iterator = dispatch('sys:http', ipcInput, { signal: abort.signal })[
      Symbol.asyncIterator
    ]();

    // Pull events until the first `head`. The server always sends `head`
    // before any body chunk; a terminal before `head` is an error (or the
    // "no head" case the prior buffering impl surfaced as a TypeError).
    // The inner loop only `break`s for the retryable case — every other
    // outcome returns the Response or throws.
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
        if (ev.code === RETRYABLE_ERROR_CODE && attempt < maxRetries) {
          break; // → backoff + re-dispatch on the reconnected socket
        }
        throw terminalError(ev.code, ev.message);
      }
      // A body chunk before `head` shouldn't happen — ignore and keep reading.
    }

    // Reached only by the retryable `break`. Close the dead call's iterator,
    // honor a caller abort instead of redispatching into the void, back off,
    // then loop to re-dispatch (which drives the Rust reconnect).
    void iterator.return?.(undefined);
    if (callerSignal?.aborted) throw new DOMException('request aborted', 'AbortError');
    await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)], callerSignal);
    if (callerSignal?.aborted) throw new DOMException('request aborted', 'AbortError');
  }
}
