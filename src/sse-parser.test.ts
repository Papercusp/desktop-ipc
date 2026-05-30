import { describe, expect, it } from 'vitest';
import { SseParser } from './sse-parser';

describe('SseParser', () => {
  it('parses a single message-typed event', () => {
    const p = new SseParser();
    const out = p.feed('data: hello\n\n');
    expect(out).toEqual([{ type: 'message', data: 'hello', lastEventId: null }]);
  });

  it('strips the optional leading space after the colon', () => {
    const p = new SseParser();
    expect(p.feed('data:hello\n\n')).toEqual([
      { type: 'message', data: 'hello', lastEventId: null },
    ]);
    const p2 = new SseParser();
    expect(p2.feed('data: hello\n\n')).toEqual([
      { type: 'message', data: 'hello', lastEventId: null },
    ]);
  });

  it('joins multi-line data with newline', () => {
    const p = new SseParser();
    expect(p.feed('data: line1\ndata: line2\n\n')).toEqual([
      { type: 'message', data: 'line1\nline2', lastEventId: null },
    ]);
  });

  it('dispatches a named event type', () => {
    const p = new SseParser();
    expect(p.feed('event: backfill\ndata: payload\n\n')).toEqual([
      { type: 'backfill', data: 'payload', lastEventId: null },
    ]);
  });

  it('carries lastEventId forward across events', () => {
    const p = new SseParser();
    const out = p.feed('id: 42\ndata: a\n\ndata: b\n\n');
    expect(out).toEqual([
      { type: 'message', data: 'a', lastEventId: '42' },
      { type: 'message', data: 'b', lastEventId: '42' },
    ]);
    expect(p.getLastEventId()).toBe('42');
  });

  it('handles \\r\\n line endings', () => {
    const p = new SseParser();
    expect(p.feed('data: x\r\n\r\n')).toEqual([
      { type: 'message', data: 'x', lastEventId: null },
    ]);
  });

  it('ignores comment lines (starting with :)', () => {
    const p = new SseParser();
    expect(p.feed(': heartbeat\ndata: real\n\n')).toEqual([
      { type: 'message', data: 'real', lastEventId: null },
    ]);
  });

  it('does not emit on a blank-line with no data accumulated', () => {
    const p = new SseParser();
    expect(p.feed('\n\n')).toEqual([]);
  });

  it('handles partial chunks across feed() calls', () => {
    const p = new SseParser();
    expect(p.feed('data: par')).toEqual([]);
    expect(p.feed('tial\n')).toEqual([]);
    expect(p.feed('\n')).toEqual([
      { type: 'message', data: 'partial', lastEventId: null },
    ]);
  });

  it('resets event name to "message" after each dispatch but persists id', () => {
    const p = new SseParser();
    const out = p.feed('event: custom\nid: 1\ndata: a\n\ndata: b\n\n');
    expect(out).toEqual([
      { type: 'custom', data: 'a', lastEventId: '1' },
      { type: 'message', data: 'b', lastEventId: '1' },
    ]);
  });

  it('ignores retry: and unknown fields', () => {
    const p = new SseParser();
    expect(p.feed('retry: 1000\nfoo: bar\ndata: ok\n\n')).toEqual([
      { type: 'message', data: 'ok', lastEventId: null },
    ]);
  });
});
