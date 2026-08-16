# @papercusp/desktop-ipc

Endpoint-stream transport for Tauri desktop webviews, plus the desktop
bootstrap polyfills. Routes same-origin `/api/*` traffic over the Tauri IPC
bridge instead of the webview's HTTP stack — which dodges the WebKitGTK /
libsoup **6-connections-per-host** ceiling that otherwise starves long-lived
SSE streams.

```ts
// pick IPC on Tauri, HTTP elsewhere
import { dispatchEndpointStream } from '@papercusp/desktop-ipc';
for await (const ev of dispatchEndpointStream('operator:scan', input, { signal })) { … }

// at desktop boot — patch window.fetch / window.EventSource onto the IPC bridge
import { installDesktopIpcPolyfills, isEndpointIpcAvailable } from '@papercusp/desktop-ipc/desktop-bootstrap';
```

## Force-HTTP escape hatch — `configureDesktopIpc()`

Both the transport picker and the polyfill installer honor a rollback
flag that flips every IPC call back to HTTP without shipping a new Rust
binary. The package names no project's env var — the host injects how
that flag resolves:

```ts
import { configureDesktopIpc } from '@papercusp/desktop-ipc';

configureDesktopIpc({
  // boolean, or a lazy resolver (so a bundler can inline the env read)
  forceHttp: () => process.env.NEXT_PUBLIC_MYAPP_FORCE_HTTP === '1',
});
```

When left unconfigured it falls back to the generic, unbranded
`DESKTOP_IPC_FORCE_HTTP` (or `NEXT_PUBLIC_DESKTOP_IPC_FORCE_HTTP`) env var.
The Papercusp operator maps its own `NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT`
onto the seam in `apps/operator/lib/transport-adapters/configure.ts`.

Contents (the whole former `transport-adapters/` unit): the IPC transport
(`ipc-stream`, `ipc-fetch`, `ipc-event-source`, `desktop-bootstrap`), the HTTP
transport (`http-stream`), the SSE chunk parser (`sse-parser`), shared `types`,
and the runtime picker (`index`). They're shipped together because the IPC and
HTTP paths share `types` + `sse-parser` and the picker wires both — splitting
"just the IPC files" would orphan the shared modules.

**Coupling:** none to the Papercusp harness domain — only `@tauri-apps/api`
(Tauri bridge), `@papercusp/sse` (SSE chunk parsing), and `@papercusp/tooldef`
(binary-envelope detection). Any Tauri + WebKitGTK app with a streaming API can
adopt it.
