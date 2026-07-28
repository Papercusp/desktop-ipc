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
 */

/** One observed egress — a request that reached the real network stack. */
export interface EgressEntry {
  /** Path only (no origin, no query) — the identity that matters for triage. */
  path: string;
  /** ms since navigation start. */
  startMs: number;
  /** ms the request took. */
  durationMs: number;
}

export interface EgressReport {
  /** Total `/api/*` requests that escaped to HTTP. Zero is the only passing value. */
  total: number;
  /** Per-path rollup, so a repeat offender is obvious without reading entries. */
  byPath: Record<string, { count: number; totalMs: number; firstAtMs: number }>;
  /** When the first escape happened, or null when there were none. */
  firstAtMs: number | null;
  /** The observed entries, oldest first, bounded by EGRESS_RING_SIZE. */
  entries: EgressEntry[];
}

/** Bounded so a pathological page cannot grow this without limit. */
export const EGRESS_RING_SIZE = 200;

/** The minimal shape we need from a PerformanceResourceTiming. */
export interface ResourceTimingLike {
  name: string;
  startTime: number;
  duration: number;
}

export interface EgressOptions {
  /**
   * Paths that are ALLOWED to travel over HTTP, as exact path prefixes. Empty
   * by default and it should stay that way: an exemption is a declared hole in
   * the invariant, so it must be spelled out at the call site rather than
   * buried here where it would quietly become the norm.
   */
  exemptPrefixes?: readonly string[];
  /** Origin the app is served from; only same-origin /api counts as OUR egress. */
  origin?: string;
  /** Called once per newly observed escape, for a loud failure. */
  onEgress?: (entry: EgressEntry) => void;
}

const API_PREFIX = '/api/';

/**
 * PURE classifier: resource-timing entries in, egress report out. Split from the
 * observer so the invariant is unit-testable without a browser, a webview, or a
 * live shell — the thing that decides pass/fail should not need the environment
 * whose bug it is looking for.
 */
export function classifyEgress(
  entries: readonly ResourceTimingLike[],
  opts: EgressOptions = {},
): EgressReport {
  const exempt = opts.exemptPrefixes ?? [];
  const report: EgressReport = { total: 0, byPath: {}, firstAtMs: null, entries: [] };

  for (const e of entries) {
    let path: string;
    try {
      // A relative `name` cannot happen for resource timing (it is always an
      // absolute URL), but a malformed one must not take the monitor down —
      // a crashed detector reports zero, which is indistinguishable from a pass.
      const u = new URL(e.name, opts.origin ?? 'http://localhost');
      if (opts.origin && u.origin !== new URL(opts.origin).origin) continue;
      path = u.pathname;
    } catch {
      continue;
    }
    if (!path.startsWith(API_PREFIX)) continue;
    if (exempt.some((p) => path.startsWith(p))) continue;

    const entry: EgressEntry = { path, startMs: e.startTime, durationMs: e.duration };
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
  return report;
}

export interface EgressMonitorHandle {
  /** The report as of now. */
  report(): EgressReport;
  /** Stop observing. Idempotent. */
  stop(): void;
}

let active: EgressMonitorHandle | null = null;

/**
 * Start watching for egress. Returns null when the environment cannot observe
 * it (no PerformanceObserver / no resource-timing support) — null means UNKNOWN,
 * never "clean": a caller that treats a missing monitor as a pass has re-created
 * the silent failure this exists to remove.
 */
export function installEgressMonitor(opts: EgressOptions = {}): EgressMonitorHandle | null {
  if (active) return active;
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return null;

  const seen: ResourceTimingLike[] = [];
  const origin = opts.origin ?? window.location?.origin;
  const options: EgressOptions = { ...opts, origin };
  let reported = 0;

  const ingest = (list: readonly ResourceTimingLike[]): void => {
    for (const e of list) seen.push({ name: e.name, startTime: e.startTime, duration: e.duration });
    if (seen.length > EGRESS_RING_SIZE * 4) seen.splice(0, seen.length - EGRESS_RING_SIZE * 4);
    const r = classifyEgress(seen, options);
    // Announce only what is NEW, so a repeated buffered replay cannot spam.
    for (let i = reported; i < r.entries.length; i++) opts.onEgress?.(r.entries[i]);
    reported = r.entries.length;
  };

  let observer: PerformanceObserver;
  try {
    observer = new PerformanceObserver((list) => ingest(list.getEntries() as ResourceTimingLike[]));
    // buffered:true replays entries recorded BEFORE this call — the pre-polyfill
    // window is exactly where the known offenders live.
    observer.observe({ type: 'resource', buffered: true } as PerformanceObserverInit);
  } catch {
    return null;
  }

  const handle: EgressMonitorHandle = {
    report: () => classifyEgress(seen, options),
    stop: () => {
      try {
        observer.disconnect();
      } catch {
        // Already disconnected — stop() is idempotent by contract.
      }
      if (active === handle) active = null;
    },
  };
  active = handle;

  // Readable from outside the app (a CI check or `tauri-agent-tools eval` reads
  // this rather than re-deriving the rule), and from inside for a UI surface.
  (window as unknown as Record<string, unknown>).__papercusp_egress__ = {
    report: () => handle.report(),
  };
  return handle;
}

/** The live report, or null when no monitor is installed (UNKNOWN, not clean). */
export function getEgressReport(): EgressReport | null {
  return active ? active.report() : null;
}

/** Test-only: drop the process-wide handle. */
export function _resetEgressMonitorForTests(): void {
  active?.stop();
  active = null;
}
