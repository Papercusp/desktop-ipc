/**
 * HTTP+SSE transport adapter. Used in:
 *   - Non-Tauri browsers (the webapp test surface).
 *   - The Tauri webview when NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT
 *     is set (rollback escape hatch).
 *   - MCP-spawned agents (they go through the signed-URL HTTP path
 *     directly, not this helper).
 *
 * The path comes from the framework default `/api/agent-tools/<name>`
 * (with `:` mapped to `/`). Tools whose Hono shims live elsewhere
 * (e.g. `/api/agent-mcp/operator-scan`) should pass their explicit
 * path via the third overload form — this helper doesn't introspect
 * the tool registry on the client.
 */

import { parseSseStream } from '@papercusp/sse';
// Import from the `tool-projection` subpath specifically — the package's
// root entry re-exports `auth.ts` which pulls `@papercusp/db-org` → `postgres`
// into the browser bundle (fails "Can't resolve 'fs'"). The subpath is
// pure zod + the type guard. See packages/agent-mcp/package.json#exports.
import { isPapercuspBinaryEnvelope } from '@papercusp/tooldef';
import type {
  EndpointStreamEvent,
  DispatchEndpointStreamOptions,
} from './types';

function base64ToUint8Universal(b64: string): Uint8Array {
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

export async function* dispatchEndpointStreamHttp<TInput>(
  toolName: string,
  input: TInput,
  options: DispatchEndpointStreamOptions & {
    /** Override the URL the request goes to (default: derived from toolName). */
    overrideUrl?: string;
  } = {},
): AsyncIterable<EndpointStreamEvent> {
  const url =
    options.overrideUrl ??
    `${options.baseUrl ?? ''}/api/agent-tools/${toolName.replaceAll(':', '/')}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: options.signal,
  });

  if (!res.ok) {
    yield {
      kind: 'error',
      code: `http_${res.status}`,
      message: `${res.status} ${res.statusText}`,
    };
    return;
  }
  if (!res.body) {
    yield { kind: 'error', code: 'no_body', message: 'response has no body' };
    return;
  }

  for await (const ev of parseSseStream(res.body)) {
    if (ev.event === 'heartbeat') continue;
    if (ev.event === 'done') {
      // Wire format per the SSE-typed-events plan D1:
      // `event: done\ndata: <ToolResult.content as JSON>`. The wire
      // payload is the content array directly, not the envelope. Wrap
      // it to match EndpointStreamEvent's done shape (parity with IPC,
      // which sends the full ToolResult).
      let content: Array<{ type: string; [k: string]: unknown }>;
      try {
        const parsed = JSON.parse(ev.data);
        content = Array.isArray(parsed) ? parsed : [{ type: 'text', text: String(ev.data) }];
      } catch {
        content = [{ type: 'text', text: ev.data }];
      }
      yield { kind: 'done', result: { content } };
      return;
    }
    if (ev.event === 'error') {
      let parsed: { code?: string; message?: string };
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        parsed = { code: 'handler_error', message: ev.data };
      }
      yield {
        kind: 'error',
        code: parsed.code ?? 'handler_error',
        message: parsed.message ?? '',
      };
      return;
    }
    // Other events: pass through. Try JSON-parsing first; fall back
    // to raw string for z.string()-typed events on the wire. If the
    // parsed shape is a self-describing binary envelope (audit
    // item 14 unification), decode to Uint8Array and yield as a
    // 'binary' event — matches the IPC consumer's shape.
    let data: unknown = ev.data;
    try {
      data = JSON.parse(ev.data);
      if (isPapercuspBinaryEnvelope(data)) {
        const bytes = base64ToUint8Universal(data.data);
        yield { kind: 'binary', name: ev.event ?? 'message', data: bytes };
        continue;
      }
    } catch {
      /* raw string is correct for z.string() events */
    }
    yield { kind: 'event', name: ev.event ?? 'message', data };
  }
}
