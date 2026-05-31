# @papercusp/desktop-ipc

Endpoint-stream transport for Tauri desktop webviews, plus the desktop
bootstrap polyfills. Routes same-origin `/api/*` traffic over the Tauri IPC
bridge instead of the webview's HTTP stack — which dodges the WebKitGTK /
libsoup **6-connections-per-host** ceiling that otherwise starves long-lived
SSE streams.

```ts
// pick IPC on Tauri, HTTP elsewhere (env override flips back to HTTP)
import { dispatchEndpointStream } from '@papercusp/desktop-ipc';
for await (const ev of dispatchEndpointStream('operator:scan', input, { signal })) { … }

// at desktop boot — patch window.fetch / window.EventSource onto the IPC bridge
import { installDesktopIpcPolyfills, isEndpointIpcAvailable } from '@papercusp/desktop-ipc/desktop-bootstrap';
```

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
