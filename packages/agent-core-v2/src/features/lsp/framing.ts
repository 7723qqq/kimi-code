/**
 * `lsp` domain — Content-Length JSON-RPC framing for LSP stdio transport.
 *
 * Encodes messages as `Content-Length: <bytes>\r\n\r\n<body>` frames and
 * decodes a byte stream back into complete messages, enforcing a maximum
 * frame size so a misbehaving server cannot exhaust memory.
 */

import { Buffer } from 'node:buffer';

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class LspFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LspFramingError';
  }
}

export function encodeFrame(content: string): Buffer {
  const body = Buffer.from(content, 'utf8');
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new LspFramingError(
      `message body of ${body.byteLength} bytes exceeds the ${MAX_FRAME_BYTES}-byte frame limit`,
    );
  }
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'utf8'),
    body,
  ]);
}

export class MessageDecoder {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  /** Feed a chunk of raw bytes; returns every complete message it contains. */
  feed(chunk: Buffer): string[] {
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: string[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (this.buffer.byteLength > MAX_FRAME_BYTES) {
          throw new LspFramingError('header exceeds the frame limit without a terminator');
        }
        return messages;
      }
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const length = parseContentLength(header);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.byteLength < bodyEnd) {
        return messages;
      }
      messages.push(this.buffer.subarray(bodyStart, bodyEnd).toString('utf8'));
      this.buffer = this.buffer.subarray(bodyEnd);
    }
  }
}

function parseContentLength(header: string): number {
  const match = /^Content-Length:\s*(\d+)\s*$/i.exec(header);
  if (match === null) {
    throw new LspFramingError(`malformed LSP frame header: ${JSON.stringify(header)}`);
  }
  const length = Number(match[1]);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_BYTES) {
    throw new LspFramingError(`invalid Content-Length: ${match[1]}`);
  }
  return length;
}
