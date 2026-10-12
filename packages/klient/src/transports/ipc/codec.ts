/**
 * IPC wire framing — newline-delimited JSON over a `node:net` stream. One
 * socket multiplexes RPC `call`s, RPC `stream`s, and event `listen`s:
 * `hello`/`call`/`stream`/`stream_cancel`/`listen`/`unlisten` go out,
 * `ready`/`result`/`error`/`listen_result`/`event`/`stream_data`/
 * `stream_end`/`stream_error` come back.
 */

/** One NDJSON message. `type` discriminates; other fields depend on it. */
export interface IpcFrame {
  readonly type: string;
  readonly id?: string;
  readonly scope?: string;
  readonly service?: string;
  readonly method?: string;
  readonly arg?: unknown;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly event?: string;
  readonly token?: string;
  readonly code?: number;
  readonly msg?: string;
  readonly data?: unknown;
}

export function encodeFrame(frame: IpcFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Incremental NDJSON decoder; malformed lines are dropped. Buffering is
 * byte-wise: a socket read boundary can cut a multi-byte UTF-8 character in
 * half, so chunks are concatenated as bytes and only whole lines — which can
 * never end mid-character, since the delimiter is ASCII — are decoded.
 */
export class NdjsonDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly decoder = new TextDecoder('utf-8');

  push(chunk: Uint8Array): IpcFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: IpcFrame[] = [];
    let start = 0;
    for (;;) {
      const newline = this.buffer.indexOf(0x0a, start);
      if (newline === -1) break;
      // A trailing half-character can never appear here: 0x0a is a whole
      // character, so the bytes before it are a complete UTF-8 sequence.
      const line = this.decoder.decode(this.buffer.subarray(start, newline));
      start = newline + 1;
      if (line.length === 0) continue;
      try {
        frames.push(JSON.parse(line) as IpcFrame);
      } catch {
        // drop malformed frames
      }
    }
    // Keep the incomplete tail (bytes, not text) for the next push.
    this.buffer = this.buffer.subarray(start) as Buffer;
    return frames;
  }
}
