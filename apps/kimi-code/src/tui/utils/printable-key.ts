import { decodeKittyPrintable } from '@moonshot-ai/pi-tui';

export function printableChar(data: string): string {
  return decodeKittyPrintable(data) ?? data;
}

export function isPrintableChar(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.codePointAt(0)!;
  return code >= 0x20 && code !== 0x7f;
}

/**
 * True when every codepoint of `text` is printable — accepts multi-character
 * paste chunks, rejects C0/C1 control chars, DEL, and escape sequences.
 */
export function isPrintableText(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length;) {
    const code = text.codePointAt(i);
    if (code === undefined) return false;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false;
    i += code > 0xffff ? 2 : 1;
  }
  return true;
}
