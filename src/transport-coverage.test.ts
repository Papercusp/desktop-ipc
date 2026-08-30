/**
 * P-022 (no-http-anywhere-2026-07-28), built RE-SCOPED per that plan's D-062.
 *
 * ── WHY THIS IS NOT THE LINT P-022'S TITLE ASKS FOR ─────────────────────────
 *
 * P-022 reads "lint: no native fetch / EventSource / WebSocket / XMLHttpRequest
 * in app code — the guard that makes a fifth recurrence impossible." The goal is
 * right; the mechanism cannot deliver it, and D-062 records the measurement:
 *
 *   - The literal rule flags 478 call sites across 198 files, on correct code.
 *     `scripts/check-no-cdn-egress.mjs` documents that exact failure in its own
 *     header ("a guard whose first run reports 500 findings on correct code is a
 *     guard someone silences"). A 478-row baseline is ceremony, not safety.
 *   - Worse, it would have caught NONE of the four recurrences it exists to
 *     prevent. Every one was a hole in the POLYFILL, not app code misusing a
 *     transport: P-009 an unhandled `fetch(new Request(...))` FORM, P-010 an
 *     entirely unpatched global, P-011 an install that ran too LATE, P-013 an
 *     unguarded global. App code calling `fetch('/api/x')` is CORRECT — the
 *     polyfill replaces `window.fetch`, so ordinary call sites are routed.
 *
 * A fifth recurrence is therefore, by definition, a network-capable surface
 * reachable from the webview that is in NEITHER the routed nor the guarded set.
 * That is what this file asserts: coverage COMPLETENESS over a declared
 * inventory, not a ban over call sites. It is small, stable and needs no
 * baseline, because it scales with the web platform rather than with our code.
 *
 * ── HOW IT MAKES A FIFTH RECURRENCE HARD ────────────────────────────────────
 *
 * `NETWORK_CAPABLE_SURFACES` below is the curated list of ways webview code can
 * reach the network. Every entry MUST carry a treatment, and `uncovered` MUST
 * carry a reason. So a new transport cannot be adopted silently: whoever adds it
 * has to classify it here and say why, in a file whose whole subject is that
 * decision. That converts "nobody thought about it" — the actual failure mode
 * all four times — into a deliberate, reviewable act.
 *
 * The list is knowledge, not something derivable: the runtime cannot enumerate
 * "APIs that can reach the network". Adding to it as the platform grows IS the
 * maintenance burden, and it is the right one to carry.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Treatment = 'routed' | 'guarded' | 'uncovered';
type PortalTreatment =
  | 'control-http-sse'
  | 'reverse-connector-stream'
  | 'bulk-transfer'
  | 'native-only'
  | 'uncovered';

interface PortalDisposition {
  readonly treatment: PortalTreatment;
  readonly origin: string;
  readonly auth: string;
  readonly byoc: string;
  readonly reason: string;
}

interface Surface {
  /** The global as webview code names it. */
  readonly name: string;
  readonly treatment: Treatment;
  /**
   * For routed/guarded: a symbol that MUST appear in desktop-bootstrap.ts, so
   * deleting the wiring fails here rather than silently reopening the door.
   */
  readonly wiredBy?: string;
  /** For uncovered: why it is acceptable that nothing handles this today. */
  readonly reason?: string;
  /**
   * The browser portal is a different transport profile from the desktop
   * webview. Keep its disposition beside the desktop treatment so the
   * desktop-only registry cannot read as a complete portal census.
   */
  readonly portal: PortalDisposition;
}

const portal = (
  treatment: PortalTreatment,
  origin: string,
  auth: string,
  byoc: string,
  reason: string,
): PortalDisposition => ({ treatment, origin, auth, byoc, reason });

const NETWORK_CAPABLE_SURFACES: readonly Surface[] = [
  // ---- ROUTED: traffic is carried over the IPC channel ----
  {
    name: 'fetch',
    treatment: 'routed',
    wiredBy: 'window.fetch = patchedFetch',
    portal: portal(
      'control-http-sse',
      'portal control origin and explicitly configured support origins',
      'same-origin session credentials or the owning endpoint contract',
      'BYOC pages use the authenticated tenant-aware control-plane contract',
      'Browser fetch is the finite control-plane path: named-query reads, session calls, REST mutations, lifecycle actions, and portal shell work must enter the shared per-origin scheduler rather than relying on the desktop IPC polyfill.',
    ),
  },
  {
    name: 'EventSource',
    treatment: 'routed',
    wiredBy: 'IpcEventSource',
    portal: portal(
      'control-http-sse',
      'portal control origin, with explicit non-control origins documented per stream',
      'same-origin cookies/credentials or a stream-specific authenticated session',
      'Hosted control SSE is tenant-scoped; connector streams use their own ticket',
      'The browser does not install IpcEventSource. The sanctioned sync SSE is one standing control stream, while every additional EventSource must be consolidated or registered against the portal origin budget instead of being treated as IPC.',
    ),
  },

  // ---- GUARDED: not carried, but refused/flagged so it cannot silently escape ----
  {
    name: 'XMLHttpRequest',
    treatment: 'guarded',
    wiredBy: 'installXhrGuard',
    portal: portal(
      'uncovered',
      'any browser origin',
      'whatever the caller supplies; no active portal constructor is present',
      'No BYOC browser dependency is currently registered',
      'No active operator or portal application constructs XMLHttpRequest today. The desktop guard remains a useful recurrence barrier, but a future browser use must be routed through the shared fetch contract or explicitly reviewed here first.',
    ),
  },
  {
    name: 'WebSocket',
    treatment: 'guarded',
    wiredBy: 'installWsGuard',
    portal: portal(
      'reverse-connector-stream',
      'portal control origin for hosted relay; dedicated origin for optional PTY/voice paths',
      'single-use generation-bound hosted ticket, or the owning native session handshake',
      'Hosted connector socket is a BYOC reverse-connector surface, not control SSE',
      'The hosted handler upgrades /api/hosted/connectors/socket on the same HTTP listener as the SPA and authenticates a single-use ticket. PTY and desktop voice sockets are separate explicit exceptions, so none may consume reserved control capacity silently.',
    ),
  },

  // ---- UNCOVERED: deliberate, with the reason recorded ----
  {
    name: 'Worker',
    treatment: 'uncovered',
    reason:
      'THE STRONGEST fifth-recurrence candidate (D-062). A worker gets a FRESH ' +
      'global scope, so the main-window patches above simply do not apply and a ' +
      'fetch() inside one bypasses every treatment. Acceptable ONLY because the ' +
      'webview currently constructs no Worker: the two `new Worker` sites in the ' +
      'repo are Node worker_threads in server-side libs (tooldef/code-orchestration ' +
      'run-script.ts, memory/local-embedder-worker.ts), which never run in the ' +
      'webview. This is a coverage gap, not a live bug — which is exactly the ' +
      'state XMLHttpRequest and WebSocket were in before someone used them. ' +
      'Introducing a webview Worker REQUIRES routing or guarding its scope first.',
    portal: portal(
      'uncovered',
      'browser worker origin',
      'worker inherits only what its code explicitly supplies',
      'No hosted worker capability is registered',
      'The portal currently constructs no browser Worker. A worker has a fresh global scope, so it would bypass document-level fetch and EventSource treatment and must become an explicit routed or guarded capability before adoption.',
    ),
  },
  {
    name: 'SharedWorker',
    treatment: 'uncovered',
    reason: 'Same fresh-global-scope problem as Worker, and likewise unused by the webview.',
    portal: portal(
      'uncovered',
      'browser shared-worker origin',
      'shared worker code must provide its own authenticated requests',
      'No hosted shared-worker capability is registered',
      'No portal code constructs a SharedWorker. Its independent global scope would evade the document transport boundary, so introducing one requires an explicit scheduler and authentication decision rather than inheriting the shell behavior implicitly.',
    ),
  },
  {
    name: 'sendBeacon',
    treatment: 'uncovered',
    reason:
      'Unused by our code. Note the RUNTIME leg is ahead of the static one here: ' +
      'egress-monitor.ts already records sendBeacon, so an actual use would be ' +
      'observed live even though nothing prevents it statically.',
    portal: portal(
      'uncovered',
      'the current document origin',
      'browser-managed credentials; no active portal call site',
      'No BYOC beacon contract is registered',
      'No portal code uses sendBeacon. The desktop egress monitor can observe a future use, but observation is not scheduling or authentication; adoption would need a bounded telemetry contract and an explicit decision about whether it is allowed on BYOC pages.',
    ),
  },
  {
    name: 'WebTransport',
    treatment: 'uncovered',
    reason: 'Not used, and not implemented by the WebKitGTK build the Linux desktop ships.',
    portal: portal(
      'uncovered',
      'browser-selected WebTransport origin',
      'not applicable while unused',
      'No hosted WebTransport capability is registered',
      'The portal has no WebTransport client and the shipped Linux WebKitGTK runtime does not implement it. A future adoption would be a new transport class requiring its own origin budget, ticket/authentication posture, and browser fallback.',
    ),
  },
  {
    name: 'RTCPeerConnection',
    treatment: 'uncovered',
    reason:
      'Not used for /api traffic. The p2p-voice stack is a separate LISTENER on its ' +
      'own origin, which ws-guard.ts deliberately exempts as one that "must keep its ' +
      'native socket" — so it is out of scope for this plan, not an oversight.',
    portal: portal(
      'native-only',
      'dedicated p2p voice origin, not the portal control origin',
      'p2p session handshake',
      'No browser BYOC parity is claimed for p2p voice',
      'RTCPeerConnection is not a portal /api transport. The p2p voice stack owns a separate listener and native session contract, so it remains an explicit non-control exception rather than being folded into the portal HTTP/1.1 scheduler budget.',
    ),
  },
  {
    name: 'serviceWorker',
    treatment: 'uncovered',
    reason:
      'None registered. A service worker would intercept requests from OUTSIDE the ' +
      'patched document scope, so registering one requires re-deciding this file.',
    portal: portal(
      'uncovered',
      'service-worker scope and controlled document origins',
      'service-worker code must enforce its own session boundary',
      'No hosted service-worker capability is registered',
      'No service worker is registered by the portal. Because it intercepts requests outside the document scope, adding one would create a second transport policy and could bypass tenant-aware auth and scheduler limits unless explicitly integrated first.',
    ),
  },
];

const bootstrapSource = readFileSync(
  fileURLToPath(new URL('./desktop-bootstrap.ts', import.meta.url)),
  'utf8',
);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

interface PortalInventoryEntry {
  readonly id: string;
  readonly surface: string;
  readonly file: string;
  readonly sourceNeedle: string;
  readonly route: string;
  readonly origin: string;
  readonly auth: string;
  readonly byoc: string;
  readonly bucket: PortalTreatment;
  readonly note: string;
}

const opener = (
  id: string,
  surface: string,
  file: string,
  sourceNeedle: string,
  route: string,
  origin: string,
  auth: string,
  byoc: string,
  bucket: PortalTreatment,
  note: string,
): PortalInventoryEntry => ({
  id,
  surface,
  file,
  sourceNeedle,
  route,
  origin,
  auth,
  byoc,
  bucket,
  note,
});

/**
 * Browser-side standing streams and fetch streams outside the sanctioned sync
 * adapter. This is a CALL-SITE census, not a concurrency measurement: most
 * entries exist only while their component is mounted, so the list does not
 * imply that every socket is simultaneously open.
 */
const PORTAL_STREAM_OPENERS: readonly PortalInventoryEntry[] = [
  opener(
    'admin-command-card',
    'EventSource',
    'apps/operator/app/admin/_components/CommandCard.tsx',
    '/api/admin/run?cmd=',
    '/api/admin/run?cmd=',
    'portal control origin',
    'same-origin operator session',
    'control-plane command stream; not a BYOC connector',
    'control-http-sse',
    'one-shot command output stream outside the sync adapter',
  ),
  opener(
    'features-admin-flags',
    'EventSource',
    'apps/operator/app/admin/features/FeaturesAdmin.tsx',
    "url: '/api/flags/stream'",
    '/api/flags/stream',
    'portal control origin',
    'same-origin credentials',
    'tenant-aware hosted flag stream when exposed',
    'control-http-sse',
    'same logical route as the shared flag client and should share its lease',
  ),
  opener(
    'structured-stream-view',
    'EventSource',
    'apps/operator/app/_components/StructuredStreamView.tsx',
    'const source = createResilientEventSource({',
    'caller-supplied url prop',
    'caller-selected; commonly portal control origin',
    'caller-supplied stream session',
    'depends on the caller; no implicit connector claim',
    'control-http-sse',
    'generic stream shell whose dynamic route must remain explicitly classified',
  ),
  opener(
    'operator-panel-scan',
    'EventSource',
    'apps/operator/app/_components/OperatorPanel.tsx',
    '/api/agent-mcp/operator-scan?request=',
    '/api/agent-mcp/operator-scan?request=',
    'portal control origin',
    'same-origin operator session',
    'hosted operator control-plane scan',
    'control-http-sse',
    'one-shot operator scan stream outside the sync adapter',
  ),
  opener(
    'pi-panel-sse',
    'EventSource',
    'apps/operator/app/harness/PiPanel.tsx',
    '/api/harness/${encodeURIComponent(slug)}/pty/${handle.id}/stream',
    '/api/harness/:slug/pty/:id/stream',
    'portal control origin or local operator origin',
    'harness/operator session',
    'hosted PTY fallback; native Tauri PTY remains richer',
    'reverse-connector-stream',
    'terminal data is not a control invalidation stream',
  ),
  opener(
    'agent-thinking-stream',
    'EventSource',
    'apps/operator/app/harness/AgentThinkingStream.tsx',
    '/api/harness/${slug}/agents/${runId}/stream?phase=',
    '/api/harness/:slug/agents/:runId/stream?phase=',
    'portal control origin',
    'harness/session authorization',
    'tenant-aware hosted agent run stream',
    'reverse-connector-stream',
    'run-log payload is separate from the control SSE',
  ),
  opener(
    'dev-terminal-tab',
    'EventSource',
    'apps/operator/app/dev/_components/TerminalTab.tsx',
    '/api/harness/${slug}/pty/${handle.id}/stream',
    '/api/harness/:slug/pty/:id/stream',
    'portal control origin or local operator origin',
    'harness/operator session',
    'hosted PTY stream when native transport is unavailable',
    'reverse-connector-stream',
    'terminal data is separately registered from browser control traffic',
  ),
  opener(
    'plugin-host-events',
    'EventSource',
    'apps/operator/lib/PluginIframe.tsx',
    '/api/plugins/host/events?plugin=',
    '/api/plugins/host/events?plugin=&install=&name=',
    'portal control origin',
    'plugin installation/session authorization',
    'hosted plugin events only for tenant-enabled plugins',
    'control-http-sse',
    'plugin events may need multiplexing but are not sync invalidations',
  ),
  opener(
    'ui-intent-stream',
    'EventSource',
    'apps/operator/lib/ui/intent-dispatcher.tsx',
    '/api/ui/intents/stream?client_id=',
    '/api/ui/intents/stream?client_id=',
    'portal control origin',
    'same-origin session plus tab client id',
    'tenant-scoped hosted UI intent stream',
    'control-http-sse',
    'one app-wide stream per tab outside the sync adapter',
  ),
  opener(
    'state-snapshot-stream',
    'EventSource',
    'apps/operator/lib/use-state-snapshots.ts',
    '/api/operator/state-snapshot?delta=1',
    '/api/operator/state-snapshot?delta=1',
    'portal control origin',
    'same-origin operator session',
    'hosted tenant snapshot only where the route is exposed',
    'control-http-sse',
    'app-wide delta stream that must not silently add an unbounded control socket',
  ),
  opener(
    'leader-bridge-stream',
    'EventSource',
    'packages/operator-core/lib/commands/leader-bridge.ts',
    '/api/agent-mcp/run-command/sse?workspace=',
    '/api/agent-mcp/run-command/sse?workspace=&sessionId=',
    'portal control origin',
    'same-origin session plus workspace/session binding',
    'tenant-scoped hosted command bridge',
    'control-http-sse',
    'singleton per tab, but still outside the sanctioned sync adapter',
  ),
  opener(
    'flag-client-stream',
    'EventSource',
    'libs/flags/src/client.ts',
    'const source = createResilientEventSource({',
    'caller-supplied flag endpoint, default /api/flags/stream',
    'portal control origin by default',
    'same-origin credentials when required',
    'tenant-aware hosted flags contract',
    'control-http-sse',
    'module-level sharing already deduplicates identical endpoint subscribers',
  ),
  opener(
    'operator-conversation-stream',
    'fetch',
    'apps/operator/app/_components/OperatorConversationProvider.tsx',
    '/api/agent-mcp/operator-converse',
    '/api/agent-mcp/operator-converse',
    'portal control origin',
    'same-origin operator session',
    'hosted operator conversation control-plane route',
    'control-http-sse',
    'POST response is parsed as an SSE-like fetch body stream',
  ),
  opener(
    'support-agent-stream',
    'fetch',
    'apps/operator/app/_components/SupportAgentPanel.tsx',
    '/v1/support/chat',
    'API_BASE/v1/support/chat',
    'support service origin, not necessarily the control origin',
    'support service session contract',
    'explicit external support dependency',
    'control-http-sse',
    'external-origin stream must be separately budgeted and authenticated',
  ),
  opener(
    'harness-chat-stream',
    'fetch',
    'apps/operator/app/harness/ChatPanel.tsx',
    '/agent-chats/${encodeURIComponent(chatId)}/messages',
    '/api/harness/:slug/agent-chats/:chatId/messages',
    'portal control origin',
    'harness/session authorization',
    'tenant-aware hosted agent chat stream',
    'control-http-sse',
    'POST response body is parsed as an SSE stream outside the sync adapter',
  ),
  opener(
    'pi-panel-websocket',
    'WebSocket',
    'apps/operator/app/harness/PiPanel.tsx',
    'socket = new WebSocket(wsUrl)',
    'configured PTY WebSocket /pty/:id',
    'dedicated PTY origin; default local port 3056',
    'PTY handle/session contract',
    'browser PTY fallback; Tauri uses native PTY IPC instead',
    'reverse-connector-stream',
    'dedicated terminal stream must not consume control-origin capacity',
  ),
  opener(
    'hosted-workspace-socket',
    'WebSocket',
    'apps/operator/app/cloud-workspaces/HostedWorkspaceSession.tsx',
    'buildHostedWorkspaceSocketUrl(window.location.origin, ticket)',
    '/api/hosted/connectors/socket',
    'portal control origin, upgraded on the SPA HTTP listener',
    'single-use generation-bound hosted ticket',
    'canonical BYOC reverse connector bound to user/org/workspace/host/session',
    'reverse-connector-stream',
    'registered separately so it cannot consume reserved control capacity silently',
  ),
  opener(
    'desktop-voice-socket',
    'WebSocket',
    'apps/operator/app/_components/voice/desktop-operator-voice-client.ts',
    'const ws = wsFactory(url)',
    'desktop-voice-ws dedicated local port',
    'local desktop voice listener',
    'voice-session handshake',
    'no hosted browser parity claim; hosted voice has its own service contract',
    'native-only',
    'dedicated local voice socket is not portal control-origin traffic',
  ),
];

const PORTAL_BULK_TRANSFERS: readonly PortalInventoryEntry[] = [
  opener(
    'hosted-workspace-file-transfer',
    'WebSocket',
    'apps/operator/app/cloud-workspaces/HostedWorkspaceSession.tsx',
    'type: "file.upload"',
    'file.upload/file.download messages over the hosted socket',
    'portal control origin via the hosted relay',
    'same single-use hosted workspace ticket',
    'BYOC workspace file plane',
    'bulk-transfer',
    'base64-framed file data is separately budgeted from control traffic',
  ),
  opener(
    'voice-settings-preview-audio',
    'fetch',
    'apps/operator/app/settings/voice/page.tsx',
    "fetch('/api/agent-mcp/operator-tts-preview'",
    '/api/agent-mcp/operator-tts-preview',
    'portal control origin',
    'same-origin operator session',
    'voice model/audio dependency; not a BYOC connector',
    'bulk-transfer',
    'audio blob download is finite bulk data rather than an event stream',
  ),
  opener(
    'voice-settings-conversation-audio',
    'fetch',
    'apps/operator/app/settings/voice/page.tsx',
    "fetch('/api/agent-mcp/operator-conv-voice'",
    '/api/agent-mcp/operator-conv-voice',
    'portal control origin',
    'same-origin operator session',
    'conversation-voice audio dependency; not a BYOC connector',
    'bulk-transfer',
    'audio blob download is finite bulk data rather than an event stream',
  ),
  opener(
    'voice-mode-adapter-audio',
    'fetch',
    'apps/operator/app/_components/voice/voice-mode.ts',
    "fetch('/api/agent-mcp/operator-tts-preview'",
    '/api/agent-mcp/operator-tts-preview',
    'portal control origin',
    'same-origin operator session',
    'voice adapter dependency; not a BYOC connector',
    'bulk-transfer',
    'generated speech audio is a finite blob download',
  ),
];

const PORTAL_NATIVE_CAPABILITIES: readonly PortalInventoryEntry[] = [
  opener(
    'native-pty-session',
    'native-only',
    'packages/operator-core/lib/pty-tauri.ts',
    'export async function openNativeSession',
    'Tauri ptySpawn/ptyWrite/ptyResize/ptyKill commands plus pty-data events',
    'local desktop session',
    'Tauri command permissions plus a harness-aware HTTP resolve step',
    'hosted browser uses the reverse-connector PTY stream instead',
    'native-only',
    'native terminal is the richer desktop path and never opens a browser socket',
  ),
  opener(
    'adv-list-windows',
    'native-only',
    'apps/operator/app/adv/sessions/AdvSessionsClient.tsx',
    'list_windows_by_title',
    "Tauri invoke('list_windows_by_title')",
    'local desktop session',
    'Tauri command permissions and local desktop identity',
    'hosted fallback posts only explicitly available window metadata',
    'native-only',
    'desktop-only window enumeration',
  ),
  opener(
    'adv-focus-window',
    'native-only',
    'apps/operator/app/adv/sessions/AdvSessionsClient.tsx',
    'focus_window_by_title',
    "Tauri invoke('focus_window_by_title')",
    'local desktop session',
    'Tauri command permissions and local desktop identity',
    'server wmctrl path is the explicit non-native fallback',
    'native-only',
    'user-initiated native window focus',
  ),
  opener(
    'external-shell-open',
    'native-only',
    'apps/operator/app/_components/ExternalLinkProvider.tsx',
    'plugin:shell|open',
    "Tauri invoke('plugin:shell|open')",
    'local desktop session',
    'Tauri shell plugin permissions',
    'hosted browser uses normal external-link navigation',
    'native-only',
    'OS-browser handoff is deliberately absent from hosted control routes',
  ),
  opener(
    'setup-folder-dialog',
    'native-only',
    'apps/operator/app/_components/SetupWizard/StepWorkspace.tsx',
    'plugin:dialog|open',
    "Tauri invoke('plugin:dialog|open')",
    'local desktop session',
    'Tauri dialog plugin permissions',
    'hosted browser uses a text/path capability instead of a local picker',
    'native-only',
    'local filesystem chooser with an explicit hosted fallback',
  ),
  opener(
    'endpoint-ipc-stream',
    'native-only',
    'libs/generic/desktop-ipc/src/ipc-stream.ts',
    "invoke<number>('endpoint_invoke'",
    "Tauri invoke('endpoint_invoke') / invoke('endpoint_cancel')",
    'local desktop webview',
    'Tauri endpoint capability and local session',
    'hosted browser uses authenticated HTTP/SSE rather than endpoint IPC',
    'native-only',
    'desktop endpoint stream is a capability seam, not a browser socket',
  ),
];

/**
 * Side A of the census is derived rather than copied: these source pins name
 * the complete sanctioned read/mutation mechanisms. The measured 2026-08-30
 * static counts were 237 named-query keys and 319 notifySyncInvalidate call
 * sites across 177 files; they are evidence, not invariants, and therefore are
 * not frozen as brittle expected counts here.
 */
const PORTAL_CONTROL_PLANE_CONTRACT = [
  {
    id: 'named-query-registry',
    file: 'packages/operator-core/lib/sync-resolver/index.ts',
    sourceNeedle: 'const REGISTRY: Record<string, QueryEntry<unknown>> = {',
  },
  {
    id: 'named-query-handler',
    file: 'libs/generic/sync/src/server/http-routes.ts',
    sourceNeedle: 'GET  rest-query?name=&args=<json>',
  },
  {
    id: 'sync-invalidation-writer',
    file: 'packages/operator-core/lib/sync-sse.ts',
    sourceNeedle: 'notifySyncInvalidate',
  },
  {
    id: 'sync-sse-adapter',
    file: 'libs/generic/sync/src/transports/sse/SSEAdapter.tsx',
    // Re-pointed 2026-08-30: the adapter's resilience (jitter, zombie watchdog,
    // backoff, visibility pause) moved into @papercusp/sse's cross-tab control
    // wrapper, which COMPOSES createResilientEventSource — so the adapter no
    // longer calls that function directly and the old needle went stale ~28min
    // after the refactor landed. Pinned on the new composition point rather
    // than deleted, so the guard keeps its teeth: a raw `new EventSource(...)`
    // here would still trip it. (Nothing selected this test when the refactor
    // landed — a libs/generic/sync change does not pull in desktop-ipc's
    // workspace under test:affected, which is why it went red silently.)
    sourceNeedle: 'createCrossTabControlStream({',
  },
] as const;

function repoSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('transport coverage (P-022 / D-062)', () => {
  it('classifies every network-capable surface — no surface may be left unclassified', () => {
    for (const s of NETWORK_CAPABLE_SURFACES) {
      expect(
        ['routed', 'guarded', 'uncovered'],
        `${s.name} has no valid treatment`,
      ).toContain(s.treatment);
    }
    // Guards against a duplicate entry quietly shadowing a real classification.
    const names = NETWORK_CAPABLE_SURFACES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('requires a REASON for every uncovered surface', () => {
    for (const s of NETWORK_CAPABLE_SURFACES.filter((x) => x.treatment === 'uncovered')) {
      expect(s.reason?.trim(), `${s.name} is uncovered with no stated reason`).toBeTruthy();
      // A one-word "n/a" defeats the purpose: the reason is the review artifact.
      expect(s.reason!.length, `${s.name}'s reason is too thin to review`).toBeGreaterThan(40);
    }
  });

  it('holds the four covered doors OPEN — each must still be wired in desktop-bootstrap', () => {
    // The four recurrences this plan closed. If wiring is deleted or renamed,
    // this fails here instead of at runtime in a shipped desktop.
    const covered = NETWORK_CAPABLE_SURFACES.filter(
      (s) => s.treatment === 'routed' || s.treatment === 'guarded',
    );
    expect(covered).toHaveLength(4);
    for (const s of covered) {
      expect(s.wiredBy, `${s.name} is ${s.treatment} but names no wiring symbol`).toBeTruthy();
      expect(
        bootstrapSource.includes(s.wiredBy!),
        `${s.name} is declared ${s.treatment} via "${s.wiredBy}", but that symbol is ` +
          `absent from desktop-bootstrap.ts — the door it closed may be open again`,
      ).toBe(true);
    }
  });

  it('keeps the egress monitor installed BEFORE the guards (the P-011 class)', () => {
    // P-011 was not a missing patch but a LATE one: 7 /api/desktop/* calls went
    // native at 481-606 ms because install ran after them. Coverage that arrives
    // late is indistinguishable from absent for everything that already ran, so
    // ordering is part of the contract, not an implementation detail.
    const egressAt = bootstrapSource.indexOf('installEgressMonitor(');
    const xhrAt = bootstrapSource.indexOf('installXhrGuard()');
    const wsAt = bootstrapSource.indexOf('installWsGuard()');
    expect(egressAt, 'installEgressMonitor( not found').toBeGreaterThan(-1);
    expect(xhrAt, 'installXhrGuard() not found').toBeGreaterThan(-1);
    expect(wsAt, 'installWsGuard() not found').toBeGreaterThan(-1);
    expect(egressAt, 'the egress monitor must install before the XHR guard').toBeLessThan(xhrAt);
    expect(egressAt, 'the egress monitor must install before the WS guard').toBeLessThan(wsAt);
  });

  it('classifies every network surface for the hosted portal as well as desktop', () => {
    for (const s of NETWORK_CAPABLE_SURFACES) {
      expect(
        ['control-http-sse', 'reverse-connector-stream', 'bulk-transfer', 'native-only', 'uncovered'],
        `${s.name} has no valid portal treatment`,
      ).toContain(s.portal.treatment);
      expect(s.portal.origin.trim(), `${s.name} has no portal origin posture`).toBeTruthy();
      expect(s.portal.auth.trim(), `${s.name} has no portal auth posture`).toBeTruthy();
      expect(s.portal.byoc.trim(), `${s.name} has no portal BYOC posture`).toBeTruthy();
      expect(s.portal.reason.trim(), `${s.name} has no portal review reason`).toBeTruthy();
      expect(s.portal.reason.length, `${s.name}'s portal reason is too thin to review`).toBeGreaterThan(40);
    }
  });

  it('keeps every bounded portal inventory row source-pinned and attached to a known surface', () => {
    const entries = [
      ...PORTAL_STREAM_OPENERS,
      ...PORTAL_BULK_TRANSFERS,
      ...PORTAL_NATIVE_CAPABILITIES,
    ];
    const knownSurfaces = new Set([
      ...NETWORK_CAPABLE_SURFACES.map((s) => s.name),
      // Native-only is a deliberate capability bucket, not a browser global,
      // so it is represented as a typed sentinel outside the network registry.
      'native-only',
    ]);
    const ids = entries.map((entry) => entry.id);
    expect(new Set(ids).size, 'portal inventory ids must be unique').toBe(ids.length);

    for (const entry of entries) {
      expect(knownSurfaces.has(entry.surface), `${entry.id} references an unknown surface`).toBe(true);
      expect(entry.route.trim(), `${entry.id} has no route`).toBeTruthy();
      expect(entry.origin.trim(), `${entry.id} has no origin posture`).toBeTruthy();
      expect(entry.auth.trim(), `${entry.id} has no auth posture`).toBeTruthy();
      expect(entry.byoc.trim(), `${entry.id} has no BYOC posture`).toBeTruthy();
      expect(entry.note.length, `${entry.id} has no review note`).toBeGreaterThan(20);
      expect(
        ['control-http-sse', 'reverse-connector-stream', 'bulk-transfer', 'native-only', 'uncovered'],
        `${entry.id} has no valid inventory bucket`,
      ).toContain(entry.bucket);

      const absoluteFile = resolve(repoRoot, entry.file);
      expect(existsSync(absoluteFile), `${entry.id} source file is missing: ${entry.file}`).toBe(true);
      expect(repoSource(entry.file), `${entry.id} source pin is stale: ${entry.sourceNeedle}`).toContain(
        entry.sourceNeedle,
      );
    }
  });

  it('keeps the authoritative sync read and mutation mechanisms source-pinned', () => {
    for (const contract of PORTAL_CONTROL_PLANE_CONTRACT) {
      expect(existsSync(resolve(repoRoot, contract.file)), `${contract.id} source file is missing`).toBe(true);
      expect(repoSource(contract.file), `${contract.id} source pin is stale`).toContain(contract.sourceNeedle);
    }
  });
});
