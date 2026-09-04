/**
 * Tauri IPC transport adapter. Used on desktop when isTauri() returns
 * true AND the host's force-HTTP escape hatch is not set.
 *
 * Wire path: webview JS → Tauri invoke('endpoint_invoke') → Rust
 * IpcClient → Unix socket / named pipe → Node IPC server →
 * dispatchProjectedToolStream → ctx.emit() → frame → Rust reader →
 * Channel<EndpointEvent> → here.
 *
 * WI-5911: binary events use Tauri v2's `InvokeResponseBody::Raw`, arriving as
 * ArrayBuffer on this SAME Channel. The raw message reuses the Node EVENT_BIN
 * payload byte-for-byte: [8B call id BE][4B name length BE][name][binary].
 * Reusing one channel matters: its message index preserves head → body → done
 * ordering even when a large raw payload takes Tauri's fetch fast path.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  EndpointStreamEvent,
  DispatchEndpointStreamOptions,
} from "./types";
import { emitIpcTrace, nextIpcTraceId } from "./ipc-inspector";

/** Wire shape on the JS side of the Tauri Channel<EndpointEvent>. */
type RustEndpointEvent =
  | { kind: "event"; name: string; data: unknown }
  // Rolling-upgrade compatibility only: current Rust sends binary as raw
  // ArrayBuffer. An older desktop shell can still serve a newer webview.
  | { kind: "binary"; name: string; data: string /* legacy base64 */ }
  | {
      kind: "done";
      result: { content: Array<{ type: string; [k: string]: unknown }> };
    }
  | { kind: "error"; code: string; message: string };

type RustEndpointMessage = RustEndpointEvent | ArrayBuffer;

const EVENT_BIN_PREFIX_BYTES = 12; // 8-byte call id + 4-byte name length

/** Decode the allocation-free raw message emitted by endpoint_ipc.rs. */
export function decodeRawBinaryEvent(
  raw: ArrayBuffer,
): Extract<EndpointStreamEvent, { kind: "binary" }> {
  if (raw.byteLength < EVENT_BIN_PREFIX_BYTES) {
    throw new Error(`raw EVENT_BIN payload too short: ${raw.byteLength} bytes`);
  }
  const view = new DataView(raw);
  const nameLength = view.getUint32(8, false);
  const dataOffset = EVENT_BIN_PREFIX_BYTES + nameLength;
  if (dataOffset > raw.byteLength) {
    throw new Error(
      `raw EVENT_BIN name length ${nameLength} exceeds ${raw.byteLength} byte payload`,
    );
  }
  const bytes = new Uint8Array(raw);
  const name = new TextDecoder().decode(
    bytes.subarray(EVENT_BIN_PREFIX_BYTES, dataOffset),
  );
  return { kind: "binary", name, data: bytes.subarray(dataOffset) };
}

function base64ToUint8(b64: string): Uint8Array {
  // The Tauri webview is Chromium so `atob` is always available, but
  // some operator code runs Node-side too (SSR, tests) where `atob`
  // didn't exist until Node 16+. Prefer the global `atob` if defined;
  // fall back to Buffer (Node) so this module is universally callable.
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const NodeBuffer = (globalThis as any).Buffer;
  if (NodeBuffer && typeof NodeBuffer.from === "function") {
    const buf: { length: number; [k: number]: number } = NodeBuffer.from(
      b64,
      "base64",
    );
    const out = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i];
    return out;
  }
  throw new Error("base64ToUint8: no atob or Buffer in this environment");
}

export async function* dispatchEndpointStreamIpc<TInput>(
  toolName: string,
  input: TInput,
  options: DispatchEndpointStreamOptions = {},
): AsyncIterable<EndpointStreamEvent> {
  const queue: EndpointStreamEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;

  // Inspector seam (dev-only; zero-cost when no inspector installed). For the
  // sys:http bridge, `input` carries {method, path}; for direct dispatch it's
  // the tool's own input, so path/method are simply absent.
  const traceId = nextIpcTraceId();
  const inp = input as { path?: string; method?: string } | undefined;
  emitIpcTrace({
    kind: "invoke",
    id: traceId,
    tool: toolName,
    path: inp?.path,
    method: inp?.method,
  });

  const channel = new Channel<RustEndpointMessage>();
  channel.onmessage = (message) => {
    let msg: EndpointStreamEvent;
    try {
      msg =
        message instanceof ArrayBuffer
          ? decodeRawBinaryEvent(message)
          : message.kind === "binary"
            ? {
                kind: "binary",
                name: message.name,
                data: base64ToUint8(message.data),
              }
            : message;
    } catch (err) {
      queue.push({
        kind: "error",
        code: "invalid_binary_frame",
        message: err instanceof Error ? err.message : String(err),
      });
      // This is a locally-synthesized terminal. Leave `done` false so finally
      // sends endpoint_cancel after invoke returns and server work cannot leak.
      wake?.();
      wake = null;
      return;
    }
    if (msg.kind === "done" || msg.kind === "error") {
      queue.push(msg);
      done = true;
    } else {
      queue.push(msg);
    }
    wake?.();
    wake = null;
  };

  let callId: number;
  try {
    callId = await invoke<number>("endpoint_invoke", {
      toolName,
      input,
      channel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitIpcTrace({
      kind: "invoke-error",
      id: traceId,
      tool: toolName,
      detail: `invoke_failed: ${message}`,
    });
    yield { kind: "error", code: "invoke_failed", message };
    return;
  }

  // Wire the caller's AbortSignal to send a CANCEL frame.
  const onAbort = (): void => {
    void invoke("endpoint_cancel", { callId }).catch(() => {
      /* ignore */
    });
  };
  if (options.signal) {
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    while (true) {
      if (queue.length === 0 && !done) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      while (queue.length > 0) {
        const ev = queue.shift()!;
        if (ev.kind === "done" || ev.kind === "error") {
          emitIpcTrace(
            ev.kind === "error"
              ? {
                  kind: "invoke-error",
                  id: traceId,
                  tool: toolName,
                  detail: ev.code,
                }
              : { kind: "invoke-done", id: traceId, tool: toolName },
          );
        }
        yield ev;
        if (ev.kind === "done" || ev.kind === "error") return;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (!done) {
      // Consumer broke out of the iterator before terminal — tell the
      // server to abort the call.
      onAbort();
    }
  }
}
