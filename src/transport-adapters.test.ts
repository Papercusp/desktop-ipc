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

describe('raw Tauri Channel binary messages (WI-5911)', () => {
  function rawEvent(name: string, data: number[]): ArrayBuffer {
    const nameBytes = new TextEncoder().encode(name);
    const bytes = new Uint8Array(12 + nameBytes.length + data.length);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, 42n, false); // routing id is consumed by Rust; JS ignores it
    view.setUint32(8, nameBytes.length, false);
    bytes.set(nameBytes, 12);
    bytes.set(data, 12 + nameBytes.length);
    return bytes.buffer;
  }

  it('decodes the reused EVENT_BIN payload as a zero-copy Uint8Array view', async () => {
    const { decodeRawBinaryEvent } = await import('./ipc-stream');
    const raw = rawEvent('body', [0xde, 0xad, 0xbe, 0xef]);

    const event = decodeRawBinaryEvent(raw);

    expect(event.kind).toBe('binary');
    expect(event.name).toBe('body');
    expect(Array.from(event.data)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(event.data.buffer).toBe(raw);
  });

  it('preserves typed-array offsets and accepts JSON-decoded numeric byte arrays', async () => {
    const { decodeRawBinaryEvent } = await import('./ipc-stream');
    const raw = new Uint8Array(rawEvent('body', [0xde, 0xad, 0xbe, 0xef]));
    const padded = new Uint8Array(raw.byteLength + 7);
    padded.set(raw, 3);

    const fromView = decodeRawBinaryEvent(padded.subarray(3, 3 + raw.byteLength));
    const fromNumbers = decodeRawBinaryEvent(Array.from(raw));

    expect(Array.from(fromView.data)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(fromView.data.buffer).toBe(padded.buffer);
    expect(fromView.data.byteOffset).toBe(3 + 12 + 'body'.length);
    expect(Array.from(fromNumbers.data)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('dispatches a numeric-array raw body before the terminal done event', async () => {
    const raw = rawEvent('body', [0xde, 0xad, 0xbe, 0xef]);
    vi.doMock('@tauri-apps/api/core', () => ({
      Channel: class MockChannel<T> {
        onmessage: ((message: T) => void) | null = null;
      },
      invoke: vi.fn(async (command: string, args?: {
        channel?: { onmessage: ((message: unknown) => void) | null };
      }) => {
        if (command === 'endpoint_invoke') {
          args?.channel?.onmessage?.(Array.from(new Uint8Array(raw)));
          args?.channel?.onmessage?.({ kind: 'done', result: { content: [] } });
          return 42;
        }
        return undefined;
      }),
    }));
    const { dispatchEndpointStreamIpc } = await import('./ipc-stream');

    const events = [];
    for await (const event of dispatchEndpointStreamIpc('plans:get', {})) {
      events.push(event);
    }

    expect(events.map((event) => event.kind)).toEqual(['binary', 'done']);
    expect((events[0] as { name: string }).name).toBe('body');
    expect(Array.from((events[0] as { data: Uint8Array }).data)).toEqual([
      0xde, 0xad, 0xbe, 0xef,
    ]);
  });

  it('rejects truncated and name-overflow raw frames instead of hanging the stream', async () => {
    const { decodeRawBinaryEvent } = await import('./ipc-stream');
    expect(() => decodeRawBinaryEvent(new ArrayBuffer(11))).toThrow(/too short/);

    const overflow = new ArrayBuffer(12);
    new DataView(overflow).setUint32(8, 99, false);
    expect(() => decodeRawBinaryEvent(overflow)).toThrow(/name length 99 exceeds/);
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
