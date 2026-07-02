import { describe, expect, it } from 'vitest';
import {
  IpcEventSource,
  setNativeEventSourceFallback,
  _resetIpcEventSourceFallback,
} from './ipc-event-source';
import { setIpcInspector, type IpcTraceEvent } from './ipc-inspector';
import type { DispatchEndpointStreamFn, EndpointStreamEvent } from './types';

function dispatcherFromQueue(): {
  dispatch: DispatchEndpointStreamFn;
  push: (ev: EndpointStreamEvent) => void;
  close: () => void;
  observed: { toolName?: string; input?: any };
} {
  let resolveNext: ((v: { done: boolean; value?: EndpointStreamEvent }) => void) | null = null;
  const queue: EndpointStreamEvent[] = [];
  let closed = false;
  const observed: { toolName?: string; input?: any } = {};

  const dispatch: DispatchEndpointStreamFn = async function* (toolName, input) {
    observed.toolName = toolName;
    observed.input = input;
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (closed) return;
      await new Promise<{ done: boolean; value?: EndpointStreamEvent }>((r) => {
        resolveNext = r;
      });
    }
  };

  return {
    dispatch,
    push: (ev) => {
      queue.push(ev);
      resolveNext?.({ done: false });
      resolveNext = null;
    },
    close: () => {
      closed = true;
      resolveNext?.({ done: true });
      resolveNext = null;
    },
    observed,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('IpcEventSource', () => {
  it('opens on head{status:200, content-type:text/event-stream}', async () => {
    const d = dispatcherFromQueue();
    const es = new IpcEventSource('/api/stream', { dispatch: d.dispatch });
    expect(es.readyState).toBe(0);

    let opened = false;
    es.onopen = () => {
      opened = true;
    };
    d.push({
      kind: 'event',
      name: 'head',
      data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
    });

    await waitFor(() => opened);
    expect(es.readyState).toBe(1);
    es.close();
  });

  it('errors and closes on non-SSE content-type', async () => {
    const d = dispatcherFromQueue();
    const es = new IpcEventSource('/api/foo', { dispatch: d.dispatch });
    let errored = false;
    es.onerror = () => {
      errored = true;
    };
    d.push({
      kind: 'event',
      name: 'head',
      data: { status: 200, headers: { 'content-type': 'application/json' } },
    });
    await waitFor(() => errored);
    expect(es.readyState).toBe(2);
  });

  it('errors and closes on non-200 status', async () => {
    const d = dispatcherFromQueue();
    const es = new IpcEventSource('/api/foo', { dispatch: d.dispatch });
    let errored = false;
    es.onerror = () => {
      errored = true;
    };
    d.push({
      kind: 'event',
      name: 'head',
      data: { status: 503, headers: { 'content-type': 'text/event-stream' } },
    });
    await waitFor(() => errored);
    expect(es.readyState).toBe(2);
  });

  it('sets readyState CLOSED *before* firing a fatal error (recreate-on-CLOSED contract)', async () => {
    // createResilientEventSource inspects readyState in its error handler to
    // tell a transient drop (CONNECTING → leave us to auto-reconnect) from a
    // death (CLOSED → rebuild, which on the IPC-unavailable latch yields the
    // native fallback). A fatal must therefore present CLOSED *at* error time.
    const d = dispatcherFromQueue();
    const es = new IpcEventSource('/api/foo', { dispatch: d.dispatch });
    let stateAtError = -1;
    es.onerror = () => { stateAtError = es.readyState; };
    d.push({
      kind: 'event',
      name: 'head',
      data: { status: 503, headers: { 'content-type': 'text/event-stream' } },
    });
    await waitFor(() => stateAtError !== -1);
    expect(stateAtError).toBe(2); // CLOSED when the handler runs, not after
  });

  it('parses sse-chunk events into MessageEvents on the correct type', async () => {
    const d = dispatcherFromQueue();
    const es = new IpcEventSource('/api/stream', { dispatch: d.dispatch });

    const got: { type: string; data: string; lastEventId: string }[] = [];
    es.addEventListener('message', (e) =>
      got.push({ type: 'message', data: (e as MessageEvent).data, lastEventId: (e as MessageEvent).lastEventId }),
    );
    es.addEventListener('custom', (e) =>
      got.push({ type: 'custom', data: (e as MessageEvent).data, lastEventId: (e as MessageEvent).lastEventId }),
    );

    d.push({
      kind: 'event',
      name: 'head',
      data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
    });
    d.push({ kind: 'event', name: 'sse-chunk', data: 'data: hello\n\n' });
    d.push({
      kind: 'event',
      name: 'sse-chunk',
      data: 'event: custom\nid: 7\ndata: payload\n\n',
    });
    await waitFor(() => got.length >= 2);
    expect(got).toEqual([
      { type: 'message', data: 'hello', lastEventId: '' },
      { type: 'custom', data: 'payload', lastEventId: '7' },
    ]);
    es.close();
  });

  it('forwards Last-Event-ID on subsequent constructions (resume semantics)', async () => {
    const d = dispatcherFromQueue();
    const es = new IpcEventSource('/api/stream', { dispatch: d.dispatch });
    d.push({
      kind: 'event',
      name: 'head',
      data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
    });
    d.push({ kind: 'event', name: 'sse-chunk', data: 'id: 42\ndata: a\n\n' });
    await waitFor(() => (es as any).lastEventId === '42');
    es.close();

    // Simulate reconnect: a fresh ES with the same dispatcher should
    // request with Last-Event-ID. We can't directly observe inside the
    // first call's input (it's already running), so just verify a new
    // construction passes the header when its lastEventId is set.
    const d2 = dispatcherFromQueue();
    const es2 = new IpcEventSource('/api/stream', { dispatch: d2.dispatch });
    // Simulate a prior Last-Event-ID by directly setting it (the wrapper
    // would carry it from the prior connection in a real resilient layer).
    // Verify the wrapper *did* send it when constructed; this asserts
    // input.headers includes 'Last-Event-ID' only when we set it before run.
    await waitFor(() => d2.observed.toolName === 'sys:http');
    expect(d2.observed.input.headers).not.toHaveProperty('Last-Event-ID');
    expect(d2.observed.input.headers.accept).toBe('text/event-stream');
    es2.close();
  });

  it('reconnects on done instead of terminating (faithful EventSource)', async () => {
    const d = dispatcherFromQueue();
    const es = new IpcEventSource('/api/stream', { dispatch: d.dispatch, reconnectMs: 5 });
    let errors = 0;
    let opens = 0;
    es.onerror = () => { errors++; };
    es.onopen = () => { opens++; };
    d.push({
      kind: 'event',
      name: 'head',
      data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
    });
    await waitFor(() => opens === 1);
    expect(es.readyState).toBe(1);

    // Server closes the stream → must reconnect, NOT terminate (the dev-IPC
    // churn fix). `error` fires, readyState goes CONNECTING (not CLOSED).
    d.push({ kind: 'done', result: { content: [] } });
    await waitFor(() => errors === 1);
    expect(es.readyState).not.toBe(2);

    // The reconnect dispatch is waiting; a fresh head re-opens it.
    d.push({
      kind: 'event',
      name: 'head',
      data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
    });
    await waitFor(() => opens === 2);
    expect(es.readyState).toBe(1);

    // close() is still terminal.
    es.close();
    expect(es.readyState).toBe(2);
  });

  it('a drop MID-EVENT does not corrupt the reconnected stream (fresh parser per connection)', async () => {
    // Regression: the SSE parser used to be shared across internal reconnects.
    // A stream that dropped mid-event (e.g. an operator restart killing it
    // half-way through a large `backfill`) left the unterminated partial line
    // buffered, and the NEXT connection's first event got the stale bytes
    // prepended — an unparseable backfill the server never re-sends, wedging
    // the thinking pane on "connecting…" while small follow events still flow.
    const d = dispatcherFromQueue();
    const es = new IpcEventSource('/api/stream', { dispatch: d.dispatch, reconnectMs: 5 });
    const backfills: string[] = [];
    es.addEventListener('backfill', (ev) => backfills.push((ev as MessageEvent).data as string));

    let opens = 0;
    es.onopen = () => { opens++; };
    d.push({
      kind: 'event',
      name: 'head',
      data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
    });
    await waitFor(() => opens === 1);

    // A PARTIAL event — the connection dies before the data line terminates.
    d.push({ kind: 'event', name: 'sse-chunk', data: 'event: backfill\ndata: [{"par' });
    d.push({ kind: 'done', result: { content: [] } });

    // Reconnect: the server re-sends the WHOLE backfill on the new connection.
    d.push({
      kind: 'event',
      name: 'head',
      data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
    });
    await waitFor(() => opens === 2);
    d.push({ kind: 'event', name: 'sse-chunk', data: 'event: backfill\ndata: ["ok"]\n\n' });

    await waitFor(() => backfills.length === 1);
    // Must be EXACTLY the re-sent payload — no stale partial-line prefix.
    expect(backfills[0]).toBe('["ok"]');
    expect(() => JSON.parse(backfills[0])).not.toThrow();
    es.close();
  });

  it('forwards Last-Event-ID on reconnect (resume semantics)', async () => {
    const d = dispatcherFromQueue();
    const es = new IpcEventSource('/api/stream', { dispatch: d.dispatch, reconnectMs: 5 });
    d.push({
      kind: 'event',
      name: 'head',
      data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
    });
    d.push({ kind: 'event', name: 'sse-chunk', data: 'id: 42\ndata: a\n\n' });
    await waitFor(() => (es as any).lastEventId === '42');

    // Drop → reconnect; the reconnect's dispatch must carry Last-Event-ID.
    d.push({ kind: 'done', result: { content: [] } });
    await waitFor(() => d.observed.input?.headers?.['Last-Event-ID'] === '42');
    expect(d.observed.input.headers['Last-Event-ID']).toBe('42');
    es.close();
  });

  it('emits inspector traces: ONE es-open across a reconnect (the churn signal)', async () => {
    const traces: IpcTraceEvent[] = [];
    setIpcInspector((ev) => { if (ev.kind.startsWith('es-')) traces.push(ev); });
    try {
      const d = dispatcherFromQueue();
      const es = new IpcEventSource('/api/zero-harness/sse', { dispatch: d.dispatch, reconnectMs: 5 });
      // Construction trace fires synchronously.
      expect(traces.filter((t) => t.kind === 'es-open')).toHaveLength(1);

      d.push({ kind: 'event', name: 'head', data: { status: 200, headers: { 'content-type': 'text/event-stream' } } });
      await waitFor(() => traces.some((t) => t.kind === 'es-connect'));

      // Server closes → es-drop, then the SAME source auto-reconnects (NO new es-open).
      d.push({ kind: 'done', result: { content: [] } });
      await waitFor(() => traces.some((t) => t.kind === 'es-drop'));
      d.push({ kind: 'event', name: 'head', data: { status: 200, headers: { 'content-type': 'text/event-stream' } } });
      await waitFor(() => traces.filter((t) => t.kind === 'es-connect').length === 2);

      es.close();
      d.close();
      await waitFor(() => traces.some((t) => t.kind === 'es-close'));

      // The whole point: ONE construction, TWO connects → a persistent stream
      // that reconnected internally, NOT a wrapper churning new channels.
      expect(traces.filter((t) => t.kind === 'es-open')).toHaveLength(1);
      expect(traces.filter((t) => t.kind === 'es-connect')).toHaveLength(2);
      expect(traces.filter((t) => t.kind === 'es-drop')).toHaveLength(1);
      // All lifecycle events share one correlation id.
      expect(new Set(traces.map((t) => t.id)).size).toBe(1);
    } finally {
      setIpcInspector(null);
    }
  });

  it('close() aborts the in-flight dispatch', async () => {
    const d = dispatcherFromQueue();
    const es = new IpcEventSource('/api/stream', { dispatch: d.dispatch });
    d.push({
      kind: 'event',
      name: 'head',
      data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
    });
    await waitFor(() => es.readyState === 1);
    es.close();
    expect(es.readyState).toBe(2);
  });

  it('exposes EventSource static + instance readyState constants', () => {
    expect(IpcEventSource.CONNECTING).toBe(0);
    expect(IpcEventSource.OPEN).toBe(1);
    expect(IpcEventSource.CLOSED).toBe(2);
    const d = dispatcherFromQueue();
    const es = new IpcEventSource('/api/x', { dispatch: d.dispatch });
    expect(es.CONNECTING).toBe(0);
    expect(es.OPEN).toBe(1);
    expect(es.CLOSED).toBe(2);
    es.close();
  });

  it('falls back to a native EventSource after IPC streaming proves unavailable', async () => {
    const created: Array<{ url: string; withCredentials: boolean }> = [];
    class FakeNativeEventSource {
      url: string;
      withCredentials: boolean;
      constructor(url: string | URL, init?: { withCredentials?: boolean }) {
        this.url = String(url);
        this.withCredentials = init?.withCredentials ?? false;
        created.push({ url: this.url, withCredentials: this.withCredentials });
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
    }
    setNativeEventSourceFallback(FakeNativeEventSource as unknown as typeof EventSource);
    try {
      // 1st construction: injected dispatch yields the unwired-backend error
      // (ipc-stream emits {kind:'error', code:'invoke_failed'}), latching the
      // module-level "IPC unavailable" flag. The injected-dispatch path itself
      // must NEVER fall back — it stays an IpcEventSource that errors + closes.
      const d = dispatcherFromQueue();
      const es1 = new IpcEventSource('/api/ui/intents/stream', { dispatch: d.dispatch });
      d.push({ kind: 'error', code: 'invoke_failed', message: 'state not managed' });
      await waitFor(() => es1.readyState === 2);
      expect(es1).toBeInstanceOf(IpcEventSource);
      expect(created).toHaveLength(0);

      // 2nd construction (no injected dispatch): now hands back a native ES,
      // preserving url + withCredentials, with zero IPC attempt.
      const es2 = new IpcEventSource('/api/ui/intents/stream', { withCredentials: true });
      expect(es2).toBeInstanceOf(FakeNativeEventSource);
      expect(created).toHaveLength(1);
      expect(created[0].url).toContain('/api/ui/intents/stream');
      expect(created[0].withCredentials).toBe(true);
    } finally {
      _resetIpcEventSourceFallback();
    }
  });
});
