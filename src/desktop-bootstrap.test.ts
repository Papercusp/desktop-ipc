import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDesktopIpcPolyfills, _resetForTests } from './desktop-bootstrap';
import { IpcEventSource } from './ipc-event-source';

/* Tests run in Node (no real window). We synthesize a minimal window
 * + tauri-internals shape so the install path executes. */

interface TestWindow {
  __TAURI_INTERNALS__?: { invoke?: () => void };
  location?: { origin: string };
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
}

let originalGlobalFetch: typeof fetch | undefined;
let originalGlobalES: typeof EventSource | undefined;
let originalWindow: unknown;

beforeEach(() => {
  _resetForTests();
  originalGlobalFetch = globalThis.fetch;
  originalGlobalES = globalThis.EventSource;
  originalWindow = (globalThis as { window?: unknown }).window;

  const fakeFetch = vi.fn(async () => new Response('native', { status: 200 }));
  class NativeES {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly url: string;
    constructor(url: string) {
      this.url = url;
    }
    close() {}
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {
      return true;
    }
  }

  const win: TestWindow = {
    __TAURI_INTERNALS__: { invoke: () => {} },
    location: { origin: 'http://localhost:3055' },
    fetch: fakeFetch as unknown as typeof fetch,
    EventSource: NativeES as unknown as typeof EventSource,
  };
  (globalThis as { window?: unknown }).window = win;
});

afterEach(() => {
  _resetForTests();
  (globalThis as { window?: unknown }).window = originalWindow;
  if (originalGlobalFetch) globalThis.fetch = originalGlobalFetch;
  if (originalGlobalES) globalThis.EventSource = originalGlobalES;
});

describe('installDesktopIpcPolyfills', () => {
  it('returns null when not running under Tauri', () => {
    (globalThis as { window?: TestWindow }).window!.__TAURI_INTERNALS__ = undefined;
    expect(installDesktopIpcPolyfills()).toBeNull();
  });

  it('returns null when FORCE_HTTP_TRANSPORT is set', () => {
    const prev = process.env.NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT;
    process.env.NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT = '1';
    try {
      expect(installDesktopIpcPolyfills()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT;
      else process.env.NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT = prev;
    }
  });

  it('is idempotent — second call returns null and does not double-patch', () => {
    const win = (globalThis as { window?: TestWindow }).window!;
    const originalFetch = win.fetch;
    const h1 = installDesktopIpcPolyfills();
    expect(h1).not.toBeNull();
    const patched = win.fetch;
    const h2 = installDesktopIpcPolyfills();
    expect(h2).toBeNull();
    expect(win.fetch).toBe(patched);
    h1!.uninstall();
    expect(win.fetch).toBe(originalFetch);
  });

  it('replaces window.EventSource with IpcEventSource', () => {
    const win = (globalThis as { window?: TestWindow }).window!;
    const NativeES = win.EventSource;
    const handle = installDesktopIpcPolyfills();
    expect(handle).not.toBeNull();
    expect(win.EventSource).toBe(IpcEventSource);
    expect(win.EventSource).not.toBe(NativeES);
    handle!.uninstall();
    expect(win.EventSource).toBe(NativeES);
  });

  it('patches fetch so same-origin /api/* routes through ipcFetch', async () => {
    const win = (globalThis as { window?: TestWindow }).window!;
    const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;
    const handle = installDesktopIpcPolyfills();

    // Cross-origin → native
    await win.fetch!('https://api.posthog.com/track');
    expect(fakeFetch).toHaveBeenCalledTimes(1);

    // Same-origin non-/api/* → native
    await win.fetch!('/_next/static/chunk.js');
    expect(fakeFetch).toHaveBeenCalledTimes(2);

    // Same-origin /api/* → ipcFetch (not the original). The original
    // mock should NOT have been called for this one. ipcFetch will
    // throw because there's no real Tauri to invoke through; we catch
    // and verify the original fetch wasn't called.
    let routedThroughIpc = false;
    try {
      await win.fetch!('/api/foo');
    } catch {
      routedThroughIpc = true;
    }
    expect(routedThroughIpc).toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(2); // unchanged

    handle!.uninstall();
  });

  it('passes Request-form inputs straight to native fetch (Phase 1 limitation)', async () => {
    const win = (globalThis as { window?: TestWindow }).window!;
    const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;
    installDesktopIpcPolyfills();

    // Request-form goes native even for same-origin /api/* — documented
    // limitation. (We avoid the complexity of converting a Request to
    // string + init faithfully.)
    const reqLike = { url: 'http://localhost:3055/api/x', method: 'POST' };
    Object.setPrototypeOf(reqLike, Request.prototype);
    await win.fetch!(reqLike as unknown as Request);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});
