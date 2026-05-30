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
}

type ReadyState = 0 | 1 | 2;

export class IpcEventSource extends EventTarget {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSED = 2 as const;
  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSED = 2 as const;

  readonly url: string;
  readonly withCredentials: boolean;
  readyState: ReadyState = 0;

  onopen: ((this: IpcEventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: IpcEventSource, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: IpcEventSource, ev: Event) => unknown) | null = null;

  private readonly parser = new SseParser();
  private readonly abort = new AbortController();
  private readonly dispatch: DispatchEndpointStreamFn;
  private lastEventId = '';

  constructor(url: string | URL, init?: IpcEventSourceOptions) {
    super();
    this.url = url.toString();
    this.withCredentials = init?.withCredentials ?? false;
    this.dispatch = init?.dispatch ?? (dispatchEndpointStreamIpc as DispatchEndpointStreamFn);
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
    void this.run();
  }

  close(): void {
    if (this.readyState === 2) return;
    this.readyState = 2;
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

  private async run(): Promise<void> {
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;

    try {
      for await (const ev of this.dispatch(
        'sys:http',
        { method: 'GET', path: this.pathFromUrl(), headers },
        { signal: this.abort.signal },
      )) {
        if (this.readyState === 2) break;

        if (ev.kind === 'event' && ev.name === 'head') {
          const head = ev.data as { status: number; headers: Record<string, string> };
          const ct = String(head.headers?.['content-type'] ?? '').toLowerCase();
          if (head.status === 200 && ct.includes('text/event-stream')) {
            this.readyState = 1;
            const open = new Event('open');
            this.dispatchEvent(open);
            this.onopen?.call(this, open);
          } else {
            this.fireError();
            this.close();
            return;
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
          this.close();
          return;
        } else if (ev.kind === 'error') {
          // The unwired/unready backend surfaces here (ipc-stream yields
          // {kind:'error', code:'invoke_failed'} rather than throwing). Latch
          // so the resilient wrapper's reconnect builds a native EventSource.
          if (isIpcUnavailableMessage(`${ev.code} ${ev.message}`)) {
            ipcStreamingUnavailable = true;
          }
          this.fireError();
          this.close();
          return;
        }
      }
    } catch (err) {
      if (this.readyState !== 2) {
        // Belt-and-suspenders: if the dispatch ever throws (rather than
        // yielding an error event) for an unavailable backend, latch too.
        const msg = err instanceof Error ? err.message : String(err);
        if (isIpcUnavailableMessage(msg)) ipcStreamingUnavailable = true;
        this.fireError();
        this.close();
      }
    }
  }

  private fireError(): void {
    if (this.readyState === 2) return;
    const ev = new Event('error');
    this.dispatchEvent(ev);
    this.onerror?.call(this, ev);
  }
}
