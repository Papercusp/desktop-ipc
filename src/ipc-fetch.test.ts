import { describe, expect, it } from 'vitest';
import { ipcFetch } from './ipc-fetch';
import type { DispatchEndpointStreamFn, EndpointStreamEvent } from './types';

function dispatcher(events: EndpointStreamEvent[]): DispatchEndpointStreamFn {
  return async function* () {
    for (const ev of events) yield ev;
  };
}

function aborting(): DispatchEndpointStreamFn {
  return async function* () {
    yield { kind: 'error', code: 'aborted', message: 'aborted' };
  };
}

const dec = new TextDecoder();

describe('ipcFetch', () => {
  it('reassembles head + body chunks into a Response', async () => {
    const dispatch = dispatcher([
      {
        kind: 'event',
        name: 'head',
        data: { status: 200, headers: { 'content-type': 'application/json' } },
      },
      { kind: 'binary', name: 'body', data: new TextEncoder().encode('{"ok":true}') },
      { kind: 'done', result: { content: [] } },
    ]);

    const res = await ipcFetch('/api/foo', {}, { dispatch });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('forwards non-200 status without throwing', async () => {
    const dispatch = dispatcher([
      {
        kind: 'event',
        name: 'head',
        data: { status: 404, headers: { 'content-type': 'text/plain' } },
      },
      { kind: 'binary', name: 'body', data: new TextEncoder().encode('not found') },
      { kind: 'done', result: { content: [] } },
    ]);

    const res = await ipcFetch('/api/missing', {}, { dispatch });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');
  });

  it('concatenates multiple body chunks in order', async () => {
    const dispatch = dispatcher([
      {
        kind: 'event',
        name: 'head',
        data: { status: 200, headers: { 'content-type': 'text/plain' } },
      },
      { kind: 'binary', name: 'body', data: new TextEncoder().encode('hello ') },
      { kind: 'binary', name: 'body', data: new TextEncoder().encode('world') },
      { kind: 'done', result: { content: [] } },
    ]);

    const res = await ipcFetch('/api/x', {}, { dispatch });
    expect(await res.text()).toBe('hello world');
  });

  it('throws AbortError when the bridge reports aborted', async () => {
    await expect(ipcFetch('/api/x', {}, { dispatch: aborting() })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('throws TypeError on upstream_error', async () => {
    const dispatch = dispatcher([
      { kind: 'error', code: 'upstream_error', message: 'econnrefused' },
    ]);
    await expect(ipcFetch('/api/x', {}, { dispatch })).rejects.toThrow(/upstream_error/);
  });

  it('throws TypeError when stream ends without a head event', async () => {
    const dispatch = dispatcher([{ kind: 'done', result: { content: [] } }]);
    await expect(ipcFetch('/api/x', {}, { dispatch })).rejects.toThrow(/head event/);
  });

  it('rejects synchronously when handed an already-aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      ipcFetch('/api/x', { signal: ctrl.signal }, { dispatch: dispatcher([]) }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('forwards method, headers, and string body to the bridge', async () => {
    const observed: { toolName?: string; input?: unknown } = {};
    const dispatch: DispatchEndpointStreamFn = async function* (toolName, input) {
      observed.toolName = toolName;
      observed.input = input;
      yield {
        kind: 'event',
        name: 'head',
        data: { status: 200, headers: { 'content-type': 'application/json' } },
      };
      yield { kind: 'binary', name: 'body', data: new TextEncoder().encode('{}') };
      yield { kind: 'done', result: { content: [] } };
    };

    await ipcFetch(
      '/api/echo',
      { method: 'POST', headers: { 'x-thing': 'a' }, body: '{"k":1}' },
      { dispatch },
    );

    expect(observed.toolName).toBe('sys:http');
    expect(observed.input).toMatchObject({
      method: 'POST',
      path: '/api/echo',
      headers: { 'x-thing': 'a' },
      body: '{"k":1}',
    });
  });

  it('rejects non-string request bodies in Phase 1', async () => {
    await expect(
      ipcFetch('/api/x', { method: 'POST', body: new Uint8Array([1, 2, 3]) }, {
        dispatch: dispatcher([]),
      }),
    ).rejects.toThrow(/string request bodies/);
  });

  it('streams an SSE (text/event-stream) response body as bytes', async () => {
    // SSE-over-POST can't use IpcEventSource (that's GET-only), so the
    // oracle/agent-chat bubbles read this body incrementally via
    // res.body.getReader(). The whole wire output must round-trip.
    const dispatch = dispatcher([
      {
        kind: 'event',
        name: 'head',
        data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
      },
      { kind: 'event', name: 'sse-chunk', data: 'data: a\n\n' },
      { kind: 'event', name: 'sse-chunk', data: 'data: b\n\n' },
      { kind: 'done', result: { content: [] } },
    ]);
    const res = await ipcFetch('/api/stream', {}, { dispatch });
    expect(await res.text()).toBe('data: a\n\ndata: b\n\n');
  });

  it('streams sse-chunks incrementally — Response resolves at head, chunks arrive one at a time', async () => {
    // The regression this guards: the prior impl buffered the whole SSE
    // response to DONE before resolving the Response, so chat replies
    // rendered all at once. The body must now yield each sse-chunk
    // separately, before DONE.
    const dispatch = dispatcher([
      {
        kind: 'event',
        name: 'head',
        data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
      },
      { kind: 'event', name: 'sse-chunk', data: 'data: a\n\n' },
      { kind: 'event', name: 'sse-chunk', data: 'data: b\n\n' },
      { kind: 'done', result: { content: [] } },
    ]);
    const res = await ipcFetch('/api/stream', {}, { dispatch });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    expect(dec.decode((await reader.read()).value)).toBe('data: a\n\n');
    expect(dec.decode((await reader.read()).value)).toBe('data: b\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  it('errors the body stream on a mid-stream error after head', async () => {
    const dispatch = dispatcher([
      {
        kind: 'event',
        name: 'head',
        data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
      },
      { kind: 'event', name: 'sse-chunk', data: 'data: a\n\n' },
      { kind: 'error', code: 'stream_error', message: 'boom' },
    ]);
    const res = await ipcFetch('/api/stream', {}, { dispatch });
    const reader = res.body!.getReader();
    expect(dec.decode((await reader.read()).value)).toBe('data: a\n\n');
    await expect(reader.read()).rejects.toThrow(/stream_error/);
  });

  it('cancelling the body aborts the upstream call (no leaked spawn)', async () => {
    let captured: AbortSignal | undefined;
    const dispatch: DispatchEndpointStreamFn = async function* (_t, _i, options) {
      captured = options?.signal;
      yield {
        kind: 'event',
        name: 'head',
        data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
      };
      yield { kind: 'event', name: 'sse-chunk', data: 'data: a\n\n' };
      // Hang until aborted so the consumer can cancel mid-stream.
      await new Promise<void>((resolve) => {
        if (captured?.aborted) resolve();
        else captured?.addEventListener('abort', () => resolve(), { once: true });
      });
    };
    const res = await ipcFetch('/api/stream', {}, { dispatch });
    const reader = res.body!.getReader();
    expect(dec.decode((await reader.read()).value)).toBe('data: a\n\n');
    await reader.cancel();
    expect(captured?.aborted).toBe(true);
  });
});
