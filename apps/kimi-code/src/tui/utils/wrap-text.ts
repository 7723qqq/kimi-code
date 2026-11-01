import { wrapTextWithAnsi } from '@moonshot-ai/pi-tui';

/**
 * Word-wrap to `width` with ANSI codes preserved. Unlike a plain
 * `split(/\s+/)` wrap, over-long runs — CJK sentences contain no spaces, so
 * a whole paragraph arrives as one "word" — are broken across lines
 * character-by-character instead of being truncated into a single
 * ellipsis-terminated line.
 */
export function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const normalized = text.replaceAll(/\s+/g, ' ').trim();
  if (normalized.length === 0) return [''];
  return wrapTextWithAnsi(normalized, safeWidth);
}
