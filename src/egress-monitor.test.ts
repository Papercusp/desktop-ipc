/**
 * @vitest-environment jsdom
 *
 * The egress invariant: inside the desktop shell, an `/api/*` request that
 * reaches the real network stack is a bug (no-http-anywhere-2026-07-28 D-005,
 * P-003a). These tests pin the CLASSIFIER, which is deliberately pure so the
 * rule can be verified without the environment whose bug it detects.
 *
 * The fixture in "the measured 2026-07-28 shell" is real data, not invented:
 * it is the 9 escapes read out of a live Tauri webview's resource timing.
 *
 * ⚠ THE LESSON THIS FILE NOW CARRIES (WI-6657). Every test here used to run
 * against `ORIGIN = 'http://127.0.0.1:3270'` — the DEV shell. The packaged app
 * serves its document from `papercusp://localhost`, and against THAT origin the
 * classifier silently discarded 100% of escapes. A green suite therefore proved
 * the rule worked in the one shell we do not ship. Whenever this sensor is
 * touched, assert it under BOTH document origins: `PACKAGED_ORIGIN` is the one
 * that matters, and it is the one that was missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetEgressMonitorForTests,
  classifyEgress,
  EGRESS_CONTROL_PARAM,
  EGRESS_RING_SIZE,
  installEgressMonitor,
  type EgressSensorState,
  type ResourceTimingLike,
} from './egress-monitor';

const r = (name: string, startTime: number, duration = 5): ResourceTimingLike => ({
  name,
  startTime,
  duration,
});

/** The dev shell: the document has a real http origin. */
const ORIGIN = 'http://127.0.0.1:3270';
/** The SHIPPED shell: the document is served over the custom protocol. */
const PACKAGED_ORIGIN = 'papercusp://localhost';

const PROVEN: EgressSensorState = {
  controlObserved: true,
  resourceTiming: true,
  transportsWrapped: true,
  blindTo: [],
};

/** The nine escapes measured in a live shell on 2026-07-28. */
const MEASURED_ESCAPES: readonly ResourceTimingLike[] = [
  r(`${ORIGIN}/api/desktop/dev-operators`, 480, 8),
  r(`${ORIGIN}/api/desktop/telemetry-config`, 495, 3),
  r(`${ORIGIN}/api/desktop/version`, 501, 1),
  r(`${ORIGIN}/api/desktop/dev-operators`, 569, 8),
  r(`${ORIGIN}/api/desktop/telemetry-config`, 577, 4),
  r(`${ORIGIN}/api/desktop/version`, 578, 2),
  r(`${ORIGIN}/api/desktop/setup-wizard-state`, 637, 4),
  r(`${ORIGIN}/api/desktop/git-pipeline`, 783, 1816),
  r(`${ORIGIN}/api/desktop/git-pipeline`, 783, 1816),
];

describe('classifyEgress', () => {
  it('reports zero for a shell whose /api traffic all went over IPC', () => {
    // IPC-routed requests produce NO resource-timing entry at all — that is the
    // whole reason this sensor is exact. A clean shell still loads assets.
    const report = classifyEgress(
      [r(`${ORIGIN}/assets/client-abc.js`, 120), r(`${ORIGIN}/assets/app.css`, 130)],
      { documentOrigin: ORIGIN },
      PROVEN,
    );
    expect(report.total).toBe(0);
    expect(report.verdict).toBe('clean');
    expect(report.firstAtMs).toBeNull();
    expect(report.entries).toEqual([]);
  });

  it('flags every /api escape from the measured 2026-07-28 shell', () => {
    const report = classifyEgress(
      [...MEASURED_ESCAPES, r(`${ORIGIN}/assets/client-abc.js`, 120)],
      { documentOrigin: ORIGIN },
      PROVEN,
    );
    expect(report.total).toBe(9);
    expect(report.verdict).toBe('breach');
    expect(report.firstAtMs).toBe(480);
    // Per-path rollup makes the repeat offender obvious without reading entries.
    expect(report.byPath['/api/desktop/dev-operators'].count).toBe(2);
    expect(report.byPath['/api/desktop/git-pipeline']).toEqual({
      count: 2,
      totalMs: 3632,
      firstAtMs: 783,
    });
    expect(Object.keys(report.byPath)).toHaveLength(5);
  });

  /**
   * THE REGRESSION. This is the case the old suite could not express, because
   * `origin` was assumed to be an http origin. The shipped app's document origin
   * parses to the string "null", so the old same-origin gate matched nothing and
   * every escape was dropped before the `/api/` rule ran.
   */
  it('counts escapes in the PACKAGED shell, where the document origin is not http', () => {
    const report = classifyEgress(
      MEASURED_ESCAPES,
      { documentOrigin: PACKAGED_ORIGIN },
      PROVEN,
    );
    expect(report.total).toBe(9);
    expect(report.verdict).toBe('breach');
    expect(Object.keys(report.byPath)).toHaveLength(5);
  });

  it('counts a packaged-shell escape to ANY host — there is no same-origin to be', () => {
    // Under a custom scheme the sidecar's origin is not the document's, so an
    // origin filter cannot distinguish ours from theirs. Every http request has
    // left the intended transport, so every one of them counts.
    const report = classifyEgress(
      [r('http://127.0.0.1:9999/api/desktop/version', 10), r('https://elsewhere.test/api/x', 20)],
      { documentOrigin: PACKAGED_ORIGIN },
      PROVEN,
    );
    expect(report.total).toBe(2);
  });

  it('ignores a cross-origin /api call when the document DOES have an http origin', () => {
    const report = classifyEgress([r('https://api.example.com/api/thing', 200)], {
      documentOrigin: ORIGIN,
    });
    expect(report.total).toBe(0);
  });

  it('never counts a non-network scheme as egress', () => {
    // Measured: WebKitGTK records none of these anyway, but the rule must not
    // depend on that — a `papercusp://` or `blob:` load never hit the network.
    const report = classifyEgress(
      [
        r('papercusp://localhost/api/desktop/version', 10),
        r('blob:papercusp://localhost/9d233dbc-abb1', 20),
        r('data:application/json,{"a":1}', 30),
      ],
      { documentOrigin: PACKAGED_ORIGIN },
      PROVEN,
    );
    expect(report.total).toBe(0);
    expect(report.verdict).toBe('clean');
  });

  it('honours declared exemptions by path prefix', () => {
    const entries = [
      r(`${ORIGIN}/api/desktop/version`, 100),
      r(`${ORIGIN}/api/zero-harness/rest-query`, 200),
    ];
    const report = classifyEgress(entries, {
      documentOrigin: ORIGIN,
      exemptPrefixes: ['/api/desktop/'],
    });
    expect(report.total).toBe(1);
    expect(report.byPath['/api/zero-harness/rest-query'].count).toBe(1);
  });

  it('survives a malformed entry name instead of reporting a false clean', () => {
    // A detector that throws reports zero, which is indistinguishable from a pass —
    // the exact failure mode this whole item exists to eliminate.
    const report = classifyEgress(
      [{ name: '::::not a url', startTime: 1, duration: 1 }, r(`${ORIGIN}/api/desktop/version`, 2)],
      { documentOrigin: ORIGIN },
    );
    expect(report.total).toBe(1);
  });

  it('orders entries by start time and bounds the ring', () => {
    const many = Array.from({ length: EGRESS_RING_SIZE + 40 }, (_, i) =>
      r(`${ORIGIN}/api/x/${i}`, EGRESS_RING_SIZE + 40 - i),
    );
    const report = classifyEgress(many, { documentOrigin: ORIGIN });
    expect(report.total).toBe(EGRESS_RING_SIZE + 40);
    expect(report.entries).toHaveLength(EGRESS_RING_SIZE);
    // Sorted ascending, and it is the LATEST window that is retained.
    expect(report.entries[0].startMs).toBeLessThan(
      report.entries[report.entries.length - 1].startMs,
    );
  });

  it('counts an XHR-issued /api call the fetch polyfill never saw (P-010)', () => {
    // Resource timing is transport-agnostic: this is why the sensor sits here
    // rather than inside the patched fetch, which XHR bypasses entirely.
    const report = classifyEgress([r(`${ORIGIN}/api/desktop/version`, 300)], {
      documentOrigin: ORIGIN,
    });
    expect(report.total).toBe(1);
  });

  it('does not count the sensor’s own proof-of-life request', () => {
    const report = classifyEgress(
      [r(`${ORIGIN}/api/__egress_control__?${EGRESS_CONTROL_PARAM}=abc123`, 5)],
      { documentOrigin: ORIGIN },
      PROVEN,
    );
    expect(report.total).toBe(0);
    expect(report.verdict).toBe('clean');
  });
});

/**
 * The three-valued verdict exists because zero escapes and a dead sensor are the
 * same number. These tests pin the asymmetry: a NEGATIVE claim needs proof, a
 * POSITIVE observation does not.
 */
describe('the verdict is three-valued', () => {
  it('is unknown — never clean — when the sensor was never proven live', () => {
    const report = classifyEgress([r(`${ORIGIN}/assets/app.js`, 10)], { documentOrigin: ORIGIN });
    expect(report.total).toBe(0);
    expect(report.verdict).toBe('unknown');
  });

  it('is clean only once a control request has been observed', () => {
    const entries = [r(`${ORIGIN}/assets/app.js`, 10)];
    expect(classifyEgress(entries, { documentOrigin: ORIGIN }, PROVEN).verdict).toBe('clean');
  });

  it('is breach on an observed escape even with an unproven sensor', () => {
    // Seeing an escape is evidence in itself — it needs no control.
    const report = classifyEgress([r(`${ORIGIN}/api/desktop/version`, 10)], {
      documentOrigin: ORIGIN,
    });
    expect(report.sensor.controlObserved).toBe(false);
    expect(report.verdict).toBe('breach');
  });
});

/**
 * Resource timing provably records NOTHING for WebSocket or EventSource — the
 * probe's own server confirmed both connections were established while the
 * buffer stayed empty. Desktop sync is SSE-primary, so without these wrappers
 * the sensor is blind to the app's main data transport.
 */
describe('the transports resource timing cannot see', () => {
  /**
   * jsdom ships no EventSource, so the wrapper would find nothing to wrap and
   * these tests would vacuously pass — the same shape of false green this whole
   * item is about. Install a stand-in so the wrapping is genuinely exercised.
   */
  class FakeEventSource {
    constructor(readonly url: string) {}
  }
  const realEventSource = (window as unknown as Record<string, unknown>).EventSource;

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).EventSource = FakeEventSource;
  });

  afterEach(() => {
    _resetEgressMonitorForTests();
    (window as unknown as Record<string, unknown>).EventSource = realEventSource;
    vi.unstubAllGlobals();
  });

  it('records a WebSocket opened to an /api path', () => {
    const handle = installEgressMonitor({ documentOrigin: PACKAGED_ORIGIN });
    expect(handle).not.toBeNull();
    expect(handle?.report().sensor.transportsWrapped).toBe(true);

    new window.WebSocket('ws://127.0.0.1:3270/api/sync/stream');

    const report = handle!.report();
    expect(report.total).toBe(1);
    expect(report.verdict).toBe('breach');
    expect(report.entries[0].via).toBe('websocket');
    expect(report.entries[0].path).toBe('/api/sync/stream');
  });

  it('records a native EventSource opened to an /api path', () => {
    const handle = installEgressMonitor({ documentOrigin: PACKAGED_ORIGIN });
    new (window as unknown as { EventSource: new (u: string) => unknown }).EventSource(
      'http://127.0.0.1:3270/api/sync/sse',
    );

    const report = handle!.report();
    expect(report.total).toBe(1);
    expect(report.entries[0].via).toBe('eventsource');
  });

  it('leaves a stream that never leaves the app alone', () => {
    const handle = installEgressMonitor({ documentOrigin: PACKAGED_ORIGIN });
    // Routed over the custom protocol: it never reaches the network stack.
    new (window as unknown as { EventSource: new (u: string) => unknown }).EventSource(
      'papercusp://localhost/api/sync/sse',
    );
    expect(handle!.report().total).toBe(0);
  });

  it('restores the original constructors on stop, and is idempotent', () => {
    const before = window.WebSocket;
    const handle = installEgressMonitor({ documentOrigin: PACKAGED_ORIGIN });
    expect(window.WebSocket).not.toBe(before);
    handle!.stop();
    expect(window.WebSocket).toBe(before);
    handle!.stop();
    expect(window.WebSocket).toBe(before);
  });

  it('names what it still cannot see rather than implying full coverage', () => {
    const handle = installEgressMonitor({ documentOrigin: PACKAGED_ORIGIN });
    const { blindTo } = handle!.report().sensor;
    // A constructor wrapper cannot see backwards the way buffered:true can.
    expect(blindTo.join(' ')).toMatch(/BEFORE this monitor installed/);
  });
});

/**
 * The DESTINATION axis (egress-monitor-origin-axis-2026-08-02 P-001/P-002).
 *
 * These are regression tests for a REAL months-long blindness, so the fixtures
 * are the actual URLs from the 2026-08-02 audit rather than invented hosts. All
 * six shipped under a live, healthy, correctly-working monitor — it was simply
 * answering a different question (`/api/*` on OUR origin escaping IPC), and its
 * two filters discarded every one of them before the rule ever ran.
 *
 * Per this file's own standing lesson, every case is asserted under BOTH
 * document origins: the dev shell discarded them at the same-origin narrowing,
 * the packaged shell at the `/api/` prefix check. Blind in both, for different
 * reasons — so a test under one origin alone would prove nothing.
 */
describe('foreign-origin axis', () => {
  /** A sensor proven alive, so a zero can legitimately read `clean`. */
  const PROVEN: EgressSensorState = {
    controlObserved: true,
    resourceTiming: true,
    transportsWrapped: true,
    blindTo: [],
  };

  /** The real offenders, as measured in the built bundle on 2026-08-02. */
  const VDITOR = 'https://unpkg.com/vditor@3.11.2/dist/js/lute/lute.min.js';
  const MONACO = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/loader.js';
  const MONACO_2 = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/editor/editor.main.css';

  for (const [label, origin] of [
    ['dev shell', ORIGIN],
    ['packaged shell', PACKAGED_ORIGIN],
  ] as const) {
    it(`catches a public-CDN fetch in the ${label}`, () => {
      const report = classifyEgress([r(VDITOR, 480)], { documentOrigin: origin }, PROVEN);

      expect(report.foreignOrigin.total).toBe(1);
      expect(report.foreignOrigin.verdict).toBe('breach');
      expect(report.foreignOrigin.byOrigin['https://unpkg.com'].count).toBe(1);
      // ...and it is NOT counted as a transport escape: it is not our API at all.
      expect(report.total).toBe(0);
    });
  }

  it('does not treat loopback as foreign, in either shell', () => {
    const local = [
      r('http://localhost:3070/assets/app.js', 10),
      r('http://127.0.0.1:3270/api/harness/list', 20),
      r('http://[::1]:3070/assets/x.css', 30),
    ];

    for (const origin of [ORIGIN, PACKAGED_ORIGIN]) {
      const report = classifyEgress(local, { documentOrigin: origin }, PROVEN);
      expect(report.foreignOrigin.total).toBe(0);
      expect(report.foreignOrigin.verdict).toBe('clean');
    }
  });

  it('keeps the two axes independent', () => {
    // An /api call on OUR origin that escaped IPC is a TRANSPORT bug only.
    // A CDN fetch is a DESTINATION bug only. One report, two separate counts —
    // collapsing them would hide which of two very different fixes is needed.
    const report = classifyEgress(
      [r(`${ORIGIN}/api/harness/list`, 100), r(MONACO, 200)],
      { documentOrigin: ORIGIN },
      PROVEN,
    );

    expect(report.total).toBe(1);
    expect(report.entries[0].axis).toBe('ipc-escape');
    expect(report.entries[0].path).toBe('/api/harness/list');

    expect(report.foreignOrigin.total).toBe(1);
    expect(report.foreignOrigin.entries[0].axis).toBe('foreign-origin');
    expect(report.foreignOrigin.entries[0].url).toBe(MONACO);
  });

  it("classifies a THIRD PARTY's /api path per shell — and the axes CAN overlap", () => {
    // Pinning REAL behaviour, including an overlap that is easy to misread.
    //
    // Dev shell: the same-origin narrowing drops it from the transport axis, so
    // it is purely a destination finding.
    const dev = classifyEgress(
      [r('https://api.example.com/api/v1/thing', 50)],
      { documentOrigin: ORIGIN },
      PROVEN,
    );
    expect(dev.foreignOrigin.total).toBe(1);
    expect(dev.total).toBe(0);

    // Packaged shell: there is no http origin to be same-origin WITH, so the
    // transport axis deliberately filters NOTHING by origin (see the file
    // header — filtering there is what discarded 100% of real escapes). A
    // foreign `/api/` path therefore trips BOTH axes.
    //
    // This overlap is left AS-IS on purpose. Suppressing the transport hit for
    // foreign origins would quietly narrow a shipped safety invariant that was
    // written with explicit reasoning, to fix nothing worse than a double-count
    // — and the destination entry alongside it already tells the triager it is
    // someone else's host, not our IPC layer leaking.
    const packaged = classifyEgress(
      [r('https://api.example.com/api/v1/thing', 50)],
      { documentOrigin: PACKAGED_ORIGIN },
      PROVEN,
    );
    expect(packaged.foreignOrigin.total).toBe(1);
    expect(packaged.total).toBe(1);
  });

  it('rolls up by ORIGIN so one offender is one row, not fifteen', () => {
    // Monaco alone pulls a dozen chunks from one host. Rolling up by path the
    // way the transport axis does would bury a single bug under a wall of rows.
    const report = classifyEgress(
      [r(MONACO, 10), r(MONACO_2, 20), r(VDITOR, 30)],
      { documentOrigin: ORIGIN },
      PROVEN,
    );

    expect(Object.keys(report.foreignOrigin.byOrigin).sort()).toEqual([
      'https://cdn.jsdelivr.net',
      'https://unpkg.com',
    ]);
    expect(report.foreignOrigin.byOrigin['https://cdn.jsdelivr.net'].count).toBe(2);
    expect(report.foreignOrigin.byOrigin['https://cdn.jsdelivr.net'].firstAtMs).toBe(10);
  });

  it('honours an explicit allowlist without weakening the rest', () => {
    const report = classifyEgress(
      [r('https://declared.example.com/thing.js', 10), r(VDITOR, 20)],
      { documentOrigin: ORIGIN, allowedOrigins: ['https://declared.example.com'] },
      PROVEN,
    );

    expect(report.foreignOrigin.total).toBe(1);
    expect(report.foreignOrigin.byOrigin['https://unpkg.com']).toBeTruthy();
  });

  it('reports UNKNOWN, not clean, when the sensor was never proven', () => {
    // The whole point of the three-valued verdict, carried onto the new axis: a
    // dead detector and a genuinely clean run both report zero, and reading that
    // zero as "no CDN fetches" is exactly the false all-clear this axis exists
    // to prevent.
    const report = classifyEgress([], { documentOrigin: PACKAGED_ORIGIN });

    expect(report.foreignOrigin.total).toBe(0);
    expect(report.foreignOrigin.verdict).toBe('unknown');
  });

  it('never counts the sensor’s own control request', () => {
    const control = `${ORIGIN}/__egress_control__?${EGRESS_CONTROL_PARAM}=abc123`;
    const report = classifyEgress([r(control, 5)], { documentOrigin: PACKAGED_ORIGIN }, PROVEN);

    // Under the packaged origin this is a non-local http request and would
    // otherwise read as foreign — the control exclusion has to apply to BOTH
    // axes or proving the sensor alive would itself trip the new rule.
    expect(report.foreignOrigin.total).toBe(0);
    expect(report.total).toBe(0);
  });

  it('sees a foreign WebSocket, which resource timing cannot report at all', () => {
    const report = classifyEgress(
      [{ name: 'wss://realtime.example.com/socket', startTime: 40, duration: 0, via: 'websocket' }],
      { documentOrigin: ORIGIN },
      PROVEN,
    );

    expect(report.foreignOrigin.total).toBe(1);
    expect(report.foreignOrigin.entries[0].via).toBe('websocket');
  });
});
