import type { RecallItem, RecallResult } from './types';

const CHARS_PER_ASCII_TOKEN = 4;

function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / CHARS_PER_ASCII_TOKEN) + nonAscii;
}

export function renderRecall(result: RecallResult, maxTokens: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const item of result.items) {
    const line = formatItem(item);
    const cost = estimateTokens(line);
    if (lines.length > 0 && used + cost > maxTokens) break;
    lines.push(line);
    used += cost;
  }
  return lines.join('\n');
}

function formatItem(item: RecallItem): string {
  const source = item.conceptId === undefined ? item.noteId : `${item.noteId} / ${item.conceptId}`;
  const conflict = item.conflictGroup === undefined ? '' : ' [冲突]';
  return `- ${item.text} (${source})${conflict}`;
}
