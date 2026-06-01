/**
 * IPC traffic inspector seam — a dev-only observability hook over every IPC
 * dispatch and `IpcEventSource` lifecycle transition.
 *
 * Why this exists: IPC traffic is invisible to the browser devtools Network
 * panel (it isn't HTTP — it rides the Tauri unix socket), so the SSE-over-IPC
 * reconnect cadence that caused the dev-IPC "constant flashing" could only be
 * guessed at. This seam makes it observable. The tell is in the EVENT KINDS:
 *
 *   - a CHURNING wrapper recreates the source on every drop → many `es-open`
 *     (constructions) for one URL;
 *   - the FIXED behavior keeps one source alive and reconnects it internally →
 *     one `es-open` + many `es-connect` (re-opens) for that URL.
 *
 * The hook is zero-cost (a single null check) until a consumer installs an
 * inspector via `setIpcInspector`; the app's dev bootstrap installs a recorder
 * that exposes `window.__ipcInspector`. Generic — names no app.
 *
 * Plan: calltool-endpoint-seam-2026-06-01 (Phase C, P-006).
 */

export type IpcTraceKind =
  | 'es-open' // an IpcEventSource was CONSTRUCTED (a new channel, not a reuse)
  | 'es-connect' // a (re)connection attempt reached OPEN (head 200)
  | 'es-drop' // transient drop — the SAME source will auto-reconnect
  | 'es-error' // fatal/terminal error on the source
  | 'es-close' // closed by the consumer
  | 'invoke' // dispatchEndpointStreamIpc started (sys:http bridge or direct)
  | 'invoke-done' // terminal: handler returned
  | 'invoke-error'; // terminal: dispatch or handler failed

export interface IpcTraceEvent {
  /** Epoch ms. */
  t: number;
  kind: IpcTraceKind;
  /** Correlation id — every event from one source/dispatch shares it. */
  id: number;
  /** Tool name for an invoke ('sys:http' for fetch/ES, else the direct tool). */
  tool?: string;
  /** URL path for an ES, or the sys:http request path for an invoke. */
  path?: string;
  /** HTTP-ish method for a sys:http invoke. */
  method?: string;
  /** Short human detail (error code/message, etc.). */
  detail?: string;
}

export type IpcInspectorFn = (ev: IpcTraceEvent) => void;

let inspector: IpcInspectorFn | null = null;
let seq = 0;

/**
 * Install (or clear, with `null`) the inspector. Dev-only — the app installs a
 * recorder; production leaves this unset so the hooks stay no-ops.
 */
export function setIpcInspector(fn: IpcInspectorFn | null): void {
  inspector = fn;
}

export function isIpcInspectorEnabled(): boolean {
  return inspector !== null;
}

/** A fresh correlation id for one source/dispatch lifecycle. */
export function nextIpcTraceId(): number {
  return ++seq;
}

/**
 * Emit a trace event. No-op (single null check) when no inspector is installed,
 * so it's safe to leave on the hot path. The inspector must NEVER break the
 * transport — a throwing recorder is swallowed.
 */
export function emitIpcTrace(ev: Omit<IpcTraceEvent, 't'>): void {
  const fn = inspector;
  if (!fn) return;
  try {
    fn({ ...ev, t: Date.now() });
  } catch {
    /* an inspector bug must not wedge IPC */
  }
}
