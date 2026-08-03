import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyWsTarget,
  installWsGuard,
  _resetWsGuardForTests,
} from './ws-guard';
import { installDesktopIpcPolyfills, _resetForTests } from './desktop-bootstrap';
import { installEgressMonitor } from './egress-monitor';
import { configureDesktopIpc } from './config';

const ORIGIN = 'http://localhost:3055';

/**
 * The RULE, tested without a DOM. Same split as `classifyEgress` and
 * `classifyXhrTarget`: the thing that decides allowed-vs-refused should not need
 * the environment whose bug it is looking for.
 */
describe('classifyWsTarget', () => {
  it('refuses a same-authority /api socket — the violation this guard exists for', () => {
    expect(classifyWsTarget('/api/stream', ORIGIN)).toEqual({
      kind: 'violation',
      path: '/api/stream',
    });
    expect(classifyWsTarget('ws://localhost:3055/api/stream', ORIGIN)).toEqual({
      kind: 'violation',
      path: '/api/stream',
    });
  });

  it('matches on AUTHORITY, not the origin STRING — ws://h:p and http://h:p are one operator', () => {
    // This is the single most important difference from xhr-guard. `new
    // URL('ws://localhost:3055/api/x').origin` is 'ws://localhost:3055', which
    // never equals the document's 'http://localhost:3055' — so an origin
    // comparison would pass EVERY same-origin socket straight through and the
    // guard would be a silent no-op.
    expect(new URL('ws://localhost:3055/api/x').origin).not.toBe(ORIGIN);
    expect(classifyWsTarget('ws://localhost:3055/api/x', ORIGIN).kind).toBe('violation');
  });

  it('PASSES the voice/video sidecar on :3076 — a different process, and D-008-sanctioned', () => {
    // The measured real default for all three voice/video clients. Two
    // independent reasons it must pass: a different port is a different process,
    // and the path is content-origin scoped.
    expect(classifyWsTarget('ws://127.0.0.1:3076/api/desktop/voice', ORIGIN)).toEqual({
      kind: 'pass',
    });
  });

  it('PASSES the pty bridge on :3056 — same hostname, different port', () => {
    // The port is the whole discriminator here; a hostname-only comparison would
    // wrongly police the pty socket that PiPanel opens in a browser.
    expect(classifyWsTarget('ws://localhost:3056/pty/abc', ORIGIN)).toEqual({ kind: 'pass' });
  });

  it('PASSES same-authority NON-/api sockets — Vite HMR opens one on the dev port', () => {
    expect(classifyWsTarget('ws://localhost:3055/', ORIGIN)).toEqual({ kind: 'pass' });
    expect(classifyWsTarget('/@vite/client', ORIGIN)).toEqual({ kind: 'pass' });
  });

  it('treats /api/desktop/* as a DECLARED exemption, not a violation', () => {
    // Mirrors the fetch path's content-origin carve-out (D-008), same as xhr-guard.
    expect(classifyWsTarget('/api/desktop/voice', ORIGIN)).toEqual({
      kind: 'declared-exemption',
      path: '/api/desktop/voice',
    });
  });

  it('passes a cross-origin /api socket — that is the foreign-origin axis, not this one', () => {
    expect(classifyWsTarget('wss://example.com/api/x', ORIGIN)).toEqual({ kind: 'pass' });
  });

  it('polices https documents through the wss mapping', () => {
    expect(classifyWsTarget('/api/x', 'https://app.example')).toEqual({
      kind: 'violation',
      path: '/api/x',
    });
    expect(classifyWsTarget('wss://app.example/api/x', 'https://app.example')).toEqual({
      kind: 'violation',
      path: '/api/x',
    });
  });

  it('passes a custom packaged-shell scheme — it cannot address our operator', () => {
    expect(classifyWsTarget('/api/x', 'tauri://localhost')).toEqual({ kind: 'pass' });
  });

  it('passes an unparseable target rather than throwing — a guard that crashes on garbage is an outage', () => {
    expect(classifyWsTarget('http://[', ORIGIN)).toEqual({ kind: 'pass' });
  });

  it('does not match /api as a bare prefix of another segment', () => {
    expect(classifyWsTarget('/apiary/bees', ORIGIN)).toEqual({ kind: 'pass' });
  });

  it('accepts a URL object as well as a string', () => {
    expect(classifyWsTarget(new URL('ws://localhost:3055/api/x'), ORIGIN)).toEqual({
      kind: 'violation',
      path: '/api/x',
    });
  });
});

interface TestWindow {
  location?: { origin: string };
  WebSocket?: unknown;
  console?: Console;
  __TAURI_INTERNALS__?: { invoke?: () => void };
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
}

let originalWindow: unknown;
let opened: string[];

/** A minimal WebSocket whose constructor records rather than connecting. */
function makeFakeWs() {
  class FakeWs {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      opened.push(url);
    }
  }
  return FakeWs;
}

function win(): TestWindow {
  return (globalThis as { window?: TestWindow }).window!;
}

/** The live global, i.e. whatever the guard has (or has not) wrapped. */
function ws(): new (url: string) => { url: string } {
  return win().WebSocket as new (url: string) => { url: string };
}

beforeEach(() => {
  _resetWsGuardForTests();
  opened = [];
  originalWindow = (globalThis as { window?: unknown }).window;
  const w: TestWindow = {
    location: { origin: ORIGIN },
    WebSocket: makeFakeWs(),
  };
  (globalThis as { window?: unknown }).window = w;
});

afterEach(() => {
  _resetWsGuardForTests();
  _resetForTests();
  configureDesktopIpc({ requireIpc: undefined, forceHttp: undefined });
  (globalThis as { window?: unknown }).window = originalWindow;
  vi.restoreAllMocks();
});

describe('installWsGuard', () => {
  it('THROWS on a same-authority /api socket when strict — and before any handshake', () => {
    installWsGuard({ strict: () => true });
    expect(() => new (ws())('/api/stream')).toThrow(/WebSocket to \/api\/stream is refused/);
    // The whole point of throwing in the constructor: the underlying transport
    // was never handed the URL at all.
    expect(opened).toEqual([]);
  });

  it('names the alternative AND the rollback lever — a tripwire that says nothing is a dead end', () => {
    installWsGuard({ strict: () => true });
    expect(() => new (ws())('/api/x')).toThrow(/own sidecar port/);
    expect(() => new (ws())('/api/x')).toThrow(/DESKTOP_IPC_FORCE_HTTP=1/);
  });

  it('points at the plan items that own the missing route, not just at the refusal', () => {
    // A future reader hitting this needs to know the shim is deliberately absent
    // (D-042) rather than that they broke something.
    installWsGuard({ strict: () => true });
    expect(() => new (ws())('/api/x')).toThrow(/P-013\/P-014/);
  });

  it('when NOT strict: lets the socket open, but says so loudly exactly once per path', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    installWsGuard({ strict: () => false });
    new (ws())('/api/stream');
    new (ws())('/api/stream');
    new (ws())('/api/stream');
    // Not blocked — non-strict only observes.
    expect(opened).toHaveLength(3);
    // Deduped: a WebSocket consumer that fails reconnects in a loop, so an
    // unconditional log would become its own kind of silence.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/WS EGRESS: \/api\/stream/);
  });

  it('does not throw on the declared /api/desktop/* exemption, even when strict', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installWsGuard({ strict: () => true });
    expect(() => new (ws())('/api/desktop/voice')).not.toThrow();
    expect(opened).toEqual(['/api/desktop/voice']);
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/DECLARED HTTP EXEMPTION \(websocket\)/);
  });

  it('leaves the real voice, video and pty sockets completely untouched', () => {
    // The regression that would actually hurt: this guard breaking the three
    // shipping WebSocket consumers. All four measured call sites, verbatim.
    installWsGuard({ strict: () => true });
    expect(() => new (ws())('ws://127.0.0.1:3076/api/desktop/voice')).not.toThrow();
    expect(() => new (ws())('ws://localhost:3056/pty/abc')).not.toThrow();
    expect(() => new (ws())('ws://localhost:3055/')).not.toThrow();
    expect(opened).toHaveLength(3);
  });

  it('preserves instanceof and the constructor statics', () => {
    const Original = win().WebSocket as { CONNECTING: number; OPEN: number };
    installWsGuard({ strict: () => true });
    const Guarded = ws() as unknown as { CONNECTING: number; OPEN: number };
    // Statics reach through the prototype chain (Object.setPrototypeOf), which is
    // what `readyState === WebSocket.OPEN` comparisons in consumers rely on.
    expect(Guarded.CONNECTING).toBe(Original.CONNECTING);
    expect(Guarded.OPEN).toBe(Original.OPEN);
    const sock = new (ws())('ws://localhost:3056/pty/abc');
    expect(sock).toBeInstanceOf(ws());
    expect(sock.url).toBe('ws://localhost:3056/pty/abc');
  });

  it('restores the original constructor on uninstall', () => {
    const before = win().WebSocket;
    const handle = installWsGuard({ strict: () => true });
    expect(win().WebSocket).not.toBe(before);
    handle?.uninstall();
    expect(win().WebSocket).toBe(before);
    expect(() => new (ws())('/api/stream')).not.toThrow();
  });

  it('does NOT restore when someone wrapped on top of us — clobbering a later wrapper is worse', () => {
    const handle = installWsGuard({ strict: () => true });
    const mine = win().WebSocket;
    const later = function Later() {} as unknown as TestWindow['WebSocket'];
    win().WebSocket = later;
    handle?.uninstall();
    expect(win().WebSocket).toBe(later);
    expect(win().WebSocket).not.toBe(mine);
  });

  it('is idempotent — a second install returns the same handle, not a nested wrapper', () => {
    const a = installWsGuard({ strict: () => true });
    const wrapped = win().WebSocket;
    const b = installWsGuard({ strict: () => true });
    expect(b).toBe(a);
    expect(win().WebSocket).toBe(wrapped);
  });

  it('returns null when there is no WebSocket to wrap', () => {
    delete win().WebSocket;
    expect(installWsGuard({ strict: () => true })).toBeNull();
  });

  it('ignores a non-string, non-URL first argument instead of throwing', () => {
    installWsGuard({ strict: () => true });
    // Not a target we can classify; the native ctor owns the error, not us.
    expect(() => new (ws() as unknown as new (u: unknown) => unknown)(undefined)).not.toThrow();
  });

  it('resolves the document origin at CALL time, so a late navigation is not pinned', () => {
    installWsGuard({ strict: () => true });
    // Same path, different document origin => different verdict. Reading
    // window.location once at install would freeze the first answer.
    win().location = { origin: 'http://localhost:3070' };
    expect(() => new (ws())('ws://localhost:3070/api/x')).toThrow(/refused/);
    expect(() => new (ws())('ws://localhost:3055/api/x')).not.toThrow();
  });

  it('defaults its strictness to requireIpc — one policy, not a fourth knob that can drift', () => {
    configureDesktopIpc({ requireIpc: false });
    installWsGuard();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => new (ws())('/api/x')).not.toThrow();

    _resetWsGuardForTests();
    configureDesktopIpc({ requireIpc: true });
    installWsGuard();
    expect(() => new (ws())('/api/y')).toThrow(/refused/);
  });

  it('forceHttp disarms it, because that is the documented rollback lever', () => {
    // A rollback that leaves one of the four transports still refusing is not a
    // rollback. isRequireIpc() returns false whenever forceHttp is set.
    configureDesktopIpc({ forceHttp: true });
    installWsGuard();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => new (ws())('/api/x')).not.toThrow();
  });
});

/**
 * D-040(c) / D-042(d): the guard must never make the egress monitor report a
 * connection that never happened — false positives red a release-gate-BLOCKING
 * invariant. The claim is that ORDERING alone secures this (monitor wraps first,
 * guard wraps on top, so a refusal throws before the recorder is reached), which
 * is a claim about composition and therefore has to be tested against the real
 * monitor rather than argued.
 */
describe('composition with the egress monitor', () => {
  it('a REFUSED socket is never recorded as egress, and never reaches the transport', () => {
    const onEgress = vi.fn();
    // Same order the bootstrap uses: monitor first, guard on top.
    const monitor = installEgressMonitor({ onEgress, documentOrigin: ORIGIN });
    installWsGuard({ strict: () => true });

    expect(() => new (ws())('/api/stream')).toThrow(/refused/);

    // Nothing escaped, so nothing may be reported. If the guard were installed
    // UNDER the monitor this would have recorded a connection that was refused.
    expect(onEgress).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
    monitor?.stop();
  });

  it('an ALLOWED socket still reaches the transport through both wrappers', () => {
    const onEgress = vi.fn();
    const monitor = installEgressMonitor({ onEgress, documentOrigin: ORIGIN });
    installWsGuard({ strict: () => true });

    // The real voice/video default. The guard passes it and the monitor stays
    // free to observe it — neither layer may swallow a sanctioned connection.
    expect(() => new (ws())('ws://127.0.0.1:3076/api/desktop/voice')).not.toThrow();
    expect(opened).toEqual(['ws://127.0.0.1:3076/api/desktop/voice']);
    monitor?.stop();
  });
});

describe('installDesktopIpcPolyfills — the guard is wired into the bootstrap', () => {
  beforeEach(() => {
    const w = win();
    w.__TAURI_INTERNALS__ = { invoke: () => {} };
    w.fetch = vi.fn(async () => new Response('native')) as unknown as typeof fetch;
    w.EventSource = class {} as unknown as typeof EventSource;
  });

  it('installs the WS guard in a Tauri shell, and uninstall restores it', () => {
    configureDesktopIpc({ requireIpc: true });
    const before = win().WebSocket;
    const handle = installDesktopIpcPolyfills();
    expect(handle).not.toBeNull();
    expect(win().WebSocket).not.toBe(before);
    expect(() => new (ws())('/api/stream')).toThrow(/refused/);

    handle!.uninstall();
    // LIFO all the way back down: the guard AND the egress wrapper unwind, so the
    // true original constructor is reinstated rather than a detached recorder.
    expect(win().WebSocket).toBe(before);
  });

  it('does NOT install the guard outside Tauri — HTTP is the sanctioned transport in a browser', () => {
    win().__TAURI_INTERNALS__ = undefined;
    expect(installDesktopIpcPolyfills()).toBeNull();
    // Asserted on BEHAVIOUR, not on constructor identity — and the difference is
    // the point. Unlike XMLHttpRequest, `WebSocket` is wrapped outside Tauri too,
    // because the egress monitor installs BEFORE the expectsIpc gate on purpose
    // ("installable — and meaningful — in every shell"). So the global is still a
    // wrapper here; what must be absent is the REFUSAL.
    expect(() => new (ws())('/api/stream')).not.toThrow();
    expect(opened).toEqual(['/api/stream']);
  });

  it('leaves the shipping voice socket working inside the shell', () => {
    // The regression that would actually reach a user: the desktop shell coming
    // up with voice broken because the last transport door refused too much.
    configureDesktopIpc({ requireIpc: true });
    const handle = installDesktopIpcPolyfills();
    expect(() => new (ws())('ws://127.0.0.1:3076/api/desktop/voice')).not.toThrow();
    handle!.uninstall();
  });
});
