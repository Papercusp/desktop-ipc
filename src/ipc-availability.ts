/**
 * Classifying WHY an IPC invoke failed — the distinction `requireIpc` depends on.
 *
 * Two very different conditions used to be collapsed into one predicate
 * (`isIpcUnavailable`), which was fine while the answer was always "fall back to
 * HTTP". Once `requireIpc` made the answer "wait forever instead", collapsing
 * them became a hazard: waiting is right for a bridge that is *coming up*, and
 * catastrophic for a bridge that is *never coming up*.
 *
 *  - **not-ready** (`invoke_failed:…`, `state not managed`): the bridge is coming
 *    up. Either the Rust `IpcClientHandle` answered but has no live socket to
 *    dial *right now* (the operator is still booting, or its advertisement is
 *    momentarily stale mid-restart), or the handle is not `.manage()`d YET —
 *    in prod it is registered only after the operator is reachable, so
 *    "state not managed" is a startup window, NOT a permanent condition.
 *    Waiting genuinely resolves both.
 *
 *  - **not-wired** (`ipc_disabled`, `access control`, `ipc://`): there is no
 *    bridge in this webview and nothing will create one. Either the shell was
 *    launched with the Rust kill switch `PAPERCUSP_DESKTOP_IPC=0`, or the webview
 *    itself rejects `ipc://` invokes at the fetch layer before they reach Rust.
 *
 * Why this matters concretely: `PAPERCUSP_DESKTOP_IPC=0` is a deliberate operator
 * rollback lever. Under a single collapsed predicate + `requireIpc`, pulling that
 * lever would make every stream hang forever instead of falling back — i.e. the
 * rollback lever would break the app at exactly the moment someone reached for it
 * to un-break it. A not-wired bridge is treated as equivalent to `forceHttp`:
 * the operator has chosen HTTP, so use HTTP.
 *
 * ⚠ The disabled case is signalled EXPLICITLY (the Rust side registers a handle
 * that answers `ipc_disabled: …`) rather than inferred from `state not managed`.
 * Inferring it is wrong and was tried first: `state not managed` is ALSO the
 * prod pre-handshake window, so treating it as permanent silently reintroduces
 * WI-6257 — every boot-era stream falls back and holds one of the webview's ~6
 * sockets for the whole session. Intent must be stated, not guessed.
 */

/**
 * The bridge is absent by construction — not coming up later. Callers must fall
 * back to HTTP even when `requireIpc` is on.
 */
export function isIpcNotWired(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    // Explicit: the Rust side registered a DISABLED handle because the shell was
    // launched with PAPERCUSP_DESKTOP_IPC=0.
    msg.includes('ipc_disabled') ||
    // WebKitGTK / WKWebView reject the `ipc://localhost/<cmd>` invoke fetch at the
    // WEBVIEW layer ("Fetch API cannot load ipc://… due to access control checks")
    // BEFORE it reaches Rust. IPC is not usable in this webview, ever.
    msg.includes('access control') ||
    msg.includes('ipc://')
  );
}

/**
 * The bridge exists but has no socket to dial yet. Retryable — under `requireIpc`
 * the caller should stay CONNECTING rather than burn one of the webview's ~6
 * per-host sockets on a fallback that would then hold it for the whole session.
 */
export function isIpcNotReady(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('invoke_failed') ||
    // The handle is not registered YET. In prod it is `.manage()`d only once the
    // operator is reachable, so this is the pre-handshake startup window — a
    // wait, not a verdict.
    msg.includes('state not managed')
  );
}

/**
 * Either condition. Kept because the fallback decision is the same whenever
 * `requireIpc` is OFF, and callers that only ask "did IPC run at all?" want this.
 * `upstream_error` / `aborted` / etc. mean IPC *did* run, so those are real
 * failures and must NOT be retried or replayed over HTTP.
 */
export function isIpcUnavailable(err: unknown): boolean {
  return isIpcNotReady(err) || isIpcNotWired(err);
}
