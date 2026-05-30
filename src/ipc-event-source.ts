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
          this.fireError();
          this.close();
          return;
        }
      }
    } catch {
      if (this.readyState !== 2) {
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
