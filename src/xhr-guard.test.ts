import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyXhrTarget,
  installXhrGuard,
  _resetXhrGuardForTests,
} from './xhr-guard';
import { installDesktopIpcPolyfills, _resetForTests } from './desktop-bootstrap';
import { configureDesktopIpc } from './config';

const ORIGIN = 'http://localhost:3055';

/**
 * The RULE, tested without a DOM. Same split as `classifyEgress`: the thing that
 * decides allowed-vs-refused should not need the environment whose bug it is
 * looking for.
 */
describe('classifyXhrTarget', () => {
  it('refuses a same-origin /api path — the violation this guard exists for', () => {
    expect(classifyXhrTarget('/api/plans/list', ORIGIN)).toEqual({
      kind: 'violation',
      path: '/api/plans/list',
    });
    expect(classifyXhrTarget(`${ORIGIN}/api/work-items`, ORIGIN)).toEqual({
      kind: 'violation',
      path: '/api/work-items',
    });
  });

  it('passes a CROSS-ORIGIN /api path — posthog et al. are the other axis, not ours', () => {
    // The measured real case: posthog's api_host is https://flags.papercuspai.com.
    // A foreign origin is the egress monitor's foreign-origin axis; the transport
    // invariant is about OUR api only, and conflating them is what made the
    // monitor blind to six CDN fetches for months.
    expect(classifyXhrTarget('https://flags.papercuspai.com/api/e', ORIGIN)).toEqual({
      kind: 'pass',
    });
  });

  it('passes same-origin NON-/api paths — assets, wasm and Prism data-src are not egress', () => {
    // These are the real bundled XHR users: two Emscripten loaders fetching their
    // own .wasm, and Prism's file-highlight fetching a source file.
    expect(classifyXhrTarget('/assets/porcupine.wasm', ORIGIN)).toEqual({ kind: 'pass' });
    expect(classifyXhrTarget('/vditor/dist/js/lute/lute.min.js', ORIGIN)).toEqual({ kind: 'pass' });
  });

  it('treats /api/desktop/* as a DECLARED exemption, not a violation', () => {
    // Mirrors the fetch path's content-origin carve-out (D-008).
    expect(classifyXhrTarget('/api/desktop/version', ORIGIN)).toEqual({
      kind: 'declared-exemption',
      path: '/api/desktop/version',
    });
  });

  it('passes an unparseable target rather than throwing — a guard that crashes on garbage is an outage', () => {
    expect(classifyXhrTarget('http://[', ORIGIN)).toEqual({ kind: 'pass' });
  });

  it('does not match /api as a bare prefix of another segment', () => {
    // `/apiary` must not be policed just because it starts with the same letters.
    expect(classifyXhrTarget('/apiary/bees', ORIGIN)).toEqual({ kind: 'pass' });
  });
});

interface TestWindow {
  location?: { origin: string };
  XMLHttpRequest?: unknown;
  console?: Console;
  __TAURI_INTERNALS__?: { invoke?: () => void };
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
}

let originalWindow: unknown;
let opened: Array<[string, string]>;

/** A minimal XHR whose `open` records rather than performing a request. */
function makeFakeXhr() {
  class FakeXhr {
    open(method: string, url: string) {
      opened.push([method, url]);
    }
  }
  return FakeXhr;
}

beforeEach(() => {
  _resetXhrGuardForTests();
  opened = [];
  originalWindow = (globalThis as { window?: unknown }).window;
  const win: TestWindow = {
    location: { origin: ORIGIN },
    XMLHttpRequest: makeFakeXhr(),
  };
  (globalThis as { window?: unknown }).window = win;
});

afterEach(() => {
  _resetXhrGuardForTests();
  _resetForTests();
  configureDesktopIpc({ requireIpc: undefined, forceHttp: undefined });
  (globalThis as { window?: unknown }).window = originalWindow;
  vi.restoreAllMocks();
});

function xhrProto(): { open: (m: string, u: string) => void } {
  const win = (globalThis as { window?: TestWindow }).window!;
  return (win.XMLHttpRequest as { prototype: { open: (m: string, u: string) => void } }).prototype;
}

describe('installXhrGuard', () => {
  it('THROWS on a same-origin /api call when strict — and before the request is made', () => {
    installXhrGuard({ strict: () => true });
    const proto = xhrProto();
    expect(() => proto.open('GET', '/api/plans/list')).toThrow(/XMLHttpRequest to \/api\/plans\/list is refused/);
    // The whole point of throwing at open() rather than send(): nothing was
    // handed to the underlying transport at all.
    expect(opened).toEqual([]);
  });

  it('names the working alternative in the error — a tripwire that does not say what to do instead is a dead end', () => {
    installXhrGuard({ strict: () => true });
    expect(() => xhrProto().open('GET', '/api/x')).toThrow(/Use fetch\(\)/);
    // And the documented rollback lever, so the reader is not left guessing.
    expect(() => xhrProto().open('GET', '/api/x')).toThrow(/DESKTOP_IPC_FORCE_HTTP=1/);
  });

  it('when NOT strict: lets the call through, but says so loudly exactly once per path', () => {
    const err = vi.fn();
    (globalThis as { window?: TestWindow }).window!.console = { error: err } as unknown as Console;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    installXhrGuard({ strict: () => false });
    const proto = xhrProto();
    proto.open('GET', '/api/plans/list');
    proto.open('GET', '/api/plans/list');
    proto.open('GET', '/api/plans/list');
    // The request is NOT blocked — non-strict only observes.
    expect(opened).toHaveLength(3);
    // Deduped: these callers poll every 30s, so an unconditional log would become
    // its own kind of silence (same reasoning as reportDeclaredHttpExemption).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/XHR EGRESS: \/api\/plans\/list/);
  });

  it('does not throw on the declared /api/desktop/* exemption, even when strict', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installXhrGuard({ strict: () => true });
    expect(() => xhrProto().open('GET', '/api/desktop/version')).not.toThrow();
    expect(opened).toEqual([['GET', '/api/desktop/version']]);
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/DECLARED HTTP EXEMPTION \(xhr\)/);
  });

  it('leaves non-/api and cross-origin calls completely untouched', () => {
    installXhrGuard({ strict: () => true });
    const proto = xhrProto();
    expect(() => proto.open('GET', '/assets/porcupine.wasm')).not.toThrow();
    expect(() => proto.open('POST', 'https://flags.papercuspai.com/api/e')).not.toThrow();
    expect(opened).toHaveLength(2);
  });

  it('restores the original open on uninstall', () => {
    const before = xhrProto().open;
    const handle = installXhrGuard({ strict: () => true });
    expect(xhrProto().open).not.toBe(before);
    handle!.uninstall();
    expect(xhrProto().open).toBe(before);
    // And the guard is genuinely gone, not merely detached.
    expect(() => xhrProto().open('GET', '/api/x')).not.toThrow();
  });

  it('does NOT clobber a wrapper installed on top of it (LIFO discipline)', () => {
    const handle = installXhrGuard({ strict: () => true });
    const later = function later() {};
    xhrProto().open = later as unknown as (m: string, u: string) => void;
    handle!.uninstall();
    // Restoring here would strand the later wrapper's caller; leaving ours in
    // place is the lesser harm — same rule as wrapConstructor in egress-monitor.
    expect(xhrProto().open).toBe(later);
  });

  it('is idempotent — a second install returns the same handle rather than nesting', () => {
    const a = installXhrGuard({ strict: () => true });
    const b = installXhrGuard({ strict: () => true });
    expect(b).toBe(a);
  });

  it('returns null when there is no XMLHttpRequest to wrap', () => {
    (globalThis as { window?: TestWindow }).window!.XMLHttpRequest = undefined;
    expect(installXhrGuard({ strict: () => true })).toBeNull();
  });

  it('defaults its strictness to requireIpc — one policy, not a second knob that can drift', () => {
    configureDesktopIpc({ requireIpc: false });
    installXhrGuard();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // requireIpc off => warn-only, request proceeds.
    expect(() => xhrProto().open('GET', '/api/x')).not.toThrow();

    _resetXhrGuardForTests();
    configureDesktopIpc({ requireIpc: true });
    installXhrGuard();
    expect(() => xhrProto().open('GET', '/api/y')).toThrow(/refused/);
  });

  it('forceHttp disarms it, because that is the documented rollback lever', () => {
    // isRequireIpc() returns false whenever forceHttp is set, so the guard must
    // follow — a rollback that leaves one transport still refusing is not a
    // rollback.
    configureDesktopIpc({ forceHttp: true });
    installXhrGuard();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => xhrProto().open('GET', '/api/x')).not.toThrow();
  });
});

describe('installDesktopIpcPolyfills — the guard is wired into the bootstrap', () => {
  beforeEach(() => {
    const win = (globalThis as { window?: TestWindow }).window!;
    win.__TAURI_INTERNALS__ = { invoke: () => {} };
    win.fetch = vi.fn(async () => new Response('native')) as unknown as typeof fetch;
    win.EventSource = class {} as unknown as typeof EventSource;
  });

  it('installs the XHR guard in a Tauri shell, and uninstall restores it', () => {
    configureDesktopIpc({ requireIpc: true });
    const before = xhrProto().open;
    const handle = installDesktopIpcPolyfills();
    expect(handle).not.toBeNull();
    expect(xhrProto().open).not.toBe(before);
    expect(() => xhrProto().open('GET', '/api/plans/list')).toThrow(/refused/);

    handle!.uninstall();
    expect(xhrProto().open).toBe(before);
  });

  it('does NOT install the guard outside Tauri — HTTP is the sanctioned transport in a browser', () => {
    (globalThis as { window?: TestWindow }).window!.__TAURI_INTERNALS__ = undefined;
    const before = xhrProto().open;
    expect(installDesktopIpcPolyfills()).toBeNull();
    expect(xhrProto().open).toBe(before);
  });
});
