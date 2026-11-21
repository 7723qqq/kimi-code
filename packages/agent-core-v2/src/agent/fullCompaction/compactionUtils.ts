import { isRealUserInput } from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { AgentLLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import { APIEmptyResponseError, APIStatusError } from '#/app/llmProtocol/errors';
import type { Message } from '#/app/llmProtocol/message';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import { estimateTokensForMessage } from '#/llm-adapter/contract/tokens';
import { grandTotal } from '@moonshot-ai/core/llm/usage';

export const COMPACTION_OVERFLOW_SHRINK_RATIOS = [0.7, 0.5, 0.35] as const;

export interface HistoryTokenProfile {
  readonly overheadTokens: number;
  readonly estimateMessage: (message: Message) => number;
  readonly estimateRequest: (messages: readonly Message[]) => number;
}

export function assistantUsageTotal(message: Message): number | undefined {
  if (message.role !== 'assistant') return undefined;
  const usage = (message as ContextMessage).usage;
  if (usage === undefined) return undefined;
  const total = grandTotal(usage);
  return total !== undefined && Number.isFinite(total) && total > 0 ? total : undefined;
}

export function buildHistoryTokenProfile(
  history: readonly ContextMessage[],
  baseOverheadTokens: number,
  estimateBase: (message: Message) => number,
): HistoryTokenProfile {
  const weights = history.map((message) => estimateBase(message));
  const anchors: { index: number; tokens: number }[] = [];
  for (let i = 0; i < history.length; i++) {
    const tokens = assistantUsageTotal(history[i]!);
    if (tokens !== undefined) {
      anchors.push({ index: i, tokens });
    }
  }
  if (anchors.length === 0) {
    return {
      overheadTokens: baseOverheadTokens,
      estimateMessage: estimateBase,
      estimateRequest: (messages) => {
        let total = baseOverheadTokens;
        for (const message of messages) total += estimateBase(message);
        return total;
      },
    };
  }

  for (let k = anchors.length - 2; k >= 0; k--) {
    if (anchors[k]!.tokens > anchors[k + 1]!.tokens) {
      anchors[k]!.tokens = anchors[k + 1]!.tokens;
    }
  }

  let prevIndex = -1;
  let prevTokens = baseOverheadTokens;
  for (let k = 0; k < anchors.length; k++) {
    const { index, tokens } = anchors[k]!;
    let spanEstimate = 0;
    for (let j = prevIndex + 1; j <= index; j++) {
      spanEstimate += weights[j]!;
    }
    const measuredDelta = tokens - prevTokens;
    if (measuredDelta > spanEstimate) {
      distributeExcessTokens(
        weights,
        prevIndex + 1,
        index,
        spanEstimate,
        measuredDelta - spanEstimate,
      );
    }
    prevIndex = index;
    prevTokens = tokens;
  }

  const byMessage = new Map<Message, number>();
  for (let i = 0; i < history.length; i++) {
    byMessage.set(history[i]!, weights[i]!);
  }
  const estimateMessage = (message: Message): number =>
    byMessage.get(message) ?? estimateBase(message);
  return {
    overheadTokens: baseOverheadTokens,
    estimateMessage,
    estimateRequest: (messages) => {
      let total = baseOverheadTokens;
      for (const message of messages) total += estimateMessage(message);
      return total;
    },
  };
}

function distributeExcessTokens(
  weights: number[],
  start: number,
  end: number,
  spanEstimate: number,
  excess: number,
): void {
  if (excess <= 0 || start > end) return;
  if (spanEstimate <= 0) {
    weights[end] = (weights[end] ?? 0) + excess;
    return;
  }
  const baseSlice = weights.slice(start, end + 1);
  let distributed = 0;
  for (let j = start; j <= end; j++) {
    const add = Math.floor((excess * baseSlice[j - start]!) / spanEstimate);
    weights[j] = weights[j]! + add;
    distributed += add;
  }
  weights[end] = weights[end]! + (excess - distributed);
}

export interface CompactionAttemptResult {
  readonly summary: string;
  readonly usage: TokenUsage | null;
  readonly traceId?: string;
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
    throw new APIEmptyResponseError('The compaction response did not contain a non-empty summary.');
  }

  return { summary, usage: finish.usage, traceId: finish.traceId };
}

export function historySafeToCompact(
  current: readonly ContextMessage[],
  original: readonly ContextMessage[],
): boolean {
  if (current.length < original.length) return false;
  if (!original.every((message, index) => message === current[index])) return false;
  return current
    .slice(original.length)
    .every((message) => isRealUserInput(message) || message.origin?.kind === 'injection');
}

export function shrinkCompactionHistoryAfterOverflow<T extends Message>(
  messages: readonly T[],
  attempt: number,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): T[] {
  if (messages.length <= 1) return messages.slice();
  const ratio =
    COMPACTION_OVERFLOW_SHRINK_RATIOS[
      Math.min(attempt - 1, COMPACTION_OVERFLOW_SHRINK_RATIOS.length - 1)
    ]!;
  let totalTokens = 0;
  for (const message of messages) totalTokens += estimateMessage(message);
  const tokenBudget = Math.floor(totalTokens * ratio);
  return takeRecentMessagesWithinTokenBudget(messages, tokenBudget, estimateMessage);
}

export function takeRecentMessagesWithinTokenBudget<T extends Message>(
  messages: readonly T[],
  tokenBudget: number,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): T[] {
  let start = messages.length;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = estimateMessage(messages[i]!);
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

export function dropLeadingToolResults<T extends { readonly role: string }>(
  messages: readonly T[],
): T[] {
  let start = 0;
  while (start < messages.length && messages[start]!.role === 'tool') {
    start += 1;
  }
  return messages.slice(start);
}

export const SNIPPED_TOOL_RESULT_MARKER = '[snipped tool result — ';
export const DEFAULT_TOOL_RESULT_SNIP_MIN_BYTES = 1024;
export const DEFAULT_TOOL_RESULT_SNIP_HEAD_LINES = 40;
export const DEFAULT_TOOL_RESULT_SNIP_TAIL_LINES = 40;

export interface SnipToolResultOptions {
  readonly minBytes?: number;
  readonly headLines?: number;
  readonly tailLines?: number;
}

export function snipLargeToolResults<
  T extends { readonly role: string; readonly content: readonly unknown[] },
>(messages: readonly T[], options?: SnipToolResultOptions): T[] {
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
  const textPart = message.content.find(
    (part): part is { readonly type: 'text'; readonly text: string } =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string',
  );
  if (textPart === undefined) return message;
  if (textPart.text.startsWith(SNIPPED_TOOL_RESULT_MARKER)) return message;
  if (textPart.text.length < minBytes) return message;

  const lines = textPart.text.split('\n');
  if (lines.length <= headLines + tailLines) return message;
  const head = lines.slice(0, headLines).join('\n');
  const tail = lines.slice(-tailLines).join('\n');
  const omitted = lines.length - headLines - tailLines;
  const replacement =
    `${SNIPPED_TOOL_RESULT_MARKER}${omitted} lines omitted for compaction; ` +
    `re-run the tool if the full output is needed]\n${head}\n` +
    `[... ${omitted} lines omitted ...]\n${tail}`;
  return { ...message, content: [{ type: 'text' as const, text: replacement }] };
}
