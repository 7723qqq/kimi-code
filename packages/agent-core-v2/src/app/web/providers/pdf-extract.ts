import { inflateRawSync, inflateSync } from 'node:zlib';

const STREAM_MARKER = 'stream';
const ENDSTREAM_MARKER = 'endstream';

function isPdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

function decodePdfLiteralString(raw: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      bytes.push(raw.charCodeAt(i) & 0xff);
      continue;
    }
    i += 1;
    if (i >= raw.length) break;
    const esc = raw[i];
    switch (esc) {
      case 'n':
        bytes.push(10);
        break;
      case 'r':
        bytes.push(13);
        break;
      case 't':
        bytes.push(9);
        break;
      case 'b':
        bytes.push(8);
        break;
      case 'f':
        bytes.push(12);
        break;
      case '(':
      case ')':
      case '\\':
        bytes.push(esc.charCodeAt(0));
        break;
      case '\r':
        if (raw[i + 1] === '\n') i += 1;
        break;
      case '\n':
        break;
      default: {
        if (esc !== undefined && esc >= '0' && esc <= '7') {
          let oct = esc;
          for (let j = 0; j < 2; j += 1) {
            const next = raw[i + 1];
            if (next !== undefined && next >= '0' && next <= '7') {
              oct += next;
              i += 1;
            } else {
              break;
            }
          }
          bytes.push(parseInt(oct, 8) & 0xff);
        } else if (esc !== undefined) {
          bytes.push(esc.charCodeAt(0) & 0xff);
        }
        break;
      }
    }
  }
  return decodePdfByteSequence(bytes);
}

function decodePdfHexString(hex: string): string {
  const cleaned = hex.replace(/\s+/g, '');
  if (cleaned.length === 0) return '';
  const padded = cleaned.length % 2 === 1 ? `${cleaned}0` : cleaned;
  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    const value = parseInt(padded.slice(i, i + 2), 16);
    if (!Number.isNaN(value)) bytes.push(value);
  }
  return decodePdfByteSequence(bytes);
}

function decodePdfByteSequence(bytes: readonly number[]): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      const code = ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
      out += String.fromCharCode(code);
    }
    return out;
  }
  return Buffer.from(bytes).toString('latin1');
}

function extractBalancedParen(src: string, openIndex: number): { value: string; nextIndex: number } {
  let depth = 1;
  let i = openIndex + 1;
  let escaped = false;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return { value: src.slice(openIndex + 1, i), nextIndex: i + 1 };
      }
    }
    i += 1;
  }
  return { value: src.slice(openIndex + 1), nextIndex: src.length };
}

function extractTextFromContentStream(streamText: string): string {
  const chunks: string[] = [];
  const btPattern = /\bBT\b([\s\S]*?)\bET\b/g;
  let btMatch: RegExpExecArray | null;
  while ((btMatch = btPattern.exec(streamText)) !== null) {
    const block = btMatch[1] ?? '';
    const lineChunks = extractOperatorsFromBlock(block);
    if (lineChunks.length > 0) chunks.push(lineChunks);
  }
  if (chunks.length > 0) return chunks.join('\n');
  return extractOperatorsFromBlock(streamText);
}

function extractOperatorsFromBlock(block: string): string {
  const pieces: string[] = [];
  let i = 0;
  let pendingStrings: string[] = [];
  let inArray = false;

  while (i < block.length) {
    const ch = block[i];
    if (ch === '(') {
      const parsed = extractBalancedParen(block, i);
      pendingStrings.push(decodePdfLiteralString(parsed.value));
      i = parsed.nextIndex;
      continue;
    }
    if (ch === '<' && block[i + 1] !== '<') {
      const close = block.indexOf('>', i + 1);
      if (close !== -1) {
        pendingStrings.push(decodePdfHexString(block.slice(i + 1, close)));
        i = close + 1;
        continue;
      }
    }
    if (ch === '[') {
      inArray = true;
      pendingStrings = [];
      i += 1;
      continue;
    }
    if (ch === ']') {
      inArray = false;
      i += 1;
      continue;
    }
    if (ch !== undefined && /[A-Za-z*']/.test(ch)) {
      let end = i + 1;
      while (end < block.length && /[A-Za-z0-9*"]/.test(block[end] ?? '')) end += 1;
      const op = block.slice(i, end);
      if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
        if (pendingStrings.length > 0) {
          pieces.push(pendingStrings.join(''));
          if (op === "'" || op === '"') pieces.push('\n');
          pendingStrings = [];
        }
      } else if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'Tm') {
        if (!inArray && pieces.length > 0 && pieces.at(-1) !== '\n') {
          pieces.push('\n');
        }
      } else if (!inArray) {
        pendingStrings = [];
      }
      i = end;
      continue;
    }
    i += 1;
  }

  return pieces
    .join('')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tryDecompressStream(rawBytes: Uint8Array, dictHint: string): Uint8Array {
  const mentionsFlate = dictHint.includes('FlateDecode');
  const looksZlib =
    rawBytes.length >= 2 &&
    rawBytes[0] === 0x78 &&
    (rawBytes[1] === 0x01 || rawBytes[1] === 0x5e || rawBytes[1] === 0x9c || rawBytes[1] === 0xda);
  if (!mentionsFlate && !looksZlib) return rawBytes;
  try {
    return inflateSync(rawBytes);
  } catch {
    try {
      return inflateRawSync(rawBytes);
    } catch {
      return rawBytes;
    }
  }
}

export function extractPdfText(raw: Uint8Array): string {
  if (!isPdfBytes(raw)) {
    throw new Error('Input buffer is not a valid PDF document.');
  }
  const latin1 = Buffer.from(raw).toString('latin1');
  const extractedSections: string[] = [];
  let cursor = 0;

  while (cursor < latin1.length) {
    const streamPos = latin1.indexOf(STREAM_MARKER, cursor);
    if (streamPos === -1) break;
    let bodyStart = streamPos + STREAM_MARKER.length;
    if (latin1[bodyStart] === '\r' && latin1[bodyStart + 1] === '\n') {
      bodyStart += 2;
    } else if (latin1[bodyStart] === '\n' || latin1[bodyStart] === '\r') {
      bodyStart += 1;
    } else {
      cursor = bodyStart;
      continue;
    }
    const endPos = latin1.indexOf(ENDSTREAM_MARKER, bodyStart);
    if (endPos === -1) break;
    const dictStart = Math.max(0, streamPos - 512);
    const dictHint = latin1.slice(dictStart, streamPos);
    const slice = raw.subarray(bodyStart, endPos);
    const decoded = tryDecompressStream(slice, dictHint);
    const streamStr = Buffer.from(decoded).toString('latin1');
    if (streamStr.includes('BT') || streamStr.includes('Tj') || streamStr.includes('TJ')) {
      const text = extractTextFromContentStream(streamStr);
      if (text.length > 0 && /[A-Za-z0-9\u4e00-\u9fff]/.test(text)) {
        extractedSections.push(text);
      }
    }
    cursor = endPos + ENDSTREAM_MARKER.length;
  }

  const combined = extractedSections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (combined.length === 0) {
    return '[PDF contained no extractable text streams (it may be scanned, image-only, or encrypted).]';
  }
  return combined;
}
