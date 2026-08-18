/**
 * Gradient text for opentui.
 *
 * Replaces `tui/theme/gradient-text.ts`, which returned an ANSI-wrapped
 * string via chalk. opentui renderables consume colour through
 * `TextChunk[]` / `StyledText`, so the v2 version returns a `TextChunk` per
 * character, each carrying its own foreground `RGBA`. Callers hand the array
 * to a `Text` renderable (`setStyledText` / `StyledText`) instead of printing
 * escape codes.
 *
 * Status: REAL (tui2). Replaces the v1 chalk-backed stub.
 */

import { RGBA } from '@opentui/core';
import type { TextChunk } from '@opentui/core';

interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/**
 * Render `text` as a per-character gradient from `fromHex` to `toHex`,
 * returning a `TextChunk[]` ready for opentui. `accentBias` scales how far
 * along the gradient the last character sits (1 = full range, <1 = shorter).
 */
export function gradientTextChunks(
  text: string,
  fromHex: string,
  toHex: string,
  accentBias = 1,
): TextChunk[] {
  const chars = Array.from(text);
  const from = parseHexColor(fromHex);
  const to = parseHexColor(toHex);
  if (chars.length <= 1 || from === undefined || to === undefined) {
    return [{ __isChunk: true, text, fg: RGBA.fromHex(fromHex) }];
  }
  const safeAccentBias = Number.isFinite(accentBias) ? Math.max(0, accentBias) : 1;
  return chars.map((char, index) => {
    const ratio = Math.min(1, (index / (chars.length - 1)) * safeAccentBias);
    return {
      __isChunk: true,
      text: char,
      fg: RGBA.fromHex(interpolateHexColor(from, to, ratio)),
    } satisfies TextChunk;
  });
}

/** Returns the plain text of a gradient — useful for width measurement. */
export function gradientTextPlain(text: string): string {
  return text;
}

function parseHexColor(hex: string): RgbColor | undefined {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (match === null) return undefined;
  const [, r, g, b] = match;
  if (r === undefined || g === undefined || b === undefined) return undefined;
  return {
    red: Number.parseInt(r, 16),
    green: Number.parseInt(g, 16),
    blue: Number.parseInt(b, 16),
  };
}

function interpolateHexColor(from: RgbColor, to: RgbColor, ratio: number): string {
  const mix = (start: number, end: number): string =>
    Math.round(start + (end - start) * ratio)
      .toString(16)
      .padStart(2, '0');
  return `#${mix(from.red, to.red)}${mix(from.green, to.green)}${mix(from.blue, to.blue)}`;
}
