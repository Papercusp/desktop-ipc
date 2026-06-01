/**
 * Tauri IPC transport adapter. Used on desktop when isTauri() returns
 * true AND the host's force-HTTP escape hatch is not set.
 *
 * Wire path: webview JS → Tauri invoke('endpoint_invoke') → Rust
 * IpcClient → Unix socket / named pipe → Node IPC server →
 * dispatchProjectedToolStream → ctx.emit() → frame → Rust reader →
 * Channel<EndpointEvent> → here.
 *
 * The Rust side ships binary events as base64 (Tauri's IPC serializer
 * is JSON-based). We decode back to Uint8Array on yield, so consumers
 * see a uniform `EndpointStreamEvent` shape across transports.
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  EndpointStreamEvent,
  DispatchEndpointStreamOptions,
} from './types';
import { emitIpcTrace, nextIpcTraceId } from './ipc-inspector';

/** Wire shape on the JS side of the Tauri Channel<EndpointEvent>. */
type RustEndpointEvent =
  | { kind: 'event'; name: string; data: unknown }
  | { kind: 'binary'; name: string; data: string /* base64 */ }
  | { kind: 'done'; result: { content: Array<{ type: string; [k: string]: unknown }> } }
  | { kind: 'error'; code: string; message: string };

function base64ToUint8(b64: string): Uint8Array {
  // The Tauri webview is Chromium so `atob` is always available, but
  // some operator code runs Node-side too (SSR, tests) where `atob`
  // didn't exist until Node 16+. Prefer the global `atob` if defined;
  // fall back to Buffer (Node) so this module is universally callable.
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const NodeBuffer = (globalThis as any).Buffer;
  if (NodeBuffer && typeof NodeBuffer.from === 'function') {
    const buf: { length: number; [k: number]: number } = NodeBuffer.from(b64, 'base64');
    const out = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i];
    return out;
  }
  throw new Error('base64ToUint8: no atob or Buffer in this environment');
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
  emitIpcTrace({ kind: 'invoke', id: traceId, tool: toolName, path: inp?.path, method: inp?.method });

  const channel = new Channel<RustEndpointEvent>();
  channel.onmessage = (msg) => {
    if (msg.kind === 'binary') {
      queue.push({ kind: 'binary', name: msg.name, data: base64ToUint8(msg.data) });
    } else if (msg.kind === 'done' || msg.kind === 'error') {
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
    callId = await invoke<number>('endpoint_invoke', {
      toolName,
      input,
      channel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitIpcTrace({ kind: 'invoke-error', id: traceId, tool: toolName, detail: `invoke_failed: ${message}` });
    yield { kind: 'error', code: 'invoke_failed', message };
    return;
  }

  // Wire the caller's AbortSignal to send a CANCEL frame.
  const onAbort = (): void => {
    void invoke('endpoint_cancel', { callId }).catch(() => { /* ignore */ });
  };
  if (options.signal) {
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    while (true) {
      if (queue.length === 0 && !done) {
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      while (queue.length > 0) {
        const ev = queue.shift()!;
        if (ev.kind === 'done' || ev.kind === 'error') {
          emitIpcTrace(
            ev.kind === 'error'
              ? { kind: 'invoke-error', id: traceId, tool: toolName, detail: ev.code }
              : { kind: 'invoke-done', id: traceId, tool: toolName },
          );
        }
        yield ev;
        if (ev.kind === 'done' || ev.kind === 'error') return;
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    if (!done) {
      // Consumer broke out of the iterator before terminal — tell the
      // server to abort the call.
      onAbort();
    }
  }
}
