import { afterEach, describe, expect, it } from 'vitest';
import {
  emitIpcTrace,
  isIpcInspectorEnabled,
  nextIpcTraceId,
  setIpcInspector,
  type IpcTraceEvent,
} from './ipc-inspector';

afterEach(() => setIpcInspector(null));

describe('ipc-inspector seam', () => {
  it('is a no-op until an inspector is installed', () => {
    expect(isIpcInspectorEnabled()).toBe(false);
    // Must not throw with no inspector.
    expect(() => emitIpcTrace({ kind: 'invoke', id: 1, tool: 'x' })).not.toThrow();
  });

  it('delivers events (with a wall-clock t) once installed', () => {
    const got: IpcTraceEvent[] = [];
    setIpcInspector((ev) => got.push(ev));
    expect(isIpcInspectorEnabled()).toBe(true);
    emitIpcTrace({ kind: 'es-open', id: 7, path: '/api/sse' });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'es-open', id: 7, path: '/api/sse' });
    expect(typeof got[0]!.t).toBe('number');
    expect(got[0]!.t).toBeGreaterThan(0);
  });

  it('hands out monotonically increasing correlation ids', () => {
    const a = nextIpcTraceId();
    const b = nextIpcTraceId();
    const c = nextIpcTraceId();
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });

  it('setIpcInspector(null) detaches', () => {
    const got: IpcTraceEvent[] = [];
    setIpcInspector((ev) => got.push(ev));
    emitIpcTrace({ kind: 'invoke', id: 1 });
    setIpcInspector(null);
    emitIpcTrace({ kind: 'invoke', id: 2 });
    expect(got).toHaveLength(1);
  });

  it('a throwing inspector never breaks the transport', () => {
    setIpcInspector(() => {
      throw new Error('recorder bug');
    });
    expect(() => emitIpcTrace({ kind: 'es-drop', id: 1, path: '/api/sse' })).not.toThrow();
  });
});
