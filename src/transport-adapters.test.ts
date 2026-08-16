/**
 * Transport-adapter unit tests. The HTTP adapter is exercised against
 * a mocked fetch returning a hand-built SSE body; the IPC adapter is
 * exercised against a mocked Tauri Channel.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('dispatchEndpointStreamHttp', () => {
  function makeSseResponse(body: string): Response {
    return new Response(new TextEncoder().encode(body).buffer as ArrayBuffer, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  it('yields events and a terminal done', async () => {
    const body =
      'event: delta\ndata: hi\n\n' +
      'event: delta\ndata: world\n\n' +
      'event: done\ndata: {"content":[{"type":"text","text":"hi world"}]}\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => makeSseResponse(body)));
    const { dispatchEndpointStreamHttp } = await import('./http-stream');
    const events = [];
    for await (const ev of dispatchEndpointStreamHttp('foo:bar', {})) {
      events.push(ev);
    }
    expect(events.map((e) => e.kind)).toEqual(['event', 'event', 'done']);
    expect((events[0] as { name: string; data: unknown }).data).toBe('hi');
    expect((events[1] as { name: string; data: unknown }).data).toBe('world');
  });

  it('yields error and terminates on event: error', async () => {
    const body =
      'event: delta\ndata: partial\n\n' +
      'event: error\ndata: {"code":"oops","message":"bad"}\n\n' +
      // This delta should never be yielded — we terminated.
      'event: delta\ndata: never\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => makeSseResponse(body)));
    const { dispatchEndpointStreamHttp } = await import('./http-stream');
    const events = [];
    for await (const ev of dispatchEndpointStreamHttp('foo:bar', {})) {
      events.push(ev);
    }
    expect(events.map((e) => e.kind)).toEqual(['event', 'error']);
    expect((events[1] as { code: string; message: string }).code).toBe('oops');
  });

  it('parses raw-text data when JSON parse fails (z.string() events)', async () => {
    const body = 'event: delta\ndata: hello\n\nevent: done\ndata: {"content":[]}\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => makeSseResponse(body)));
    const { dispatchEndpointStreamHttp } = await import('./http-stream');
    const events = [];
    for await (const ev of dispatchEndpointStreamHttp('a:b', {})) {
      events.push(ev);
    }
    expect((events[0] as { data: unknown }).data).toBe('hello');
  });

  it('yields http error on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    ));
    const { dispatchEndpointStreamHttp } = await import('./http-stream');
    const events = [];
    for await (const ev of dispatchEndpointStreamHttp('a:b', {})) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('error');
    expect((events[0] as { code: string }).code).toBe('http_403');
  });

  it('detects the binary envelope and yields kind: binary with Uint8Array', async () => {
    // PR F (audit item 14): cross-transport binary unification. HTTP
    // wire carries the self-describing envelope; consumer normalizes
    // to the same shape as IPC.
    const body =
      'event: chunk\ndata: {"$papercuspBinary":true,"encoding":"base64","data":"3q2+7w=="}\n\n' +
      'event: done\ndata: []\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => makeSseResponse(body)));
    const { dispatchEndpointStreamHttp } = await import('./http-stream');
    const events = [];
    for await (const ev of dispatchEndpointStreamHttp('foo:bar', {})) {
      events.push(ev);
    }
    const bin = events.find((e) => e.kind === 'binary');
    expect(bin).toBeDefined();
    expect((bin as { name: string }).name).toBe('chunk');
    const data = (bin as { data: Uint8Array }).data;
    expect(data).toBeInstanceOf(Uint8Array);
    expect(Array.from(data)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('overrideUrl bypasses the default /api/agent-tools/<name> path', async () => {
    const fetchSpy = vi.fn(async () => makeSseResponse('event: done\ndata: {}\n\n'));
    vi.stubGlobal('fetch', fetchSpy);
    const { dispatchEndpointStreamHttp } = await import('./http-stream');
    const events = [];
    for await (const ev of dispatchEndpointStreamHttp(
      'operator:scan',
      { promptText: 'x' },
      { overrideUrl: '/api/agent-mcp/operator-scan' },
    )) {
      events.push(ev);
    }
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/agent-mcp/operator-scan',
      expect.any(Object),
    );
  });
});

describe('transport picker', () => {
  it('uses HTTP outside Tauri', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: undefined } as unknown as Window);
    vi.doMock('./http-stream', () => ({
      dispatchEndpointStreamHttp: async function* () {
        yield { kind: 'event', name: 'tag', data: 'http' };
        yield { kind: 'done', result: { content: [] } };
      },
    }));
    vi.doMock('./ipc-stream', () => ({
      dispatchEndpointStreamIpc: async function* () {
        yield { kind: 'event', name: 'tag', data: 'ipc' };
        yield { kind: 'done', result: { content: [] } };
      },
    }));
    const { dispatchEndpointStream } = await import('./index');
    const events = [];
    for await (const ev of dispatchEndpointStream('x:y', {})) {
      events.push(ev);
    }
    expect((events[0] as { data: unknown }).data).toBe('http');
  });

  it('uses IPC inside Tauri', async () => {
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: { invoke: () => Promise.resolve() },
    } as unknown as Window);
    vi.doMock('./http-stream', () => ({
      dispatchEndpointStreamHttp: async function* () {
        yield { kind: 'event', name: 'tag', data: 'http' };
        yield { kind: 'done', result: { content: [] } };
      },
    }));
    vi.doMock('./ipc-stream', () => ({
      dispatchEndpointStreamIpc: async function* () {
        yield { kind: 'event', name: 'tag', data: 'ipc' };
        yield { kind: 'done', result: { content: [] } };
      },
    }));
    const { dispatchEndpointStream } = await import('./index');
    const events = [];
    for await (const ev of dispatchEndpointStream('x:y', {})) {
      events.push(ev);
    }
    expect((events[0] as { data: unknown }).data).toBe('ipc');
  });

  it('DESKTOP_IPC_FORCE_HTTP=1 flips Tauri to HTTP', async () => {
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: { invoke: () => Promise.resolve() },
    } as unknown as Window);
    vi.stubEnv('DESKTOP_IPC_FORCE_HTTP', '1');
    vi.doMock('./http-stream', () => ({
      dispatchEndpointStreamHttp: async function* () {
        yield { kind: 'event', name: 'tag', data: 'http' };
        yield { kind: 'done', result: { content: [] } };
      },
    }));
    vi.doMock('./ipc-stream', () => ({
      dispatchEndpointStreamIpc: async function* () {
        yield { kind: 'event', name: 'tag', data: 'ipc' };
        yield { kind: 'done', result: { content: [] } };
      },
    }));
    const { dispatchEndpointStream } = await import('./index');
    const events = [];
    for await (const ev of dispatchEndpointStream('x:y', {})) {
      events.push(ev);
    }
    expect((events[0] as { data: unknown }).data).toBe('http');
  });
});
