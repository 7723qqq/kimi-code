import { describe, expect, it } from 'vitest';

import { Buffer } from 'node:buffer';

import {
  LspFramingError,
  MAX_FRAME_BYTES,
  MessageDecoder,
  encodeFrame,
} from '#/features/lsp/framing';

describe('encodeFrame', () => {
  it('encodes a message with a Content-Length header', () => {
    const frame = encodeFrame('{"jsonrpc":"2.0"}');
    expect(frame.toString('utf8')).toBe('Content-Length: 17\r\n\r\n{"jsonrpc":"2.0"}');
  });

  it('measures length in UTF-8 bytes, not characters', () => {
    const frame = encodeFrame('{"value":"中文"}');
    expect(frame.toString('utf8')).toBe(
      `Content-Length: ${Buffer.byteLength('{"value":"中文"}', 'utf8')}\r\n\r\n{"value":"中文"}`,
    );
  });

  it('rejects bodies over the frame limit', () => {
    const oversized = 'x'.repeat(MAX_FRAME_BYTES + 1);
    expect(() => encodeFrame(oversized)).toThrow(LspFramingError);
  });
});

describe('MessageDecoder', () => {
  it('decodes a single complete frame', () => {
    const decoder = new MessageDecoder();
    const messages = decoder.feed(encodeFrame('{"id":1}'));
    expect(messages).toEqual(['{"id":1}']);
  });

  it('decodes multiple frames from one chunk', () => {
    const decoder = new MessageDecoder();
    const messages = decoder.feed(
      Buffer.concat([encodeFrame('{"id":1}'), encodeFrame('{"id":2}')]),
    );
    expect(messages).toEqual(['{"id":1}', '{"id":2}']);
  });

  it('buffers partial frames across chunks', () => {
    const decoder = new MessageDecoder();
    const frame = encodeFrame('{"id":1}');
    const half = Math.floor(frame.byteLength / 2);
    expect(decoder.feed(frame.subarray(0, half))).toEqual([]);
    expect(decoder.feed(frame.subarray(half))).toEqual(['{"id":1}']);
  });

  it('buffers a split header across chunks', () => {
    const decoder = new MessageDecoder();
    const frame = encodeFrame('{"id":1}');
    expect(decoder.feed(frame.subarray(0, 5))).toEqual([]);
    expect(decoder.feed(frame.subarray(5))).toEqual(['{"id":1}']);
  });

  it('handles a frame split at the header/body boundary', () => {
    const decoder = new MessageDecoder();
    const frame = encodeFrame('{"id":1}');
    const headerEnd = frame.indexOf('\r\n\r\n') + 4;
    expect(decoder.feed(frame.subarray(0, headerEnd))).toEqual([]);
    expect(decoder.feed(frame.subarray(headerEnd))).toEqual(['{"id":1}']);
  });

  it('rejects a malformed header', () => {
    const decoder = new MessageDecoder();
    expect(() => decoder.feed(Buffer.from('Bogus: 1\r\n\r\n{}', 'utf8'))).toThrow(
      LspFramingError,
    );
  });

  it('rejects an invalid Content-Length', () => {
    const decoder = new MessageDecoder();
    expect(() => decoder.feed(Buffer.from('Content-Length: nope\r\n\r\n{}', 'utf8'))).toThrow(
      LspFramingError,
    );
  });

  it('rejects a header that exceeds the frame limit without a terminator', () => {
    const decoder = new MessageDecoder();
    expect(() => decoder.feed(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61))).toThrow(
      LspFramingError,
    );
  });
});
