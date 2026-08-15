import { describe, expect, it } from 'vitest';

import {
  decodeUtf8Lenient,
  decodeUtfText,
  detectLegacyTextEncoding,
  detectTextEncoding,
  ENCODING_DETECTION_SAMPLE_BYTES,
} from '#/_base/text/encoding';
import { splitLinesKeepingTerminator } from '#/_base/text/line-endings';

function utf16Le(text: string): Buffer {
  return Buffer.from(text, 'utf16le');
}

function utf16Be(text: string): Buffer {
  const le = utf16Le(text);
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1]!;
    be[i + 1] = le[i]!;
  }
  return be;
}

describe('detectTextEncoding', () => {
  it('detects encodings by BOM', () => {
    expect(detectTextEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61])).encoding).toBe('utf-8');
    expect(detectTextEncoding(Buffer.from([0xff, 0xfe, 0x61, 0x00])).encoding).toBe('utf-16le');
    expect(detectTextEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x61])).encoding).toBe('utf-16be');
  });

  it('trusts the BOM even when the sample carries no zero bytes (CJK-only)', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16Le('你好世界')]);
    expect(detectTextEncoding(le)).toEqual({ encoding: 'utf-16le', seemsBinary: false });
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16Be('你好世界')]);
    expect(detectTextEncoding(be)).toEqual({ encoding: 'utf-16be', seemsBinary: false });
  });

  it('detects BOM-less UTF-16 by the zero-byte parity heuristic', () => {
    expect(detectTextEncoding(utf16Le('hello world, plain ascii')).encoding).toBe('utf-16le');
    expect(detectTextEncoding(utf16Be('hello world, plain ascii')).encoding).toBe('utf-16be');
  });

  it('tolerates CJK characters in BOM-less UTF-16 (their units carry no zero byte)', () => {
    expect(detectTextEncoding(utf16Le('hello 你好\nsecond line')).encoding).toBe('utf-16le');
    expect(detectTextEncoding(utf16Be('hello 你好\nsecond line')).encoding).toBe('utf-16be');
  });

  it('reports BOM-less UTF-16 with no zero bytes at all as utf-8 (known limitation)', () => {
    // Pure CJK content has no zero bytes in UTF-16 — undetectable without
    // statistical guessing, same as VS Code.
    expect(detectTextEncoding(utf16Le('你好世界')).encoding).toBe('utf-8');
  });

  it('treats an isolated zero byte as binary (too ambiguous)', () => {
    expect(detectTextEncoding(Buffer.from([0x61, 0x00])).seemsBinary).toBe(true);
    expect(detectTextEncoding(Buffer.from([0x00, 0x61])).seemsBinary).toBe(true);
  });

  it('limits the zero-byte heuristic to the leading sample window', () => {
    const sample = Buffer.alloc(ENCODING_DETECTION_SAMPLE_BYTES + 2, 0x61);
    sample[ENCODING_DETECTION_SAMPLE_BYTES + 1] = 0x00;
    expect(detectTextEncoding(sample)).toEqual({ encoding: 'utf-8', seemsBinary: false });
  });

  it('flags zero bytes at both parities as binary', () => {
    expect(detectTextEncoding(Buffer.from([0x00, 0x00, 0x61, 0x62])).seemsBinary).toBe(true);
    const prefix = Buffer.concat([Buffer.from('plain prefix'), Buffer.from([0x00, 0x01])]);
    expect(detectTextEncoding(prefix).seemsBinary).toBe(true);
  });

  it('treats plain ASCII / UTF-8 and empty samples as utf-8 text', () => {
    expect(detectTextEncoding(new Uint8Array())).toEqual({ encoding: 'utf-8', seemsBinary: false });
    expect(detectTextEncoding(Buffer.from('plain ascii\n')).seemsBinary).toBe(false);
    expect(detectTextEncoding(Buffer.from('中文内容\n', 'utf8'))).toEqual({
      encoding: 'utf-8',
      seemsBinary: false,
    });
  });
});

describe('decodeUtfText', () => {
  it('decodes UTF-16 LE/BE and strips the BOM', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16Le('你好\nworld')]);
    expect(decodeUtfText(le, 'utf-16le')).toBe('你好\nworld');
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16Be('你好\nworld')]);
    expect(decodeUtfText(be, 'utf-16be')).toBe('你好\nworld');
  });

  it('decodes UTF-8 and strips the BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('text', 'utf8')]);
    expect(decodeUtfText(bytes, 'utf-8')).toBe('text');
  });

  it('replaces malformed sequences instead of throwing', () => {
    expect(decodeUtfText(Buffer.from([0xff]), 'utf-16le')).toBe('�');
  });
});

describe('detectLegacyTextEncoding', () => {
  // "中文内容\n第二行" in GBK — the byte layout of Windows code page 936.
  const GBK_TEXT = Buffer.from([
    0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd, 0x0a, 0xb5, 0xda, 0xb6, 0xfe, 0xd0, 0xd0,
  ]);

  it('detects GBK Chinese text', () => {
    expect(detectLegacyTextEncoding(GBK_TEXT)).toBe('gbk');
  });

  it('detects larger GBK payloads spanning the full sample', () => {
    const big = Buffer.concat(Array.from({ length: 64 }, () => GBK_TEXT));
    expect(detectLegacyTextEncoding(big)).toBe('gbk');
  });

  it('returns null for UTF-8 content (misinterpreted as GBK it yields replacements)', () => {
    // UTF-8 Chinese decoded as GBK trips unmappable byte pairs → U+FFFD.
    expect(detectLegacyTextEncoding(Buffer.from('中文内容\n', 'utf8'))).toBeNull();
  });

  it('returns null for UTF-8 payloads with a small malformed tail', () => {
    const bytes = Buffer.concat([
      Buffer.from('正常文本行\n', 'utf8'),
      Buffer.from([0x88, 0xa1, 0xff]),
    ]);
    expect(detectLegacyTextEncoding(bytes)).toBeNull();
  });

  it('returns null for pure ASCII and for empty input', () => {
    expect(detectLegacyTextEncoding(Buffer.from('plain ascii\n'))).toBeNull();
    expect(detectLegacyTextEncoding(new Uint8Array())).toBeNull();
  });
});

describe('decodeUtf8Lenient', () => {
  it('passes clean UTF-8 through with no replacements', () => {
    const bytes = Buffer.from('中文内容\nsecond line\n', 'utf8');
    expect(decodeUtf8Lenient(bytes)).toEqual({ text: '中文内容\nsecond line\n', replacedCount: 0 });
  });

  it('replaces malformed sequences and counts them', () => {
    const bytes = Buffer.concat([Buffer.from('text\n', 'utf8'), Buffer.from([0xff, 0xfe])]);
    const { text, replacedCount } = decodeUtf8Lenient(bytes);
    expect(text.startsWith('text\n')).toBe(true);
    expect(text).toContain('�');
    expect(replacedCount).toBeGreaterThanOrEqual(1);
  });
});

describe('splitLinesKeepingTerminator', () => {
  it('keeps line terminators and the unterminated tail', () => {
    expect(splitLinesKeepingTerminator('a\nb\n')).toEqual(['a\n', 'b\n']);
    expect(splitLinesKeepingTerminator('a\nb')).toEqual(['a\n', 'b']);
    expect(splitLinesKeepingTerminator('')).toEqual([]);
    expect(splitLinesKeepingTerminator('\n')).toEqual(['\n']);
  });
});
