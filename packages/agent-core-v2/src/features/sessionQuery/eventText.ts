/**
 * `sessionQuery` domain — semantic text extraction from wire records.
 *
 * Renders one main-agent wire record into the searchable text of its event:
 * the textual payload fields (message text, tool arguments/results, LLM
 * prompt/completion) are joined in a stable order, empty records contribute
 * no text. Best-effort and lossy by design — the text backs search only, not
 * reconstruction (the journal itself is the source of truth).
 */

import type { WireRecord } from '#/wire/record';

const TEXT_FIELDS = [
  'text',
  'prompt',
  'output',
  'content',
  'arguments',
  'input',
  'delta',
  'result',
  'reason',
  'description',
] as const;

/**
 * Extract the semantic text of one wire record.
 * @param record - the wire record to render.
 * @returns the joined text, or '' when the record carries no textual payload.
 */
export function wireRecordText(record: WireRecord): string {
  const parts: string[] = [];
  for (const field of TEXT_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) {
      parts.push(value);
    }
  }
  const content = record['content'];
  if (Array.isArray(content)) {
    pushContentParts(content, parts);
  }
  // Assistant/user messages nest their content under `message`.
  const message = record['message'];
  if (typeof message === 'object' && message !== null) {
    const messageContent = (message as { content?: unknown }).content;
    if (Array.isArray(messageContent)) {
      pushContentParts(messageContent, parts);
    }
    const messageText = (message as { text?: unknown }).text;
    if (typeof messageText === 'string' && messageText.length > 0) parts.push(messageText);
  }
  return parts.join('\n');
}

function pushContentParts(content: readonly unknown[], parts: string[]): void {
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > 0) parts.push(text);
  }
}
