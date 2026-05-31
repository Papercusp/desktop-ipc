/**
 * Minimal SSE wire-format parser — same line-based machine as native
 * `EventSource`. Feed raw text chunks via `feed()`; it returns every
 * event that fully arrived within those bytes.
 *
 * Conforms to the HTML SSE spec: `\n`, `\r\n`, and a lone `\r` all terminate
 * lines; a blank line dispatches; lines starting with `:` are comments;
 * recognized fields are `data`, `event`, `id` (we ignore `retry` —
 * resilience timing is the wrapper's concern). Multi-line `data:` joins with
 * `\n`. `id:` updates the persistent Last-Event-ID, which carries across
 * events until reset.
 *
 * Streaming-safe: a trailing `\r` at a chunk boundary is held back (it may be
 * the first half of a split `\r\n`) until the next chunk decides it.
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

    let i = 0;
    let lineStart = 0;
    while (i < this.buf.length) {
      const ch = this.buf[i];
      if (ch === '\n') {
        this.processLine(this.buf.slice(lineStart, i), out);
        i += 1;
        lineStart = i;
      } else if (ch === '\r') {
        // A `\r` at the very end of the buffer may be the first half of a
        // `\r\n` split across chunks — hold the line until the next feed.
        if (i === this.buf.length - 1) break;
        this.processLine(this.buf.slice(lineStart, i), out);
        // `\r\n` consumes two chars; a lone `\r` consumes one.
        i += this.buf[i + 1] === '\n' ? 2 : 1;
        lineStart = i;
      } else {
        i += 1;
      }
    }
    // Keep the unterminated remainder (incl. a held trailing `\r`) buffered.
    this.buf = this.buf.slice(lineStart);
    return out;
  }

  private processLine(line: string, out: ParsedSseEvent[]): void {
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
      return;
    }
    if (line.startsWith(':')) return; // comment

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventName = value || 'message';
    else if (field === 'id') this.lastEventId = value;
    // 'retry' and unknown fields: ignored.
  }

  /** Last id seen on any `id:` line, or null if none yet. */
  getLastEventId(): string | null {
    return this.lastEventId;
  }
}
