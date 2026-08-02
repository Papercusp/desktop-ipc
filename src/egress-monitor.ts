/**
 * Webview HTTP egress monitor.
 *
 * THE INVARIANT: inside the desktop shell, an `/api/*` call must travel over
 * IPC. Any `/api/*` request that reaches the real network stack is a bug — the
 * webview has no usable network stack, and a silent HTTP fallback is what let
 * the same defect survive three times (no-http-anywhere-2026-07-28 D-005:
 * "HTTP is a loud failure, never a fallback").
 *
 * WHY RESOURCE TIMING IS THE RIGHT SENSOR, and not a fetch counter: a request
 * the IPC polyfill handled never touches the network stack, so it produces NO
 * `PerformanceResourceTiming` entry at all. The converse is therefore exact —
 * **an `/api/*` entry in resource timing IS the egress bug**, with no need to
 * instrument, wrap, or trust the transport that is itself under suspicion. It
 * also observes requests made by code that never went through our polyfill
 * (a third-party script, a stray `<img>`, an XHR — P-010), which a fetch-level
 * counter cannot see by construction.
 *
 * WHY `buffered: true` IS LOAD-BEARING: the offenders measured on 2026-07-28
 * all fire at t=480-783 ms — BEFORE the polyfill installs (P-011). A monitor
 * that only saw entries after its own installation would report a clean zero
 * and miss every one of them. `buffered: true` replays the entries already in
 * the performance buffer, so installation order stops mattering.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE 2026-07-28 PROBES MEASURED, AND WHY THIS FILE CHANGED (WI-6657)
 *
 * The perf suite read `performance.getEntriesByType('resource').length === 0`
 * in 483 of 483 polls of the packaged app — including 86 polls where the SPA
 * was demonstrably mounted. Two INDEPENDENT blindnesses stacked to produce it,
 * and only the first was ever suspected:
 *
 *  1. WebKitGTK does not record custom-scheme loads. Measured directly against
 *     WebKitGTK 2.52.3 with the scheme registered exactly as wry 0.55.1 does
 *     (`register_uri_scheme` + `register_uri_scheme_as_secure`): a document at
 *     `papercusp://localhost` gets NO resource-timing entry for its own
 *     `papercusp://` html/js/css, nor for `blob:` or `data:`. So a mounted SPA
 *     legitimately shows zero entries. That zero was TRUTHFUL, not blind:
 *     http fetch (CORS-ok, CORS-REJECTED and `mode:'no-cors'`), XHR, `<img>`
 *     and `sendBeacon` ARE all recorded from that same document. An escape is
 *     visible; the sensor's mechanism is sound.
 *
 *  2. ...but THIS FILE then threw every one of them away. The old code defaulted
 *     `origin` to `window.location.origin` and skipped any entry whose origin
 *     differed. In the packaged shell that document origin is
 *     `papercusp://localhost`, whose `new URL(...).origin` is the string
 *     `"null"` — so it matches nothing, and 100% of real escapes were filtered
 *     out before the `/api/` rule ever ran. In the dev shell the origin is
 *     `http://127.0.0.1:3270`, matches, and the 9 known escapes were found.
 *     The sensor worked in exactly the one shell we do not ship.
 *
 * The fix is the rule below: "our origin" is only a meaningful filter when the
 * document HAS an http origin. When the document is served over a custom
 * scheme, every http(s)/ws(s) request is by construction leaving the app's
 * intended transport, so none of them may be filtered by origin.
 *
 * WHAT RESOURCE TIMING STILL CANNOT SEE — measured, not assumed: WebSocket and
 * EventSource produce NO entry at all (the probe's server confirmed both
 * connections were established while the buffer stayed empty). Desktop sync is
 * SSE-primary, so resource timing alone is blind to the app's main data
 * transport. `installEgressMonitor` therefore also wraps those two
 * constructors — the only way to see them — and folds what they report into the
 * same rule.
 *
 * WHY THE VERDICT IS THREE-VALUED: zero escapes and a broken sensor produce the
 * same number. A negative claim ("nothing escaped") is only worth anything from
 * a sensor proven live, so `verdict` is `clean` ONLY after `verifyEgressSensor`
 * has watched a deliberate control request land in the buffer; otherwise it is
 * `unknown`, which every caller must treat as a BREACH. A POSITIVE observation
 * needs no such proof — seeing an escape is evidence in itself — so `breach`
 * never depends on the control.
 *
 * WHY THE CONTROL IS NOT RUN IN THE SHIPPED APP: the probes established that no
 * zero-egress control exists (`blob:`, `data:` and custom-scheme fetches are all
 * invisible), so proving the sensor live costs one real HTTP request. Making the
 * shipped app emit one would violate the very invariant it is auditing. CI and
 * the e2e suite call `verifyEgressSensor` and get a real verdict; the shipped
 * app reports `unknown` and is honest about it.
 */

/** How an escape was observed. Resource timing cannot see the last two. */
export type EgressVia = 'resource-timing' | 'websocket' | 'eventsource';

/**
 * WHICH INVARIANT an observation violates. Two ORTHOGONAL rules ride the one
 * sensor (egress-monitor-origin-axis-2026-08-02 P-001/P-002):
 *
 * `ipc-escape`    — an `/api/*` call on OUR origin reached the network stack
 *                   instead of travelling over IPC (the original transport
 *                   invariant, no-http-anywhere D-005).
 * `foreign-origin`— a request went to a host we do not own, whatever its path
 *                   (the DESTINATION invariant).
 *
 * They are reported SEPARATELY and must stay that way. They have different
 * owners and different fixes: an ipc-escape is a bug in our transport layer, a
 * foreign-origin is usually a third-party library's baked-in CDN default.
 * Collapsing them into one number destroys the only signal that makes either
 * actionable.
 *
 * WHY THE SECOND AXIS EXISTS. The original rule filtered to `/api/` paths on the
 * document origin, so it was STRUCTURALLY blind to the entire public-CDN class:
 * `https://unpkg.com/vditor@3.11.2/dist/js/lute/lute.min.js` was discarded in the
 * dev shell for not being our origin, and in the packaged shell for not being an
 * `/api/` path. Six such fetches (vditor, monaco, plantuml, porcupine, excalidraw,
 * emoji-mart) shipped for months under a live, healthy, correctly-working monitor
 * — because it was answering a different question.
 */
export type EgressAxis = 'ipc-escape' | 'foreign-origin';

/**
 * `clean` — the sensor was PROVEN live and saw no escape.
 * `breach` — an escape was observed (needs no proof; observation is evidence).
 * `unknown` — no escape seen, but the sensor was never proven live. Callers
 * MUST treat this as a failure: it is the state a dead detector reports.
 */
export type EgressVerdict = 'clean' | 'breach' | 'unknown';

/** One observed egress — a request that reached the real network stack. */
export interface EgressEntry {
  /** Path only (no origin, no query) — the identity that matters for triage. */
  path: string;
  /** Full URL. Under a custom scheme the escape's origin is NOT the document's. */
  url: string;
  /** ms since navigation start. */
  startMs: number;
  /** ms the request took. 0 for stream transports, which have no end. */
  durationMs: number;
  /** Which sensor caught it. */
  via: EgressVia;
  /** WHICH invariant this violates. See {@link EgressAxis}. */
  axis: EgressAxis;
}

/** The foreign-origin axis: requests to hosts we do not own. */
export interface ForeignOriginReport {
  /** Honest answer for THIS axis. `unknown` is a failure, exactly as above. */
  verdict: EgressVerdict;
  /** Total requests to non-local origins. Zero alone does NOT mean clean. */
  total: number;
  /**
   * Per-ORIGIN rollup — the triage unit that matters here. A CDN offender is one
   * host serving many paths (monaco alone pulls a dozen chunks), so rolling up by
   * path the way the ipc axis does would bury one bug under fifteen rows.
   */
  byOrigin: Record<string, { count: number; firstAtMs: number; sampleUrl: string }>;
  /** When the first foreign request happened, or null when there were none. */
  firstAtMs: number | null;
  /** The observed entries, oldest first, bounded by EGRESS_RING_SIZE. */
  entries: EgressEntry[];
}

export interface EgressSensorState {
  /** Did a deliberate control request land in the buffer? Gates `clean`. */
  controlObserved: boolean;
  /** Is resource timing observable at all in this environment? */
  resourceTiming: boolean;
  /** Are the WebSocket / EventSource constructors wrapped? */
  transportsWrapped: boolean;
  /** What this sensor structurally cannot see, in plain words. */
  blindTo: readonly string[];
}

export interface EgressReport {
  /** The honest answer. `unknown` is a failure, not a pass. */
  verdict: EgressVerdict;
  /** Total `/api/*` requests that escaped. Zero alone does NOT mean clean. */
  total: number;
  /** Per-path rollup, so a repeat offender is obvious without reading entries. */
  byPath: Record<string, { count: number; totalMs: number; firstAtMs: number }>;
  /** When the first escape happened, or null when there were none. */
  firstAtMs: number | null;
  /** The observed entries, oldest first, bounded by EGRESS_RING_SIZE. */
  entries: EgressEntry[];
  /** Why the verdict is what it is. */
  sensor: EgressSensorState;
  /**
   * The DESTINATION axis, reported separately on purpose (P-002). The fields
   * above remain the transport axis alone, so existing callers keep their exact
   * meaning rather than silently starting to count a different class of thing.
   */
  foreignOrigin: ForeignOriginReport;
}

/**
 * Hostnames that are never "foreign" — the loopback family. NOT a policy knob:
 * these are the addresses that by definition never leave the machine.
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Bounded so a pathological page cannot grow this without limit. */
export const EGRESS_RING_SIZE = 200;

/**
 * Query parameter marking the deliberate control request, so the one HTTP
 * request the sensor makes about ITSELF is never counted as an escape. A real
 * escape would have to carry this exact parameter to be masked by it.
 */
export const EGRESS_CONTROL_PARAM = '__egress_control__';

/** The minimal shape we need from a PerformanceResourceTiming. */
export interface ResourceTimingLike {
  name: string;
  startTime: number;
  duration: number;
  /** Present on real entries; lets a synthetic transport record identify itself. */
  via?: EgressVia;
}

export interface EgressOptions {
  /**
   * Paths that are ALLOWED to travel over HTTP, as exact path prefixes. Empty
   * by default and it should stay that way: an exemption is a declared hole in
   * the invariant, so it must be spelled out at the call site rather than
   * buried here where it would quietly become the norm.
   */
  exemptPrefixes?: readonly string[];
  /**
   * The origin the DOCUMENT is served from — NOT a filter to apply blindly.
   *
   * When it is an http(s) origin (dev shell, browser) it narrows the invariant
   * to our own API, so a genuinely third-party `https://vendor/api/...` is not
   * miscounted. When the document is served over a custom scheme, it is NOT
   * used as a filter at all: there is no http origin to be same-origin WITH, so
   * filtering by it discards every real escape — which is precisely the bug
   * this file shipped with (see the header).
   */
  documentOrigin?: string;
  /** Called once per newly observed escape, for a loud failure. */
  onEgress?: (entry: EgressEntry) => void;
  /**
   * Non-local origins that are LEGITIMATE for this app, as exact origins
   * (`https://example.com`). Empty by default and it should stay near-empty: an
   * entry here is a declared, reviewed hole in the destination invariant.
   *
   * Loopback is always allowed and is NOT expressed here — see LOCAL_HOSTNAMES.
   */
  allowedOrigins?: readonly string[];
}

const API_PREFIX = '/api/';

/** Schemes that mean "this left the webview over the real network stack". */
const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * Is this an http(s) origin we can meaningfully compare against? `papercusp://`
 * parses to the origin string "null", which equals nothing — using it as a
 * filter silently drops everything.
 */
function comparableOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Pessimistic by construction: nothing proven, so a zero means `unknown`. */
export const DEFAULT_SENSOR_STATE: EgressSensorState = {
  controlObserved: false,
  resourceTiming: false,
  transportsWrapped: false,
  blindTo: ['everything — no monitor is installed'],
};

/**
 * PURE classifier: observed loads in, egress report out. Split from the observer
 * so the invariant is unit-testable without a browser, a webview, or a live
 * shell — the thing that decides pass/fail should not need the environment
 * whose bug it is looking for.
 *
 * The returned verdict is `clean` or `unknown` on zero escapes depending on
 * `sensor`; pass the live sensor state in, or accept the default, which is
 * deliberately the pessimistic one.
 */
export function classifyEgress(
  entries: readonly ResourceTimingLike[],
  opts: EgressOptions = {},
  sensor: EgressSensorState = DEFAULT_SENSOR_STATE,
): EgressReport {
  const exempt = opts.exemptPrefixes ?? [];
  const restrictTo = comparableOrigin(opts.documentOrigin);
  const report: EgressReport = {
    verdict: 'unknown',
    total: 0,
    byPath: {},
    firstAtMs: null,
    entries: [],
    sensor,
  };

  for (const e of entries) {
    let url: URL;
    try {
      // A relative `name` cannot happen for resource timing (it is always an
      // absolute URL), but a malformed one must not take the monitor down —
      // a crashed detector reports zero, which is indistinguishable from a pass.
      url = new URL(e.name, opts.documentOrigin ?? 'http://localhost');
    } catch {
      continue;
    }
    // Only a real network scheme is egress. A `papercusp://`, `blob:` or `data:`
    // load never touched the network stack, so it cannot be an escape.
    if (!NETWORK_SCHEMES.has(url.protocol)) continue;
    // Same-origin narrowing ONLY when the document itself has an http origin.
    if (restrictTo && url.origin !== restrictTo) continue;
    // Never count the sensor's own proof-of-life request against the invariant.
    if (url.searchParams.has(EGRESS_CONTROL_PARAM)) continue;

    const path = url.pathname;
    if (!path.startsWith(API_PREFIX)) continue;
    if (exempt.some((p) => path.startsWith(p))) continue;

    const entry: EgressEntry = {
      path,
      url: url.href,
      startMs: e.startTime,
      durationMs: e.duration,
      via: e.via ?? 'resource-timing',
    };
    report.total++;
    const agg = report.byPath[path] ?? { count: 0, totalMs: 0, firstAtMs: e.startTime };
    agg.count++;
    agg.totalMs += e.duration;
    if (e.startTime < agg.firstAtMs) agg.firstAtMs = e.startTime;
    report.byPath[path] = agg;
    if (report.firstAtMs === null || e.startTime < report.firstAtMs) report.firstAtMs = e.startTime;
    report.entries.push(entry);
  }
  report.entries.sort((a, b) => a.startMs - b.startMs);
  if (report.entries.length > EGRESS_RING_SIZE) {
    report.entries = report.entries.slice(-EGRESS_RING_SIZE);
  }

  // A positive observation stands on its own. A NEGATIVE one is only worth
  // something from a sensor we proved was alive.
  report.verdict = report.total > 0 ? 'breach' : sensor.controlObserved ? 'clean' : 'unknown';
  return report;
}

export interface EgressMonitorHandle {
  /** The report as of now. */
  report(): EgressReport;
  /** Record an escape observed by something other than resource timing. */
  recordTransportEgress(url: string, via: EgressVia): void;
  /** Stop observing and restore any wrapped constructors. Idempotent. */
  stop(): void;
}

let active: EgressMonitorHandle | null = null;
let sensorState: EgressSensorState = { ...DEFAULT_SENSOR_STATE };

type Ctor = { new (...args: never[]): unknown; prototype: unknown };

/**
 * Wrap a global constructor so its target URL is recorded. This is the ONLY way
 * to see WebSocket and EventSource: the probes confirmed neither ever produces a
 * resource-timing entry, so without this the sensor is blind to the transports
 * desktop sync actually uses.
 *
 * Unlike resource timing's `buffered: true` replay, a constructor wrapper cannot
 * see backwards — a stream opened before install is invisible. That residual is
 * reported in `sensor.blindTo` rather than being papered over.
 */
function wrapConstructor(
  host: Record<string, unknown>,
  name: string,
  onUrl: (url: string) => void,
): (() => void) | null {
  const Original = host[name] as Ctor | undefined;
  if (typeof Original !== 'function') return null;

  const Wrapped = function (this: unknown, ...args: never[]) {
    try {
      const first: unknown = args[0];
      if (typeof first === 'string' || first instanceof URL) onUrl(String(first));
    } catch {
      // Recording must never break the app's transport. A missed record is a
      // reporting gap; a thrown constructor is an outage.
    }
    return new (Original as unknown as new (...a: never[]) => unknown)(...args);
  } as unknown as Ctor;

  Wrapped.prototype = Original.prototype;
  Object.setPrototypeOf(Wrapped, Original);
  host[name] = Wrapped;

  return () => {
    // Only restore if nobody re-wrapped on top of us; clobbering a later
    // wrapper (the IPC EventSource, say) would be worse than leaving ours.
    if (host[name] === Wrapped) host[name] = Original;
  };
}

/**
 * Start watching for egress. Returns null only when there is no `window` at all.
 *
 * A missing `PerformanceObserver` no longer returns null: the monitor still
 * installs its transport wrappers and reports `resourceTiming: false`, so the
 * verdict degrades to `unknown` — which is the honest answer — instead of the
 * caller having to infer it from a null.
 */
export function installEgressMonitor(opts: EgressOptions = {}): EgressMonitorHandle | null {
  if (active) return active;
  if (typeof window === 'undefined') return null;

  const seen: ResourceTimingLike[] = [];
  const documentOrigin = opts.documentOrigin ?? window.location?.origin;
  const options: EgressOptions = { ...opts, documentOrigin };
  let reported = 0;

  const state: EgressSensorState = {
    controlObserved: false,
    resourceTiming: false,
    transportsWrapped: false,
    blindTo: [],
  };

  const reclassify = (): void => {
    const r = classifyEgress(seen, options, state);
    // Announce only what is NEW, so a repeated buffered replay cannot spam.
    for (let i = reported; i < r.entries.length; i++) opts.onEgress?.(r.entries[i]);
    reported = r.entries.length;
  };

  const push = (e: ResourceTimingLike): void => {
    seen.push(e);
    if (seen.length > EGRESS_RING_SIZE * 4) seen.splice(0, seen.length - EGRESS_RING_SIZE * 4);
  };

  const ingest = (list: readonly ResourceTimingLike[]): void => {
    for (const e of list) push({ name: e.name, startTime: e.startTime, duration: e.duration });
    reclassify();
  };

  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      observer = new PerformanceObserver((list) => ingest(list.getEntries() as ResourceTimingLike[]));
      // buffered:true replays entries recorded BEFORE this call — the pre-polyfill
      // window is exactly where the known offenders live.
      observer.observe({ type: 'resource', buffered: true } as PerformanceObserverInit);
      state.resourceTiming = true;
    } catch {
      observer = null;
    }
  }

  const now = (): number =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : 0;

  const recordTransportEgress = (url: string, via: EgressVia): void => {
    push({ name: url, startTime: now(), duration: 0, via });
    reclassify();
  };

  // The transports resource timing provably cannot see.
  const host = window as unknown as Record<string, unknown>;
  const restores = [
    wrapConstructor(host, 'WebSocket', (u) => recordTransportEgress(u, 'websocket')),
    wrapConstructor(host, 'EventSource', (u) => recordTransportEgress(u, 'eventsource')),
  ].filter((f): f is () => void => f !== null);
  state.transportsWrapped = restores.length > 0;

  state.blindTo = [
    ...(state.resourceTiming ? [] : ['fetch/XHR/img — PerformanceObserver is unavailable here']),
    ...(state.transportsWrapped
      ? ['WebSocket/EventSource streams opened BEFORE this monitor installed']
      : ['WebSocket and EventSource entirely — constructors could not be wrapped']),
  ];

  const handle: EgressMonitorHandle = {
    report: () => classifyEgress(seen, options, state),
    recordTransportEgress,
    stop: () => {
      try {
        observer?.disconnect();
      } catch {
        // Already disconnected — stop() is idempotent by contract.
      }
      for (const restore of restores) restore();
      if (active === handle) active = null;
    },
  };
  active = handle;
  sensorState = state;

  // Readable from outside the app (a CI check or `tauri-agent-tools eval` reads
  // this rather than re-deriving the rule), and from inside for a UI surface.
  (window as unknown as Record<string, unknown>).__papercusp_egress__ = {
    report: () => handle.report(),
    verify: (o?: SensorProofOptions) => verifyEgressSensor(o),
  };
  return handle;
}

export interface SensorProofOptions {
  /**
   * An http(s) URL the control request is sent to. It must be reachable and
   * harmless — the point is only that the REQUEST happens, not what it returns;
   * a 404 proves the sensor just as well as a 200.
   */
  controlUrl?: string;
  /** How long to wait for the entry to appear. Default 3000 ms. */
  timeoutMs?: number;
  /** Poll interval while waiting. Default 25 ms. */
  pollMs?: number;
}

export interface SensorProofResult {
  observed: boolean;
  /**
   * Whether the control request was actually EMITTED — false when this returned
   * before sending anything (no usable control URL, no resource-timing API).
   *
   * Reported structurally rather than left to be inferred from {@link reason},
   * because `observed: false` covers two failures that need OPPOSITE fixes:
   * "the control was sent and the sensor missed it" (the sensor is blind — fix
   * the sensor) versus "no control was ever sent" (the sensor is unproven, and
   * says nothing either way — fix the caller's configuration). A caller that
   * cannot tell them apart reports the first while the second is true, which is
   * exactly the conflation the egress spec exists to prevent, reappearing inside
   * the sensor's own proof (2026-08-01).
   */
  issued: boolean;
  nonce: string;
  elapsedMs: number;
  /** Why it failed, when it did. */
  reason?: string;
}

/**
 * Prove the sensor is alive by making one request it MUST see, then watching for
 * it. Only after this returns `observed: true` can a zero-escape report claim
 * `clean` rather than `unknown`.
 *
 * CI AND E2E ONLY — never the shipped app. This deliberately emits one real HTTP
 * request, which is the thing the invariant forbids; the probes established that
 * no zero-egress control exists (`blob:`, `data:` and custom-scheme fetches are
 * all invisible to resource timing), so there is no cheaper honest proof.
 *
 * It POLLS rather than reading once: an entry was measured arriving a task after
 * its own fetch had already resolved, so a single read is a coin flip.
 */
export async function verifyEgressSensor(
  opts: SensorProofOptions = {},
): Promise<SensorProofResult> {
  const started =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : 0;
  const elapsed = (): number =>
    (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : 0) - started;
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
    return {
      observed: false,
      issued: false,
      nonce,
      elapsedMs: elapsed(),
      reason: 'no resource timing API',
    };
  }
  const base = opts.controlUrl ?? defaultControlUrl();
  if (!base) {
    return {
      observed: false,
      issued: false,
      nonce,
      elapsedMs: elapsed(),
      reason: 'no control URL available',
    };
  }

  let target: string;
  try {
    const u = new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return {
        observed: false,
        issued: false,
        nonce,
        elapsedMs: elapsed(),
        // A non-http control cannot prove anything: those schemes are exactly
        // the ones the probes showed are never recorded.
        reason: `control URL must be http(s), got ${u.protocol}`,
      };
    }
    u.searchParams.set(EGRESS_CONTROL_PARAM, nonce);
    target = u.href;
  } catch {
    return {
      observed: false,
      issued: false,
      nonce,
      elapsedMs: elapsed(),
      reason: `invalid control URL: ${base}`,
    };
  }

  // Deliberately an <img>, NOT fetch. `window.fetch` is the very transport this
  // audits — the IPC polyfill replaces it, so a control sent through it would be
  // routed over IPC, produce no resource-timing entry by design, and report the
  // sensor dead every single time. An image load bypasses the polyfill (the same
  // reason resource timing beats a fetch counter, P-010) and was measured
  // producing an entry with `initiatorType: 'img'`.
  //
  // The response does not matter: a 404 or a refused connection still produces
  // the entry, and the entry is the whole proof.
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      if (typeof Image === 'undefined') {
        void fetch(target, { cache: 'no-store' }).then(done, done);
      } else {
        const img = new Image();
        img.onload = done;
        img.onerror = done;
        img.src = target;
      }
    } catch {
      done();
    }
    // Never hang: the poll below is what actually decides, not this.
    setTimeout(done, Math.min(opts.timeoutMs ?? 3000, 2000));
  });

  const timeoutMs = opts.timeoutMs ?? 3000;
  const pollMs = opts.pollMs ?? 25;
  const deadline = elapsed() + timeoutMs;
  for (;;) {
    const hit = performance
      .getEntriesByType('resource')
      .some((e) => (e as unknown as ResourceTimingLike).name.includes(nonce));
    if (hit) {
      sensorState.controlObserved = true;
      return { observed: true, issued: true, nonce, elapsedMs: elapsed() };
    }
    if (elapsed() >= deadline) {
      return {
        observed: false,
        issued: true,
        nonce,
        elapsedMs: elapsed(),
        reason: `control request never appeared in resource timing within ${timeoutMs}ms — the sensor cannot be trusted`,
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * A same-document control URL, when the document is itself served over http.
 * Under a custom scheme there is no such URL and the caller must supply one —
 * we will not silently fall back to something that cannot prove anything.
 */
function defaultControlUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const origin = window.location?.origin;
  const comparable = comparableOrigin(origin);
  // Deliberately NOT under /api/: the control must be impossible to confuse with
  // the escapes it is proving we can see, quite apart from the nonce exclusion.
  return comparable ? `${comparable}/__egress_control__` : null;
}

/** The live report, or null when no monitor is installed (UNKNOWN, not clean). */
export function getEgressReport(): EgressReport | null {
  return active ? active.report() : null;
}

/** Test-only: drop the process-wide handle. */
export function _resetEgressMonitorForTests(): void {
  active?.stop();
  active = null;
  sensorState = { ...DEFAULT_SENSOR_STATE };
}
