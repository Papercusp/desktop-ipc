import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDesktopIpcPolyfills, isIpcUnavailable, _resetForTests } from './desktop-bootstrap';
import { IpcEventSource } from './ipc-event-source';

describe('isIpcUnavailable — IPC-down detection that gates the native-HTTP fallback', () => {
  it('matches the in-process "state not managed" / "invoke_failed" signals', () => {
    expect(isIpcUnavailable(new Error('endpoint_invoke: state not managed'))).toBe(true);
    expect(isIpcUnavailable(new Error('invoke_failed: foo'))).toBe(true);
  });
  it('matches the WebKit "access control checks" rejection of the ipc:// invoke fetch (the desktop-load bug)', () => {
    expect(
      isIpcUnavailable(new Error('Fetch API cannot load ipc://localhost/endpoint_invoke due to access control checks')),
    ).toBe(true);
  });
  it('does NOT match real upstream errors (those must surface, not fall back)', () => {
    expect(isIpcUnavailable(new Error('upstream_error: 500'))).toBe(false);
    expect(isIpcUnavailable(new Error('aborted'))).toBe(false);
  });
});

/* Tests run in Node (no real window). We synthesize a minimal window
 * + tauri-internals shape so the install path executes. */

interface TestWindow {
  __TAURI_INTERNALS__?: { invoke?: () => void };
  location?: { origin: string };
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
  console?: Console;
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

  it('returns null when the force-HTTP escape hatch is set', () => {
    const prev = process.env.DESKTOP_IPC_FORCE_HTTP;
    process.env.DESKTOP_IPC_FORCE_HTTP = '1';
    try {
      expect(installDesktopIpcPolyfills()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.DESKTOP_IPC_FORCE_HTTP;
      else process.env.DESKTOP_IPC_FORCE_HTTP = prev;
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

  it('routes same-origin /api/desktop/* via NATIVE fetch, NOT ipcFetch (content-origin endpoints must hit the operator serving THIS webview)', async () => {
    const win = (globalThis as { window?: TestWindow }).window!;
    const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;
    const handle = installDesktopIpcPolyfills();

    // /api/desktop/dev-operators describes the LOCAL operator — IPC-rerouting it
    // to the (possibly different) IPC-owning operator makes it 404 + the env
    // switcher bar silently self-hides. So it MUST go straight to native fetch.
    const res = await win.fetch!('/api/desktop/dev-operators');
    expect(await res.text()).toBe('native');
    expect(fakeFetch).toHaveBeenCalledTimes(1);

    // Sibling desktop endpoints (version / setup-wizard / voice-config) too.
    await win.fetch!('/api/desktop/version');
    expect(fakeFetch).toHaveBeenCalledTimes(2);

    // Contrast: a NON-desktop /api/* still routes through ipcFetch — the heavy
    // shared traffic keeps the libsoup SSE-starvation fix; native NOT called.
    try {
      await win.fetch!('/api/work-items');
    } catch {
      /* ipcFetch throws (no real Tauri to invoke through) */
    }
    expect(fakeFetch).toHaveBeenCalledTimes(2); // unchanged → went to ipcFetch

    handle!.uninstall();
  });

  it('rejects ipc:// custom-protocol fetches WITHOUT hitting native fetch (kills the WebKitGTK "access control checks" error)', async () => {
    const win = (globalThis as { window?: TestWindow }).window!;
    const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;
    installDesktopIpcPolyfills();

    // Tauri's IPC init script issues this exact fetch; on remote-origin WebKitGTK it would
    // otherwise flood the console. We reject it (Tauri retries over postMessage) and NEVER
    // call native fetch — so the engine never logs the access-control error.
    let rejected = false;
    try {
      await win.fetch!('ipc://localhost/endpoint_invoke');
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(fakeFetch).not.toHaveBeenCalled(); // native fetch never issued for ipc://
  });

  it('filters Tauri\'s "IPC custom protocol failed" warn but passes every other warning through', () => {
    const win = (globalThis as { window?: TestWindow }).window!;
    const realWarn = vi.fn();
    (win as unknown as { console: Console }).console = { warn: realWarn } as unknown as Console;

    const handle = installDesktopIpcPolyfills();
    win.console!.warn('IPC custom protocol failed, Tauri will now use the postMessage interface instead', {});
    win.console!.warn('some other warning');
    expect(realWarn).toHaveBeenCalledTimes(1);
    expect(realWarn).toHaveBeenCalledWith('some other warning');

    handle!.uninstall();
    win.console!.warn('IPC custom protocol failed, …'); // restored → passes through now
    expect(realWarn).toHaveBeenCalledTimes(2);
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
