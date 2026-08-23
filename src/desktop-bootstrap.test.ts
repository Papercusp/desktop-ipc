import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDesktopIpcPolyfills, isIpcUnavailable, _resetForTests } from './desktop-bootstrap';
import { configureDesktopIpc } from './config';
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
  location?: { origin: string; href?: string };
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

  it('keeps a remote HTTPS Server document on browser HTTP/SSE even when Tauri internals are injected', async () => {
    const win = (globalThis as { window?: TestWindow }).window!;
    win.location = {
      origin: 'https://localhost:19443',
      href: 'https://localhost:19443/harness?ws=papercusp-workspace',
    };
    const originalFetch = win.fetch;
    const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;

    expect(installDesktopIpcPolyfills()).toBeNull();
    expect(win.fetch).toBe(originalFetch);
    // The passive egress monitor may wrap the native constructor in every
    // shell. What matters is that the remote document did not install the IPC
    // transport itself.
    expect(win.EventSource).not.toBe(IpcEventSource);

    const response = await win.fetch!('/api/pots');
    expect(await response.text()).toBe('native');
    expect(fakeFetch).toHaveBeenCalledWith('/api/pots');
  });

  it('does not treat a credentialed HTTPS URL as an allowed remote Server document', () => {
    const win = (globalThis as { window?: TestWindow }).window!;
    win.location = {
      origin: 'https://server.example.com',
      href: 'https://user:secret@server.example.com/',
    };

    const handle = installDesktopIpcPolyfills();
    expect(handle).not.toBeNull();
    handle!.uninstall();
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

  it('with NO content-origin capability configured, routes /api/desktop/* via NATIVE fetch (the conservative default)', async () => {
    const win = (globalThis as { window?: TestWindow }).window!;
    const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;
    const handle = installDesktopIpcPolyfills();

    // /api/desktop/dev-operators describes the LOCAL operator — IPC-rerouting it
    // to the (possibly different) IPC-owning operator makes it 404 + the env
    // switcher bar silently self-hides. Absent a host-supplied capability proving
    // the IPC owner IS this document's operator, we cannot tell those apart, so
    // the unconfigured default stays native. D-008 gates the IPC route on that
    // capability rather than excluding the prefix unconditionally.
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

  /**
   * D-008: `/api/desktop/*` used to be excluded from the IPC reroute
   * unconditionally, on every platform, forever. Measured in a live shell, that
   * one line was the ENTIRE source of webview HTTP egress — escapes recurring on
   * the 30 s poll tick ~30 s after the polyfill installed, i.e. never the startup
   * race P-011 blamed. The prefix now rides IPC whenever the host can PROVE the
   * bridge's owner is the operator that served this document.
   */
  describe('D-008 — /api/desktop/* rides IPC when the bridge owner is provably the content origin', () => {
    afterEach(() => {
      // `cfg` is module-scoped and outlives _resetForTests(); clearing the
      // resolver keeps these cases from leaking into the suite's other tests.
      configureDesktopIpc({ ipcOwnerIsContentOrigin: undefined });
    });

    it('routes /api/desktop/* over IPC (native NOT called) once the owner is proven to be the content origin', async () => {
      const win = (globalThis as { window?: TestWindow }).window!;
      const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;
      configureDesktopIpc({ ipcOwnerIsContentOrigin: () => true });
      const handle = installDesktopIpcPolyfills();

      // ipcFetch throws (no real Tauri to invoke through); what matters is that
      // the request went to IPC and NOT to the native transport.
      let routedThroughIpc = false;
      try {
        await win.fetch!('/api/desktop/dev-operators');
      } catch {
        routedThroughIpc = true;
      }
      expect(routedThroughIpc).toBe(true);
      expect(fakeFetch).not.toHaveBeenCalled();

      handle!.uninstall();
    });

    it('keeps /api/desktop/* on native when the bridge owner is a DIFFERENT operator — the case the carve-out existed for', async () => {
      const win = (globalThis as { window?: TestWindow }).window!;
      const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;
      configureDesktopIpc({ ipcOwnerIsContentOrigin: () => false });
      const handle = installDesktopIpcPolyfills();

      // This is the dev-box shape the original exclusion protected: routing here
      // would 404 against a foreign build and silently hide the env-switcher bar.
      const res = await win.fetch!('/api/desktop/dev-operators');
      expect(await res.text()).toBe('native');
      expect(fakeFetch).toHaveBeenCalledTimes(1);

      handle!.uninstall();
    });

    it('a THROWING capability resolver falls back to native, never to IPC (the asymmetric failure direction)', async () => {
      const win = (globalThis as { window?: TestWindow }).window!;
      const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;
      configureDesktopIpc({
        ipcOwnerIsContentOrigin: () => {
          throw new Error('endpoint_ipc_status unavailable');
        },
      });
      const handle = installDesktopIpcPolyfills();

      // A resolver that throws must NOT be read as "same operator": a false
      // positive routes to the wrong operator and reintroduces the silent 404,
      // while a false negative costs exactly one native request.
      const res = await win.fetch!('/api/desktop/version');
      expect(await res.text()).toBe('native');
      expect(fakeFetch).toHaveBeenCalledTimes(1);

      handle!.uninstall();
    });

    it('resolves the capability ONCE for a burst of first-paint calls, not once per request', async () => {
      const win = (globalThis as { window?: TestWindow }).window!;
      const resolver = vi.fn(async () => false);
      configureDesktopIpc({ ipcOwnerIsContentOrigin: resolver });
      const handle = installDesktopIpcPolyfills();

      // P-002 measured 87 keys in one hydration wave; a per-request invoke would
      // turn one filesystem read into a stampede.
      await Promise.all([
        win.fetch!('/api/desktop/version'),
        win.fetch!('/api/desktop/dev-operators'),
        win.fetch!('/api/desktop/telemetry-config'),
      ]);
      expect(resolver).toHaveBeenCalledTimes(1);

      handle!.uninstall();
    });

    it('announces the declared HTTP exemption ONCE per path, not once per 30s poll', async () => {
      const win = (globalThis as { window?: TestWindow }).window!;
      const realWarn = vi.fn();
      (win as unknown as { console: Console }).console = { warn: realWarn } as unknown as Console;
      configureDesktopIpc({ ipcOwnerIsContentOrigin: () => false });
      const handle = installDesktopIpcPolyfills();

      // D-005 wants every surviving HTTP route visible; these callers poll every
      // 30s, so an unconditional log would emit thousands of identical lines and
      // become its own kind of silence. One line per distinct path.
      await win.fetch!('/api/desktop/version');
      await win.fetch!('/api/desktop/version');
      await win.fetch!('/api/desktop/version');
      const versionWarns = realWarn.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('/api/desktop/version'),
      );
      expect(versionWarns).toHaveLength(1);
      expect(versionWarns[0][0]).toContain('DECLARED HTTP EXEMPTION');

      // A DIFFERENT path still gets its own announcement.
      await win.fetch!('/api/desktop/git-pipeline');
      expect(
        realWarn.mock.calls.filter(
          (c) => typeof c[0] === 'string' && c[0].includes('/api/desktop/git-pipeline'),
        ),
      ).toHaveLength(1);

      handle!.uninstall();
    });

    it('leaves NON-desktop /api/* on IPC regardless of the capability verdict', async () => {
      const win = (globalThis as { window?: TestWindow }).window!;
      const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;
      configureDesktopIpc({ ipcOwnerIsContentOrigin: () => false });
      const handle = installDesktopIpcPolyfills();

      // The heavy shared traffic is not content-origin-scoped, so a foreign-owner
      // verdict must never push it back onto the libsoup pool.
      try {
        await win.fetch!('/api/work-items');
      } catch {
        /* ipcFetch throws — no real Tauri */
      }
      expect(fakeFetch).not.toHaveBeenCalled();

      handle!.uninstall();
    });
  });

  /**
   * WI-6618 (plan no-http-anywhere-2026-07-28, P-009).
   *
   * The Request form used to fall straight through to native fetch — a
   * documented "Phase 1 limitation" whose real-world meaning was SILENT HTTP
   * EGRESS from the webview, the exact thing D-005 forbids. It was invisible
   * because it worked: the request succeeded, just over the transport the plan
   * exists to eliminate.
   *
   * The old test for this asserted the limitation using a prototype-hacked
   * plain object (`Object.setPrototypeOf({...}, Request.prototype)`). That fake
   * is not constructible by `new Request(...)`, so it passed for a reason
   * unrelated to the rule it claimed to check — it exercised the conversion's
   * FAILURE path, not the Request path. These use real Requests.
   */
  describe('Request-form inputs (WI-6618 / P-009)', () => {
    it('routes a same-origin /api Request over IPC, NOT native', async () => {
      const win = (globalThis as { window?: TestWindow }).window!;
      const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;
      installDesktopIpcPolyfills();

      // Same shape as the string-form test above: ipcFetch throws (no real
      // Tauri to invoke through), and the point is that native was not used.
      let routedThroughIpc = false;
      try {
        await win.fetch!(new Request('http://localhost:3055/api/x', { method: 'POST', body: '{"a":1}' }));
      } catch {
        routedThroughIpc = true;
      }
      expect(routedThroughIpc).toBe(true);
      expect(fakeFetch).not.toHaveBeenCalled();
    });

    it('leaves a same-origin NON-/api Request on native', async () => {
      const win = (globalThis as { window?: TestWindow }).window!;
      const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;
      installDesktopIpcPolyfills();

      await win.fetch!(new Request('http://localhost:3055/_next/static/chunk.js'));
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    });

    it('leaves a cross-origin Request on native', async () => {
      const win = (globalThis as { window?: TestWindow }).window!;
      const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;
      installDesktopIpcPolyfills();

      await win.fetch!(new Request('https://api.posthog.com/track', { method: 'POST', body: 'x' }));
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    });

    it('FAILS LOUD rather than silently using HTTP when a same-origin /api Request cannot be converted (D-005)', async () => {
      const win = (globalThis as { window?: TestWindow }).window!;
      const fakeFetch = win.fetch as ReturnType<typeof vi.fn>;
      installDesktopIpcPolyfills();

      // A Request whose body has already been consumed cannot be re-read, so
      // `new Request(input, init)` throws. The failure direction is the whole
      // point: quietly reverting to HTTP here would reintroduce the bug while
      // looking perfectly healthy.
      const consumed = new Request('http://localhost:3055/api/x', { method: 'POST', body: 'once' });
      await consumed.text();

      await expect(win.fetch!(consumed)).rejects.toThrow(/HTTP fallback is disabled|could not be cloned/);
      expect(fakeFetch).not.toHaveBeenCalled();
    });
  });
});

/**
 * The egress detector must SURVIVE the guards that skip the polyfills.
 *
 * These exist because the first packaged run of the perf suite reported
 * `webview-http-egress = -1` — the "detector absent" sentinel — from a shell that
 * was talking HTTP the whole time. `installEgressMonitor` had been called AFTER
 * `if (!isTauri() || isForceHttp()) return null`, i.e. inside the very branch it
 * audits, so the one configuration where egress is guaranteed was the one
 * configuration where the detector could not speak.
 *
 * Note what was and was not covered before: `classifyEgress` — the RULE — had
 * thorough unit tests, including a fixture reproducing the real 9-request wave.
 * Every one of them passed while the detector was, in practice, never installed.
 * The rule was right and the wiring was wrong, so the tests below assert the
 * WIRING: not "what does the monitor conclude" but "is the monitor there at all".
 */
describe('egress detector installs regardless of transport branch', () => {
  interface FakeEntry {
    name: string;
    startTime: number;
    duration: number;
  }
  let deliver: ((entries: FakeEntry[]) => void) | null = null;
  let originalPO: unknown;

  beforeEach(() => {
    originalPO = (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver;
    class FakePO {
      constructor(private readonly cb: (list: { getEntries: () => FakeEntry[] }) => void) {
        deliver = (entries: FakeEntry[]) => this.cb({ getEntries: () => entries });
      }
      observe() {}
      disconnect() {
        deliver = null;
      }
    }
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = FakePO;
  });

  afterEach(() => {
    deliver = null;
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = originalPO;
    delete (globalThis as unknown as { window?: Record<string, unknown> }).window
      ?.__papercusp_egress__;
  });

  const egressHandle = () =>
    (globalThis as { window?: { __papercusp_egress__?: { report: () => { total: number } } } })
      .window?.__papercusp_egress__;

  it('installs the monitor even when NOT under Tauri (the branch that returned early)', () => {
    (globalThis as { window?: TestWindow }).window!.__TAURI_INTERNALS__ = undefined;

    expect(installDesktopIpcPolyfills()).toBeNull(); // polyfills still correctly skipped
    expect(egressHandle(), 'detector must be present even with no polyfills').toBeDefined();
    expect(egressHandle()!.report().total).toBe(0);
  });

  it('installs the monitor when the force-HTTP rollback lever is pulled', () => {
    const prev = process.env.DESKTOP_IPC_FORCE_HTTP;
    process.env.DESKTOP_IPC_FORCE_HTTP = '1';
    try {
      expect(installDesktopIpcPolyfills()).toBeNull();
      expect(egressHandle(), 'forceHttp is the case egress matters MOST').toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.DESKTOP_IPC_FORCE_HTTP;
      else process.env.DESKTOP_IPC_FORCE_HTTP = prev;
    }
  });

  it('COUNTS egress in the fallback shell — the number the suite reads is real, not -1', () => {
    const prev = process.env.DESKTOP_IPC_FORCE_HTTP;
    process.env.DESKTOP_IPC_FORCE_HTTP = '1';
    try {
      installDesktopIpcPolyfills();
      deliver!([
        { name: 'http://localhost:3055/api/desktop/state', startTime: 480, duration: 12 },
        { name: 'http://localhost:3055/api/desktop/git-pipeline', startTime: 783, duration: 3632 },
        { name: 'http://localhost:3055/assets/app.js', startTime: 20, duration: 5 },
      ]);
      // Two /api entries counted; the asset ignored. A detector that reported 0
      // here would be indistinguishable from a genuinely clean shell.
      expect(egressHandle()!.report().total).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.DESKTOP_IPC_FORCE_HTTP;
      else process.env.DESKTOP_IPC_FORCE_HTTP = prev;
    }
  });

  it('stays QUIET in a shell that never promised IPC, while still counting', () => {
    (globalThis as { window?: TestWindow }).window!.__TAURI_INTERNALS__ = undefined;
    const errors: unknown[] = [];
    const originalError = globalThis.console.error;
    globalThis.console.error = (...args: unknown[]) => void errors.push(args);
    try {
      installDesktopIpcPolyfills();
      deliver!([{ name: 'http://localhost:3055/api/x', startTime: 10, duration: 1 }]);
      expect(egressHandle()!.report().total).toBe(1);
      expect(errors, 'HTTP is sanctioned outside the desktop shell — no error spam').toHaveLength(
        0,
      );
    } finally {
      globalThis.console.error = originalError;
    }
  });

  it('is LOUD when a shell that promised IPC lets a request escape (D-005)', () => {
    const errors: string[] = [];
    const originalError = globalThis.console.error;
    globalThis.console.error = (...args: unknown[]) => void errors.push(String(args[0]));
    try {
      installDesktopIpcPolyfills(); // Tauri present, no forceHttp ⇒ expectsIpc
      deliver!([
        { name: 'http://localhost:3055/api/desktop/state', startTime: 480, duration: 12 },
      ]);
      expect(errors.some((e) => e.includes('HTTP EGRESS'))).toBe(true);
    } finally {
      globalThis.console.error = originalError;
    }
  });
});
