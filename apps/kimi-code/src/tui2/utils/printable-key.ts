/**
 * TUI2 printable-key decoding.
 *
 * Mirrors `tui/utils/printable-key.ts` — decodes raw stdin bytes into a
 * comparable printable character. When a terminal (e.g. the VSCode
 * integrated terminal) enables the Kitty keyboard protocol disambiguate
 * flag, ordinary printable keys are sent as CSI-u sequences: pressing `r`
 * arrives as "\x1b[114u". A bare `data === 'q'` comparison therefore never
 * matches under Kitty-mode terminals.
 *
 * Status: REAL (tui2). Mirrors `tui/utils/printable-key.ts`.
 */

import { decodeKittyPrintable } from '@moonshot-ai/pi-tui';

export function printableChar(data: string): string {
  return decodeKittyPrintable(data) ?? data;
}

/**
 * True when a decoded key is a single printable character safe to append to a
 * text query (e.g. a search box). Rejects C0 control chars, DEL, and any
 * multi-codepoint escape sequence. Space is accepted.
 */
export function isPrintableChar(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.codePointAt(0)!;
  return code >= 0x20 && code !== 0x7f;
}
