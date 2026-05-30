/**
 * Common shape across all endpoint-stream transports (HTTP, IPC,
 * future MCP). Mirrors `DispatchStreamEvent` from
 * `@papercusp/agent-mcp` (server-side) and `EndpointEvent` from
 * `papercusp-desktop/src-tauri/src/endpoint_ipc.rs` (Rust-side).
 *
 * Consumers iterate the AsyncIterable<EndpointStreamEvent> and
 * dispatch on `kind`:
 *   - 'event'  — a `ctx.emit(name, data)` from the tool handler.
 *   - 'binary' — a binary event (Uint8Array payload).
 *   - 'done'   — handler returned; terminal.
 *   - 'error'  — dispatch or handler failed; terminal.
 */
export type EndpointStreamEvent =
  | { kind: 'event'; name: string; data: unknown }
  | { kind: 'binary'; name: string; data: Uint8Array }
  | { kind: 'done'; result: { content: Array<{ type: string; [k: string]: unknown }> } }
  | { kind: 'error'; code: string; message: string };

export interface DispatchEndpointStreamOptions {
  /** Optional abort signal to cancel the call mid-stream. */
  signal?: AbortSignal;
  /** Override the operator-base URL for the HTTP fallback. */
  baseUrl?: string;
}

export type DispatchEndpointStreamFn = <TInput>(
  toolName: string,
  input: TInput,
  options?: DispatchEndpointStreamOptions,
) => AsyncIterable<EndpointStreamEvent>;
