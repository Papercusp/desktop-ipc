/**
 * `IpcEventSource` — drop-in replacement for the global `EventSource`
 * that dispatches over Tauri IPC instead of opening a webview HTTP
 * connection.
 *
 * Install pattern (desktop bootstrap, next phase): on Tauri,
 * `window.EventSource = IpcEventSource`. Every consumer that does
 * `new EventSource('/api/...')` — including `createResilientEventSource`
 * (which reads `globalThis.EventSource`) — transparently moves to IPC.
 *
 * Spec semantics preserved:
 *  - `readyState`: 0=CONNECTING, 1=OPEN, 2=CLOSED.
 *  - `open` fires when the upstream response is 200 + text/event-stream.
 *  - Any other status / content-type fires `error` and closes (terminal).
 *  - `message` is the default event type; named `event:` lines dispatch
 *    as a `MessageEvent` of that type.
 *  - `id:` updates a persistent `lastEventId`; on reconnect we forward
 *    it as a `Last-Event-ID` header so resumable streams (sync SSE,
 *    log streams) keep their ring-buffer replay semantics.
 *
 * `withCredentials` is accepted for API compatibility but has no
 * effect — IPC has no cookies; the bridge's trust model synthesizes
 * the operator principal.
 */

import { dispatchEndpointStreamIpc } from './ipc-stream';
import type { DispatchEndpointStreamFn } from './types';
import { SseParser } from './sse-parser';
import { emitIpcTrace, nextIpcTraceId } from './ipc-inspector';
import {
  getIpcStreamFallbackCooldownMs,
  getIpcStartupGraceMs,
  getIpcStartupRetryMs,
  isRequireIpc,
} from './config';
import { isIpcNotWired, isIpcUnavailable } from './ipc-availability';

/**
 * Native EventSource ctor, captured by the desktop bootstrap *before* it does
 * `window.EventSource = IpcEventSource`. Used as a graceful fallback when the
 * Tauri IPC streaming backend is unavailable — the symmetric twin of the
 * native-HTTP fallback `ipcFetch` already has (see `isIpcUnavailable` in
 * desktop-bootstrap). Until `endpoint_ipc` is wired on the Rust side (and
 * during the dev-mode / prod-startup windows the bootstrap documents),
 * `endpoint_invoke` yields `invoke_failed` / `state not managed`; without
 * this fallback every SSE consumer (sync, log streams, UI intents) silently
 * dies on the desktop.
 */
let nativeEventSourceCtor: typeof EventSource | undefined;

/**
 * Deadline (epoch ms) until which IPC streaming is treated as unavailable, so
 * new EventSources go straight to the native ctor instead of failing and
 * reconnect-looping on the same dead invoke. `0` = not latched.
 *
 * ⚠ A COOLDOWN, deliberately NOT a permanent session flag. This was
 * `let ipcStreamingUnavailable = false` — a one-way module-global that no
 * production path ever cleared (WI-6255). Both conditions that set it are
 * TRANSIENT (see `isIpcUnavailable` in desktop-bootstrap): the prod window
 * between webview mount and the sidecar's `PAPERCUSP_IPC_READY` handshake (up
 * to 30s), and a momentarily missing/stale `endpoint-ipc.<port>.json`
 * advertisement in dev, where the `IpcClientHandle` is *reconnecting*. So the
 * permanent form fired on essentially every cold boot: the first stream to race
 * the handshake pinned EVERY later stream to native HTTP for the life of the
 * webview, and ~10 SSE consumers against WebKitGTK/libsoup's ~6-connection
 * per-host pool left the surplus streams CONNECTING forever.
 *
 * `ipcFetch` never had this bug — its fallback is decided per call, so fetch
 * self-healed the moment IPC came up while streams stayed starved. That
 * split-brain (fetch on IPC, SSE on exhausted HTTP) is what made the symptom
 * read as a sync concurrency cap rather than a transport fault.
 */
let ipcUnavailableUntilMs = 0;

export function setNativeEventSourceFallback(ctor: typeof EventSource | undefined): void {
  nativeEventSourceCtor = ctor;
}

/** True while the cooldown from a proven-unavailable IPC backend is still running. */
function ipcStreamingLatched(): boolean {
  return ipcUnavailableUntilMs > 0 && Date.now() < ipcUnavailableUntilMs;
}

/**
 * Latch (or re-latch) the native-EventSource fallback for one cooldown window.
 * Re-latching on a failed re-probe is what keeps a genuinely IPC-less webview
 * from paying a doomed invoke per `createResilientEventSource` rebuild.
 */
function latchIpcUnavailable(): void {
  ipcUnavailableUntilMs = Date.now() + getIpcStreamFallbackCooldownMs();
}

/**
 * Clear the latch the moment IPC streaming demonstrably works, so the remaining
 * consumers stop being routed to native HTTP without waiting out the rest of
 * the cooldown. Called on every successful stream head.
 */
function clearIpcUnavailable(): void {
  ipcUnavailableUntilMs = 0;
}

/** Test-only reset of the module-level fallback latch + native ctor. */
export function _resetIpcEventSourceFallback(): void {
  nativeEventSourceCtor = undefined;
  ipcUnavailableUntilMs = 0;
}

// Availability classification lives in its own leaf module (`ipc-availability`)
// so this file and `desktop-bootstrap` share ONE implementation. It used to be
// duplicated here "to avoid an import cycle" — the leaf module removes the cycle
// without the copy, and a copy is exactly what would drift once `requireIpc`
// made the two conditions behave differently.
function isIpcUnavailableMessage(msg: string): boolean {
  return isIpcUnavailable(msg);
}

export interface IpcEventSourceOptions {
  withCredentials?: boolean;
  /** Override the dispatch fn (for tests). Defaults to the real Tauri IPC. */
  dispatch?: DispatchEndpointStreamFn;
  /** Reconnect backoff in ms after a dropped stream (default 2000; tests use a small value). */
  reconnectMs?: number;
}

export class IpcEventSource extends EventTarget {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSED = 2 as const;
  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSED = 2 as const;

  readonly url: string;
  readonly withCredentials: boolean;
  // `number` (not a `0 | 1 | 2` literal union) on purpose: this field is mutated
  // across `await`s by close()/terminate(), and a literal union makes TS's
  // control-flow analysis narrow it (e.g. the `while (readyState !== 2)` loop in
  // run()) and then wrongly flag the legitimate post-await `=== 2` re-checks as
  // "no overlap". `number` also matches the native EventSource.readyState contract
  // this class faithfully emulates. Semantics unchanged: 0=CONNECTING,1=OPEN,2=CLOSED.
  readyState: number = 0;

  onopen: ((this: IpcEventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: IpcEventSource, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: IpcEventSource, ev: Event) => unknown) | null = null;

  private readonly abort = new AbortController();
  private readonly dispatch: DispatchEndpointStreamFn;
  private lastEventId = '';
  /**
   * Reconnect backoff after a dropped stream (native EventSource's default
   * reconnection time is ~3s; a server `retry:` line could lower it, but we keep
   * it simple). Short enough that a consumer's open-watchdog (e.g.
   * DesktopAttentionNotifier's ~4s grace) re-sees OPEN before firing.
   */
  private readonly reconnectMs: number;
  /** Inspector correlation id — shared by every lifecycle event of THIS source. */
  private readonly traceId = nextIpcTraceId();
  /** Construction time — the origin of the startup grace window (see inStartupGrace). */
  private readonly createdAtMs = Date.now();

  /**
   * True while this source is young enough that "the IPC bridge isn't up yet"
   * should be RETRIED rather than treated as a dead backend.
   *
   * The webview mounts and opens its streams before the Rust `IpcClientHandle`
   * has connected, so without this every boot stream took the unavailable path
   * and fell back to native HTTP — and because a long-lived SSE connection
   * holds one of libsoup's ~6 per-host sockets for the whole session, those
   * boot-era streams exhausted the pool for the rest of the page's life
   * (WI-6257). Waiting a beat costs a stream that will live for hours almost
   * nothing; falling back costs it a socket forever.
   */
  private inStartupGrace(): boolean {
    return Date.now() - this.createdAtMs < getIpcStartupGraceMs();
  }

  /** Set once this source has already reported an unavailable bridge. */
  private warnedIpcUnavailable = false;

  /**
   * Report an IPC bridge that is unavailable PAST the startup grace, once per
   * source. Under `requireIpc` this is no longer a quiet internal fallback — it
   * is the operator-visible signal that the desktop is degraded, and the thing
   * whose absence let WI-6512 hide for two months.
   *
   * Deliberately `console.error`, not `warn`: the console is already noisy and a
   * warn reads as routine. Also emits an `ipc-unavailable` trace so the
   * inspector can surface it in-app rather than only in devtools.
   */
  private warnIpcUnavailableOnce(detail: string): void {
    if (this.warnedIpcUnavailable) return;
    this.warnedIpcUnavailable = true;
    emitIpcTrace({ kind: 'es-error', id: this.traceId, path: this.url });
    const host = typeof globalThis !== 'undefined' ? globalThis.console : undefined;
    host?.error?.(
      `[desktop-ipc] IPC bridge unavailable for ${this.url} — holding the stream ` +
        `CONNECTING and retrying (requireIpc). NOT falling back to HTTP: a fallback ` +
        `stream would consume one of ~6 per-host webview sockets for the session ` +
        `and silently reintroduce WI-6512. Check that the operator's endpoint-ipc ` +
        `socket exists AND has connections. Detail: ${detail}`,
    );
  }

  constructor(url: string | URL, init?: IpcEventSourceOptions) {
    super();
    this.url = url.toString();
    this.withCredentials = init?.withCredentials ?? false;
    this.dispatch = init?.dispatch ?? (dispatchEndpointStreamIpc as DispatchEndpointStreamFn);
    this.reconnectMs = init?.reconnectMs ?? 2000;
    // IPC streaming proved dead RECENTLY (inside the cooldown) → don't reattempt
    // the doomed invoke; hand back a real native EventSource instead. A
    // constructor that returns an object makes `new IpcEventSource()` yield
    // that object (spec-compliant), so consumers get native SSE with zero
    // event-proxying. Skipped when a dispatch fn is injected (tests / explicit
    // IPC use) so those paths keep exercising the IPC code.
    //
    // Once the cooldown expires this falls through and re-probes IPC, which is
    // what lets a boot-window failure heal instead of stranding every stream on
    // native HTTP for the life of the webview (WI-6255).
    //
    // ⚠ Skipped entirely under `isRequireIpc()` (the DEFAULT): a stream that
    // falls back holds one of libsoup's ~6 per-host sockets for the whole
    // session, which is the bug this package exists to prevent. Waiting for the
    // bridge is strictly better for a stream that will live for hours.
    if (
      !isRequireIpc() &&
      ipcStreamingLatched() &&
      nativeEventSourceCtor &&
      !init?.dispatch
    ) {
      return new nativeEventSourceCtor(this.url, {
        withCredentials: this.withCredentials,
      }) as unknown as IpcEventSource;
    }
    // A genuine IpcEventSource construction = a NEW IPC channel. The COUNT of
    // these per URL is the churn metric: >1 for a long-lived stream means a
    // consumer is recreating us instead of letting us auto-reconnect.
    emitIpcTrace({ kind: 'es-open', id: this.traceId, path: this.url });
    void this.run();
  }

  close(): void {
    if (this.readyState === 2) return;
    this.readyState = 2;
    emitIpcTrace({ kind: 'es-close', id: this.traceId, path: this.url });
    this.abort.abort();
  }

  /**
   * Terminal failure: set readyState CLOSED *then* fire `error` — faithful to a
   * native EventSource, which sets CLOSED before its give-up `error`. The order
   * is load-bearing for a recreate-on-CLOSED consumer
   * (`createResilientEventSource`): it inspects readyState in its error handler
   * to tell a transient drop (CONNECTING → leave us to auto-reconnect) from a
   * death (CLOSED → rebuild, which on the IPC-unavailable latch yields a native
   * EventSource fallback). Firing error *before* close() would show CONNECTING,
   * so the consumer would wait forever for a reconnect that can't happen.
   * Idempotent. Plan: calltool-endpoint-seam-2026-06-01 (Phase D, P-007).
   */
  private terminate(): void {
    if (this.readyState === 2) return;
    this.readyState = 2;
    emitIpcTrace({ kind: 'es-error', id: this.traceId, path: this.url });
    const ev = new Event('error');
    this.dispatchEvent(ev);
    this.onerror?.call(this, ev);
    this.abort.abort();
  }

  private pathFromUrl(): string {
    try {
      const base =
        typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
      const u = new URL(this.url, base);
      return u.pathname + u.search + u.hash;
    } catch {
      return this.url;
    }
  }

  /**
   * Reconnect loop — IpcEventSource is a FAITHFUL EventSource: a dropped stream
   * (server close / `done` / a transient error) reconnects with `Last-Event-ID`
   * instead of terminating, exactly like the native `EventSource`. This is the
   * fix for the dev-IPC reconnect churn (the flashing): the one-shot version
   * `close()`d on every drop, so a consumer's resilient wrapper recreated us —
   * and each recreate is a brand-new IPC channel + a sync-layer re-subscribe +
   * re-render. Auto-reconnecting keeps `readyState` at CONNECTING (not CLOSED)
   * across a drop, so a spec-correct consumer leaves us alone. Terminal ONLY on
   * `close()` (consumer) or a fatal head / IPC-unavailable backend.
   * Plan: calltool-endpoint-seam-2026-06-01 (Phase D, P-007).
   */
  private async run(): Promise<void> {
    while (this.readyState !== 2) {
      const outcome = await this.runOnce();
      if (outcome === 'fatal' || this.readyState === 2) return;
      if (outcome === 'ipc-wait') {
        // The IPC bridge isn't up YET (startup race), not dead. Stay CONNECTING
        // and retry quickly — deliberately WITHOUT firing `error` or an es-drop
        // trace, because nothing dropped: this source has never opened, and a
        // burst of spurious errors during boot is exactly what would push a
        // consumer's resilient wrapper into recreating us. Native EventSource
        // is likewise silent while it has yet to connect.
        this.readyState = 0;
        await this.delay(getIpcStartupRetryMs());
        continue;
      }
      // Dropped → reconnect like native EventSource: go back to CONNECTING (NOT
      // closed), fire `error` (native fires it on disconnect), brief backoff,
      // re-open. A consumer that recreates only on CLOSED sees CONNECTING and
      // does nothing — no churn. The trace pairs `es-drop`/`es-connect` WITHOUT
      // a new `es-open`, which is exactly how the inspector distinguishes a
      // healthy internal reconnect from a wrapper recreating the source.
      emitIpcTrace({ kind: 'es-drop', id: this.traceId, path: this.url });
      this.readyState = 0;
      this.fireError();
      await this.delay(this.reconnectMs);
    }
  }

  /**
   * One connection attempt.
   * 'fatal'    → already `close()`d, stop.
   * 'drop'     → a real disconnect; fire `error` + reconnect after the backoff.
   * 'ipc-wait' → the IPC bridge isn't up yet and we're still inside the startup
   *              grace; retry quietly and quickly, WITHOUT falling back to HTTP.
   */
  private async runOnce(): Promise<'fatal' | 'drop' | 'ipc-wait'> {
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
    // Parser state is PER-CONNECTION (native EventSource semantics): a stream
    // that drops MID-EVENT leaves an unterminated partial line buffered, and a
    // shared parser would prepend it to the reconnected stream's first event —
    // corrupting it. That first event is often the one-shot `backfill` of a
    // live-follow stream, which then fails to parse and can never be re-sent:
    // the "connecting… forever while small events still flow" wedge.
    // `this.lastEventId` intentionally persists across attempts (spec).
    const parser = new SseParser();

    try {
      for await (const ev of this.dispatch(
        'sys:http',
        { method: 'GET', path: this.pathFromUrl(), headers },
        { signal: this.abort.signal },
      )) {
        if (this.readyState === 2) return 'fatal';

        if (ev.kind === 'event' && ev.name === 'head') {
          const head = ev.data as { status: number; headers: Record<string, string> };
          const ct = String(head.headers?.['content-type'] ?? '').toLowerCase();
          if (head.status === 200 && ct.includes('text/event-stream')) {
            this.readyState = 1;
            // IPC streaming just demonstrably worked — drop any outstanding
            // cooldown so peer consumers stop being routed to native HTTP
            // immediately, rather than after the rest of the window (WI-6255).
            clearIpcUnavailable();
            emitIpcTrace({ kind: 'es-connect', id: this.traceId, path: this.url });
            const open = new Event('open');
            this.dispatchEvent(open);
            this.onopen?.call(this, open);
          } else {
            // Non-2xx / wrong content-type is a real failure — native
            // EventSource also gives up on a non-2xx response. Terminal
            // (readyState CLOSED before the error, so a wrapper rebuilds).
            this.terminate();
            return 'fatal';
          }
        } else if (
          ev.kind === 'event' &&
          ev.name === 'sse-chunk' &&
          typeof ev.data === 'string'
        ) {
          const parsed = parser.feed(ev.data);
          for (const p of parsed) {
            if (p.lastEventId !== null) this.lastEventId = p.lastEventId;
            const msg = new MessageEvent(p.type, {
              data: p.data,
              lastEventId: p.lastEventId ?? '',
              origin:
                typeof window !== 'undefined' ? window.location.origin : '',
            });
            this.dispatchEvent(msg);
            if (p.type === 'message') this.onmessage?.call(this, msg);
          }
        } else if (ev.kind === 'done') {
          // Server closed the stream → reconnect (native EventSource semantics).
          return 'drop';
        } else if (ev.kind === 'error') {
          // The unwired/unready backend surfaces here (ipc-stream yields
          // {kind:'error', code:'invoke_failed'} rather than throwing). That is
          // "Not up YET" inside the startup grace is retryable — wait for the
          // bridge rather than burning a socket on native HTTP for the session.
          // Only a backend still unavailable AFTER the grace is treated as dead:
          // latch so the next EventSource builds a native one (HTTP fallback).
          // A non-IPC-unavailable error is a transient drop → reconnect.
          if (isIpcUnavailableMessage(`${ev.code} ${ev.message}`)) {
            if (this.inStartupGrace()) return 'ipc-wait';
            // requireIpc: never burn a socket on native HTTP. Stay retryable
            // forever and say so LOUDLY — a silent revert to HTTP is what hid
            // this defect for two months (WI-6512).
            //
            // EXCEPT when the bridge is NOT WIRED (`PAPERCUSP_DESKTOP_IPC=0`,
            // a build without IPC, a webview refusing ipc://): nothing will
            // create it later, so waiting is a permanent hang rather than a
            // wait. That env var is a deliberate rollback lever — treat it like
            // `forceHttp` and fall back, or pulling it would break the app at
            // the exact moment someone reached for it.
            if (isRequireIpc() && !isIpcNotWired(`${ev.code} ${ev.message}`)) {
              this.warnIpcUnavailableOnce(`${ev.code} ${ev.message}`);
              return 'ipc-wait';
            }
            latchIpcUnavailable();
            this.terminate();
            return 'fatal';
          }
          return 'drop';
        }
      }
      // Iterator completed without `done`/`error` (stream ended) → reconnect.
      return 'drop';
    } catch (err) {
      if (this.readyState === 2) return 'fatal';
      const msg = err instanceof Error ? err.message : String(err);
      if (isIpcUnavailableMessage(msg)) {
        // Unavailable backend that THREW rather than yielding an error. Same
        // startup-grace and not-wired rules as the yielded-error path above.
        if (this.inStartupGrace()) return 'ipc-wait';
        if (isRequireIpc() && !isIpcNotWired(msg)) {
          this.warnIpcUnavailableOnce(msg);
          return 'ipc-wait';
        }
        latchIpcUnavailable();
        this.terminate();
        return 'fatal';
      }
      // Transient throw → reconnect.
      return 'drop';
    }
  }

  /** Abortable backoff — resolves early when the source is `close()`d. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.abort.signal.aborted) {
        resolve();
        return;
      }
      const t = setTimeout(resolve, ms);
      this.abort.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }

  private fireError(): void {
    if (this.readyState === 2) return;
    const ev = new Event('error');
    this.dispatchEvent(ev);
    this.onerror?.call(this, ev);
  }
}
