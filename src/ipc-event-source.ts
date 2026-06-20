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
 * Latches once IPC streaming proves unavailable this session, so subsequent
 * EventSources go straight to the native ctor instead of failing and
 * reconnect-looping on the same dead invoke. Reset only via
 * `_resetIpcEventSourceFallback` (tests).
 */
let ipcStreamingUnavailable = false;

export function setNativeEventSourceFallback(ctor: typeof EventSource | undefined): void {
  nativeEventSourceCtor = ctor;
}

/** Test-only reset of the module-level fallback latch + native ctor. */
export function _resetIpcEventSourceFallback(): void {
  nativeEventSourceCtor = undefined;
  ipcStreamingUnavailable = false;
}

/**
 * Tauri "command/state not registered" — the IPC backend isn't wired/ready.
 * Mirrors `isIpcUnavailable` in desktop-bootstrap (kept local to avoid an
 * import cycle: bootstrap imports this module).
 */
function isIpcUnavailableMessage(msg: string): boolean {
  return msg.includes('invoke_failed') || msg.includes('state not managed');
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

  private readonly parser = new SseParser();
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

  constructor(url: string | URL, init?: IpcEventSourceOptions) {
    super();
    this.url = url.toString();
    this.withCredentials = init?.withCredentials ?? false;
    this.dispatch = init?.dispatch ?? (dispatchEndpointStreamIpc as DispatchEndpointStreamFn);
    this.reconnectMs = init?.reconnectMs ?? 2000;
    // IPC streaming already proved dead this session → don't reattempt the
    // doomed invoke; hand back a real native EventSource instead. A
    // constructor that returns an object makes `new IpcEventSource()` yield
    // that object (spec-compliant), so consumers get native SSE with zero
    // event-proxying. Skipped when a dispatch fn is injected (tests / explicit
    // IPC use) so those paths keep exercising the IPC code.
    if (ipcStreamingUnavailable && nativeEventSourceCtor && !init?.dispatch) {
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

  /** One connection attempt. 'fatal' → already `close()`d, stop. 'drop' → reconnect. */
  private async runOnce(): Promise<'fatal' | 'drop'> {
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;

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
          const parsed = this.parser.feed(ev.data);
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
          // FATAL — latch so the next EventSource builds a native one (HTTP
          // fallback). A non-IPC-unavailable error is a transient drop → reconnect.
          if (isIpcUnavailableMessage(`${ev.code} ${ev.message}`)) {
            ipcStreamingUnavailable = true;
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
        // Unavailable backend that threw rather than yielding an error → latch + terminal.
        ipcStreamingUnavailable = true;
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
