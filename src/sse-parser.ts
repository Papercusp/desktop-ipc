/**
 * Minimal SSE wire-format parser — same line-based machine as native
 * `EventSource`. Feed raw text chunks via `feed()`; it returns every
 * event that fully arrived within those bytes.
 *
 * Conforms to the HTML SSE spec: `\n`, `\r\n`, `\r` all terminate
 * lines; blank line dispatches; lines starting with `:` are comments;
 * recognized fields are `data`, `event`, `id` (we ignore `retry` —
 * resilience timing is the wrapper's concern). Multi-line `data:`
 * joins with `\n`. `id:` updates the persistent Last-Event-ID, which
 * carries across events until reset.
 *
 * No DOM types — pure text-in / object-out, testable in Node.
 */

export interface ParsedSseEvent {
  type: string;
  data: string;
  /** Persists across events; null until any `id:` line is seen. */
  lastEventId: string | null;
}

export class SseParser {
  private buf = '';
  private dataLines: string[] = [];
  private eventName = 'message';
  private lastEventId: string | null = null;

  /**
   * Feed a chunk of raw SSE wire bytes (as text). Returns 0+ events
   * that completed within this chunk. Partial events stay buffered.
   */
  feed(chunk: string): ParsedSseEvent[] {
    const out: ParsedSseEvent[] = [];
    this.buf += chunk;
    // Normalize line endings: split on \n; strip trailing \r from each line.
    // Stray \r-only line endings would normally count as line breaks too,
    // but in practice every SSE producer emits \n or \r\n; that's enough.
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        if (this.dataLines.length > 0) {
          out.push({
            type: this.eventName,
            data: this.dataLines.join('\n'),
            lastEventId: this.lastEventId,
          });
        }
        // Reset per-event state. Note: lastEventId persists across events.
        this.dataLines = [];
        this.eventName = 'message';
        continue;
      }
      if (line.startsWith(':')) continue; // comment

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'data') this.dataLines.push(value);
      else if (field === 'event') this.eventName = value || 'message';
      else if (field === 'id') this.lastEventId = value;
      // 'retry' and unknown fields: ignored.
    }
    return out;
  }

  /** Last id seen on any `id:` line, or null if none yet. */
  getLastEventId(): string | null {
    return this.lastEventId;
  }
}
