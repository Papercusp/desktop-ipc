/**
 * WebSocket guard — the FOURTH and last transport door (no-http-anywhere P-013).
 *
 * `installDesktopIpcPolyfills` routes `fetch` and `EventSource` over IPC, and
 * P-010 closed `XMLHttpRequest` with a guard. `WebSocket` is what is left: the
 * egress monitor WRAPS the constructor, but only to RECORD (`via:'websocket'`),
 * and a recorder cannot refuse anything.
 *
 * WHAT WAS MEASURED BEFORE WRITING THIS (2026-08-03), because this plan's
 * standing rule is to re-measure a premise rather than inherit it — D-006, D-008,
 * D-037, D-038 and D-040 were each refuted or re-shaped on contact:
 *
 *  - **The operator serves ZERO WebSocket endpoints.** Not one `upgradeWebSocket`
 *    route exists on the Hono host, and every `WebSocketServer` in the tree binds
 *    its OWN dedicated port (`{ port }`) — `desktop-voice-ws` (3076), `pty-ws`
 *    (3056), `device-voice-ws`, `frame-vnc`. There is no `noServer:true` and no
 *    `{ server }` attachment anywhere, so no socket shares the operator's HTTP
 *    listener. A same-origin `/api` WebSocket is therefore not merely absent, it
 *    is unserved: there is nothing on the other end for a shim to reach.
 *  - **All four client call sites target a different LISTENER.** voice x2 and
 *    video default to `ws://127.0.0.1:3076/api/desktop/voice` — a separate
 *    sidecar port, under the one prefix D-008 sanctions for the native transport.
 *    PiPanel's PTY socket returns `null` outright in the Tauri shell
 *    (`__PAPERCUSP_TAURI__.kind === 'native'`), and otherwise refuses to connect
 *    unless the document is on `:3055`. None of them addresses the IPC channel.
 *  - **Those consumers are P-014's, not P-013's** — that item is literally "PTY
 *    (terminals) and voice onto the shim". By the plan's own decomposition the
 *    shim has no consumers until P-014 runs.
 *
 * So this file is P-013's guard branch, deliberately and not by default — the
 * same shape P-010 took and D-040 blessed. Building `IpcWebSocket` + a Rust
 * `endpoint_data` command + an operator-side DATA receiver TODAY would be a
 * four-piece, two-language transport with zero consumers AND zero endpoints, and
 * its close/backpressure/binary semantics could only be guessed at until a real
 * socket exercises them. D-041 already put the principle on the record: a frame's
 * first consumer is what proves it works. The DATA frame keeps its first consumer
 * — it is P-014's, where the requirements actually live. See D-042.
 *
 * WHY IT REUSES `isRequireIpc()`. Same reason as `xhr-guard`: `requireIpc` ALREADY
 * is this policy ("never silently fall back to the webview's HTTP transport"), so
 * a fourth transport with its own switch is exactly the drift `desktop-bootstrap`
 * routes both `/api` branches through one helper to prevent. One policy, four
 * transports; `forceHttp` still disarms all of them. And a `process.env` lever
 * could not work here anyway — Vite compiles `process.env` to `{}` in the shipped
 * bundle, so every such flag reads `undefined` in the exact webview this protects
 * (D-040(b), EI-19420043903144442).
 *
 * WHY IT DOES NOT RECORD INTO THE EGRESS MONITOR — and here the ordering makes it
 * free. The monitor wraps `WebSocket` during the pre-`expectsIpc` block; this
 * guard wraps on top of that wrapper. So a REFUSED socket throws before the
 * recorder is ever reached and is never counted, while an ALLOWED one falls
 * through to it and is counted exactly once. That is precisely D-040(c)'s
 * requirement (a blocked call escaped nothing, and false positives red a
 * release-gate-BLOCKING invariant) satisfied by construction rather than by a
 * second bookkeeping path.
 *
 * WHY IT DOES NOT REUSE `wrapConstructor` FROM egress-monitor.ts. It swallows any
 * exception its hook throws — deliberately, and correctly, for a recorder ("a
 * missed record is a reporting gap; a thrown constructor is an outage"). A guard
 * whose whole job is to throw cannot be built on a wrapper that eats throws.
 */

import { isContentOriginScopedPath, isRequireIpc } from './config';

const API_PREFIX = '/api/';

/**
 * Protocols worth classifying. `ws:`/`wss:` are what a WebSocket URL carries;
 * `http:`/`https:` show up when the caller passed a RELATIVE ref
 * (`new WebSocket('/api/x')`), which resolves against the document origin before
 * the constructor maps the scheme. Anything else — a packaged-shell custom
 * scheme, `file:` — cannot address our operator, so it is not ours to police.
 */
const POLICED_PROTOCOLS = new Set(['ws:', 'wss:', 'http:', 'https:']);

/** Paths already reported, so a reconnect loop cannot turn a warning into a flood. */
const reported = new Set<string>();

/**
 * Classify one WebSocket target. Split out from the wrapper so the RULE is
 * testable without a DOM, a WebSocket, or a live shell — the same reason
 * `classifyEgress` and `classifyXhrTarget` are pure functions.
 */
export type WsVerdict =
  /** Not ours to police — different host:port, non-/api, or unparseable. */
  | { kind: 'pass' }
  /** Same authority + /api, but content-origin scoped: a DECLARED HTTP route. */
  | { kind: 'declared-exemption'; path: string }
  /** Same authority + /api with no sanctioned route. This is the violation. */
  | { kind: 'violation'; path: string };

export function classifyWsTarget(url: string | URL, documentOrigin: string): WsVerdict {
  let doc: URL;
  let u: URL;
  try {
    doc = new URL(documentOrigin);
    u = new URL(typeof url === 'string' ? url : url.toString(), documentOrigin);
  } catch {
    // An unparseable target cannot be shown to be ours, and a guard that throws
    // on garbage input is an outage rather than a tripwire.
    return { kind: 'pass' };
  }
  if (!POLICED_PROTOCOLS.has(u.protocol)) return { kind: 'pass' };

  // Compare AUTHORITY (`host`, which includes the port), not `origin` — and that
  // is the whole trick. `ws://h:p` and `http://h:p` are the same operator but
  // never the same `origin` STRING, so the origin comparison `xhr-guard` uses
  // would pass every same-origin socket straight through. Port-sensitivity is
  // also exactly what separates the operator (:3055) from the voice sidecar
  // (:3076) and the pty bridge (:3056), which are different LISTENERS and must
  // keep their native sockets.
  //
  // ⚠ "different listener", NOT "different process" — an earlier version of this
  // comment (and D-042) said process, and that was wrong. Both are started by
  // plain in-process calls inside the operator host (`startPtyWsServer` at
  // hono-host.ts:367, `startDesktopVoiceWs` at host-bootstrap.ts:774); PTY in
  // particular MUST be in-process because the registry its WS attaches to is
  // in-process state. The stake is which operator INSTANCE serves them
  // (content-origin vs IPC-owner), which is what D-044 settles.
  if (u.host !== doc.host) return { kind: 'pass' };
  if (!u.pathname.startsWith(API_PREFIX)) return { kind: 'pass' };

  // Mirrors the fetch path's content-origin carve-out (D-008): these describe the
  // operator that SERVED this document, and when the IPC bridge belongs to a
  // different operator they are sanctioned to stay on the native transport.
  if (isContentOriginScopedPath(u.pathname)) {
    return { kind: 'declared-exemption', path: u.pathname };
  }
  return { kind: 'violation', path: u.pathname };
}

export interface WsGuardOptions {
  /** Defaults to `window.location.origin`. */
  documentOrigin?: string;
  /**
   * Override the throw/warn decision. Defaults to {@link isRequireIpc} — see the
   * header for why this is not its own flag.
   */
  strict?: () => boolean;
}

/** Restores the original constructor, or null when there was nothing to wrap. */
export type WsGuardHandle = { uninstall: () => void } | null;

type WsCtor = new (...args: never[]) => unknown;

let installedHandle: WsGuardHandle = null;

/**
 * Wrap the global `WebSocket` so a same-authority `/api` socket is refused
 * (strict) or named (non-strict) instead of quietly opening.
 *
 * Idempotent per module: a second install returns the existing handle rather
 * than nesting a second wrapper.
 */
export function installWsGuard(opts: WsGuardOptions = {}): WsGuardHandle {
  if (installedHandle) return installedHandle;
  if (typeof window === 'undefined') return null;
  const host = window as unknown as Record<string, unknown>;
  const Original = host.WebSocket as WsCtor | undefined;
  if (typeof Original !== 'function') return null;

  const strict = opts.strict ?? isRequireIpc;

  const Guarded = function (this: unknown, ...args: never[]) {
    const raw: unknown = args[0];
    if (typeof raw === 'string' || raw instanceof URL) {
      // Resolve the origin at CALL time, not install time: the guard installs
      // during boot and `window.location` is the authority on where the document
      // actually came from (dev serves http://127.0.0.1:3055, the packaged shell
      // a custom scheme). Reading it once at install would pin a stale answer.
      const origin = opts.documentOrigin ?? window.location?.origin ?? '';
      let verdict: WsVerdict;
      try {
        verdict = classifyWsTarget(raw, origin);
      } catch {
        // Classification must never be what breaks a connection.
        verdict = { kind: 'pass' };
      }

      const consoleHost = typeof globalThis !== 'undefined' ? globalThis.console : undefined;
      if (verdict.kind === 'violation') {
        if (strict()) {
          // Thrown from the constructor, so no handshake is attempted and the
          // caller is on the stack. Mirrors `ipcFetch`'s rejection under
          // requireIpc rather than inventing a second failure mode.
          throw new Error(
            `desktop-ipc: WebSocket to ${verdict.path} is refused — inside the desktop ` +
              `shell every same-origin /api call must travel over IPC, and WebSocket has ` +
              `no IPC route (only fetch and EventSource are patched; the DATA frame that ` +
              `would carry one has no sender or receiver yet — see plan ` +
              `no-http-anywhere-2026-07-28 P-013/P-014). Long-lived sockets belong on ` +
              `their own sidecar port, as voice (:3076) and pty (:3056) already do. ` +
              `To roll the whole no-HTTP policy back: set DESKTOP_IPC_FORCE_HTTP=1 before launch, ` +
              `or from inside a running app (env vars are compiled out of a browser bundle) run ` +
              `globalThis.__DESKTOP_IPC_ENV__={DESKTOP_IPC_FORCE_HTTP:'1'} and reload — ` +
              `or configureDesktopIpc({ requireIpc: false }).`,
          );
        }
        if (!reported.has(verdict.path)) {
          reported.add(verdict.path);
          consoleHost?.error?.(
            `[desktop-ipc] WS EGRESS: ${verdict.path} is being opened over WebSocket, ` +
              `which is not routed over IPC — this connection is leaving over the network ` +
              `stack.`,
          );
        }
      } else if (verdict.kind === 'declared-exemption' && !reported.has(verdict.path)) {
        reported.add(verdict.path);
        consoleHost?.warn?.(
          `[desktop-ipc] DECLARED HTTP EXEMPTION (websocket): ${verdict.path} is ` +
            `content-origin scoped, so it stays on the native transport.`,
        );
      }
    }

    return new (Original as unknown as new (...a: never[]) => unknown)(...args);
  } as unknown as WsCtor;

  // Share the prototype so `instanceof` still holds, and inherit statics
  // (CONNECTING/OPEN/CLOSING/CLOSED) through the constructor's own chain — the
  // same two lines `wrapConstructor` uses, for the same reasons.
  Guarded.prototype = Original.prototype;
  Object.setPrototypeOf(Guarded, Original);
  host.WebSocket = Guarded;

  installedHandle = {
    uninstall: () => {
      // Only restore when nobody wrapped on top of us — clobbering a later
      // wrapper is worse than leaving ours in place (same rule as
      // `wrapConstructor` in egress-monitor.ts and `xhr-guard`).
      if (host.WebSocket === Guarded) host.WebSocket = Original;
      installedHandle = null;
    },
  };
  return installedHandle;
}

/** Test-only: drop module state so each test starts from a clean global. */
export function _resetWsGuardForTests(): void {
  installedHandle?.uninstall();
  installedHandle = null;
  reported.clear();
}
