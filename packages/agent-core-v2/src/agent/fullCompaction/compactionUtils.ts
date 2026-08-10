import {
  estimateTokensForMessage,
  estimateTokensForMessages,
} from '#/kosong/contract/tokens';
import { isRealUserInput } from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  APIEmptyResponseError,
  APIStatusError,
} from '#/app/llmProtocol/errors';
import type { AgentLLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import type { Message } from '#/app/llmProtocol/message';
import type { TokenUsage } from '#/app/llmProtocol/usage';

export const COMPACTION_OVERFLOW_SHRINK_RATIOS = [0.7, 0.5, 0.35] as const;

export interface CompactionAttemptResult {
  readonly summary: string;
  readonly usage: TokenUsage | null;
}

export class CompactionTruncatedError extends Error {
  constructor() {
    super('Compaction response was truncated before producing a complete summary.');
    this.name = 'CompactionTruncatedError';
  }
}

export function findAPIStatusError(error: unknown): APIStatusError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current instanceof APIStatusError) return current;
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

export function collectSummary(finish: AgentLLMRequestFinish): CompactionAttemptResult {
  if (finish.providerFinishReason === 'truncated') {
    throw new CompactionTruncatedError();
  }

  const summary = finish.message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
  if (summary.length === 0) {
    throw new APIEmptyResponseError(
      'The compaction response did not contain a non-empty summary.',
    );
  }

  return { summary, usage: finish.usage };
}

export function historySafeToCompact(
  current: readonly ContextMessage[],
  original: readonly ContextMessage[],
): boolean {
  if (current.length < original.length) return false;
  if (!original.every((message, index) => message === current[index])) return false;
  return current.slice(original.length).every(isRealUserInput);
}

export function shrinkCompactionHistoryAfterOverflow<T extends Message>(
  messages: readonly T[],
  attempt: number,
): T[] {
  if (messages.length <= 1) return messages.slice();
  const ratio = COMPACTION_OVERFLOW_SHRINK_RATIOS[
    Math.min(attempt - 1, COMPACTION_OVERFLOW_SHRINK_RATIOS.length - 1)
  ]!;
  const tokenBudget = Math.floor(estimateTokensForMessages(messages) * ratio);
  return takeRecentMessagesWithinTokenBudget(messages, tokenBudget);
}

function takeRecentMessagesWithinTokenBudget<T extends Message>(
  messages: readonly T[],
  tokenBudget: number,
): T[] {
  let start = messages.length;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = estimateTokensForMessage(messages[i]!);
    if (tokens + messageTokens > tokenBudget) break;
    tokens += messageTokens;
    start = i;
  }
  if (start === 0) start = 1;
  return dropLeadingToolResults(messages.slice(start));
}

export function dropOldestMessageAndLeadingToolResults<T extends { readonly role: string }>(
  messages: readonly T[],
): T[] {
  if (messages.length <= 1) return messages.slice();
  return dropLeadingToolResults(messages.slice(1));
}

export function dropLeadingToolResults<T extends { readonly role: string }>(messages: readonly T[]): T[] {
  let start = 0;
  while (start < messages.length && messages[start]!.role === 'tool') {
    start += 1;
  }
  return messages.slice(start);
}

// ── Stale tool-result snipping (ported from Reasonix's prune.go) ────────────
//
// Compaction summarizes the whole history; giant tool outputs (build logs,
// test runs, file dumps) can be tens of thousands of tokens, which blows up
// the summarizer request and forces overflow shrinking (whole messages
// dropped). Snipping shortens *stale tool-result content* in the summarizer
// input while keeping the message itself, so the model still sees the tool was
// called and gets the head/tail of its output. It only ever touches the
// copy handed to the summarizer (`historyForModel`) — the canonical history
// and therefore the provider prompt-cache prefix are never rewritten.

export const SNIPPED_TOOL_RESULT_MARKER = '[snipped tool result — ';
export const DEFAULT_TOOL_RESULT_SNIP_MIN_BYTES = 1024;
export const DEFAULT_TOOL_RESULT_SNIP_HEAD_LINES = 40;
export const DEFAULT_TOOL_RESULT_SNIP_TAIL_LINES = 40;

export interface SnipToolResultOptions {
  readonly minBytes?: number;
  readonly headLines?: number;
  readonly tailLines?: number;
}

export function snipLargeToolResults<T extends { readonly role: string; readonly content: readonly unknown[] }>(
  messages: readonly T[],
  options?: SnipToolResultOptions,
): T[] {
  const minBytes = options?.minBytes ?? DEFAULT_TOOL_RESULT_SNIP_MIN_BYTES;
  const headLines = options?.headLines ?? DEFAULT_TOOL_RESULT_SNIP_HEAD_LINES;
  const tailLines = options?.tailLines ?? DEFAULT_TOOL_RESULT_SNIP_TAIL_LINES;
  let changed: T[] | undefined;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role !== 'tool') {
      if (changed !== undefined) changed.push(message);
      continue;
    }
    const next = snipToolResultContent(message, minBytes, headLines, tailLines);
    if (next === message) {
      if (changed !== undefined) changed.push(message);
      continue;
    }
    if (changed === undefined) changed = messages.slice(0, i);
    changed.push(next as T);
  }
  return changed ?? [...messages];
}

function snipToolResultContent(
  message: { readonly role: string; readonly content: readonly unknown[] },
  minBytes: number,
  headLines: number,
  tailLines: number,
): { readonly role: string; readonly content: readonly unknown[] } | typeof message {
  // Only single-text tool results are snipped (the overwhelmingly common
  // shape); multimodal content is left untouched.
  const textPart = message.content.find(
    (part): part is { readonly type: 'text'; readonly text: string } =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string',
  );
  if (textPart === undefined) return message;
  if (textPart.text.startsWith(SNIPPED_TOOL_RESULT_MARKER)) return message; // idempotent
  if (textPart.text.length < minBytes) return message;

  const lines = textPart.text.split('\n');
  if (lines.length <= headLines + tailLines) return message; // short enough as-is
  const head = lines.slice(0, headLines).join('\n');
  const tail = lines.slice(-tailLines).join('\n');
  const omitted = lines.length - headLines - tailLines;
  const replacement =
    `${SNIPPED_TOOL_RESULT_MARKER}${omitted} lines omitted for compaction; ` +
    `re-run the tool if the full output is needed]\n${head}\n` +
    `[... ${omitted} lines omitted ...]\n${tail}`;
  return { ...message, content: [{ type: 'text' as const, text: replacement }] };
}
