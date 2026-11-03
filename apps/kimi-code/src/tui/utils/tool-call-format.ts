import type { TokenUsage } from '@moonshot-ai/kimi-code-sdk';
import { stripTerminalSequences } from '@moonshot-ai/pi-tui';

import { SUBAGENT_PREVIEW_TEXT_MAX_CHARS } from '#/tui/constant/rendering';
import { formatTokenCount } from '#/utils/usage/usage-format';

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function usageInputTotal(usage: TokenUsage): number {
  return (usage.inputOther ?? 0) + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0);
}

export function usageTotal(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return usageInputTotal(usage) + usage.output;
}

export function formatSubagentContextTokens(contextTokens: number | undefined): string | undefined {
  if (contextTokens === undefined || contextTokens <= 0) return undefined;
  return `${formatTokenCount(contextTokens)} tok`;
}

export function formatSubagentTokens(usage: TokenUsage | undefined): string | undefined {
  const total = usageTotal(usage);
  if (total <= 0) return undefined;
  return `${formatTokenCount(total)} tok`;
}

export function formatTokens(n: number): string {
  return `${formatTokenCount(n)} tok`;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m ${String(remainder)}s`;
}

export function tailNonEmptyLines(text: string, maxLines: number): string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let end = text.length;
  while (end > 0 && lines.length < maxLines) {
    const start = text.lastIndexOf('\n', end - 1);
    const line = text.slice(start + 1, end).trimEnd();
    if (line.trim().length > 0) lines.push(line);
    end = start === -1 ? 0 : start;
  }
  return lines.toReversed();
}

/**
 * The last `maxLines` source lines without splitting the whole string —
 * the cards below only ever show a two-row window, so scanning back from the
 * end keeps the cost proportional to what is displayed rather than to the
 * accumulated subagent output.
 */
export function tailSourceLines(text: string, maxLines: number): string {
  let end = text.length;
  for (let seen = 0; seen < maxLines; seen++) {
    if (end === 0) return text;
    const start = text.lastIndexOf('\n', end - 1);
    if (start === -1) return text;
    end = start;
  }
  return text.slice(end + 1);
}

/**
 * Keeps the trailing slice of streamed subagent text that the card can show.
 * The cut drops the first, partial line so every retained line starts at a
 * line boundary: wrapping is then identical to the unbounded text, and no
 * escape sequence is left half-open. A single logical line longer than the cap
 * has no boundary to align to, so it keeps its raw tail.
 */
export function tailPreviewText(text: string): string {
  if (text.length <= SUBAGENT_PREVIEW_TEXT_MAX_CHARS) return text;
  const tail = text.slice(text.length - SUBAGENT_PREVIEW_TEXT_MAX_CHARS);
  const lineBreak = tail.indexOf('\n');
  if (lineBreak !== -1) {
    const aligned = tail.slice(lineBreak + 1);
    // Only drop the partial first line when two non-empty lines remain: those
    // wrap exactly as they would unbounded. A trailing blank does not count —
    // the finished window filters empty lines — and otherwise the partial line
    // is what fills the window, so the raw tail is the better answer.
    if (tailNonEmptyLines(aligned, 2).length === 2) {
      return stripTerminalSequences(aligned);
    }
  }
  // The card applies its own styling, so control sequences carried in the
  // streamed text are dropped rather than replayed without their opener.
  return stripTerminalSequences(tail);
}

export function lastNonEmptyLine(text: string): string | undefined {
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1);
    const trimmed = text.slice(start + 1, end).trim();
    if (trimmed.length > 0) return trimmed;
    end = start === -1 ? 0 : start;
  }
  return undefined;
}
