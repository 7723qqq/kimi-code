import type { ContentPart, ToolCall } from '../message';
import { estimateTokensForMessage } from '../llm/tokens';
import { wrapSystemReminder } from '../utils/systemReminder';
import { extractText, truncateTextToTokens, truncateTextToTokensFromEnd } from './compactionText';
import { isUserPromptSubmitHookPart } from './hookParts';
import { isSkillActivationPart } from './origin';

export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
export const COMPACT_USER_MESSAGE_HEAD_TOKENS = 2_000;

export interface CompactionUserSelection<T> {
  readonly head: T[];
  readonly tail: T[];
  readonly elided: boolean;
  readonly omittedTokens: number;
}

export function buildCompactionElisionText(omittedTokens: number): string {
  return wrapSystemReminder(
    `Some of this conversation's user messages were omitted here during compaction: the messages above this note are the oldest user input, the messages below are the most recent, and roughly ${String(omittedTokens)} tokens in between were dropped. The omitted content is covered by the compaction summary at the end of the conversation.`,
  );
}

export function buildCompactionContinuationText(): string {
  return wrapSystemReminder(
    'Context compaction is complete — continue the work that was in progress when it began.',
  );
}

export function selectCompactionUserMessages<
  T extends { role: string; content: ContentPart[]; toolCalls?: readonly ToolCall[] },
>(
  messages: readonly T[],
  maxTokens: number = COMPACT_USER_MESSAGE_MAX_TOKENS,
  headTokens: number = COMPACT_USER_MESSAGE_HEAD_TOKENS,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): CompactionUserSelection<T> {
  let totalTokens = 0;
  for (const message of messages) {
    totalTokens += estimateMessage(message);
  }
  if (totalTokens <= maxTokens) {
    return { head: [], tail: [...messages], elided: false, omittedTokens: 0 };
  }

  const headBudget = Math.min(Math.max(headTokens, 0), maxTokens);
  const tailBudget = maxTokens - headBudget;
  const tail: T[] = [];
  let tailRemaining = tailBudget;
  let headEndExclusive = messages.length;
  let tailBoundaryDroppedPrefix: T | null = null;
  for (let i = messages.length - 1; i >= 0 && tailRemaining > 0; i--) {
    const message = messages[i]!;
    const tokens = estimateMessage(message);
    if (tokens <= tailRemaining) {
      tail.push(message);
      tailRemaining -= tokens;
      headEndExclusive = i;
      continue;
    }
    const fullText = extractText(message.content);
    const keptSuffix = truncateTextToTokensFromEnd(fullText, tailRemaining);
    tail.push(replaceMessageText(message, keptSuffix));
    headEndExclusive = i;
    const droppedPrefix = fullText.slice(0, fullText.length - keptSuffix.length);
    if (droppedPrefix.length > 0) {
      tailBoundaryDroppedPrefix = replaceMessageText(message, droppedPrefix);
    }
    break;
  }
  tail.reverse();

  const headCandidates = messages.slice(0, headEndExclusive);
  if (tailBoundaryDroppedPrefix !== null) {
    headCandidates.push(tailBoundaryDroppedPrefix);
  }
  const head: T[] = [];
  let headRemaining = headBudget;
  for (const message of headCandidates) {
    if (headRemaining <= 0) break;
    const tokens = estimateMessage(message);
    if (tokens <= headRemaining) {
      head.push(message);
      headRemaining -= tokens;
      continue;
    }
    head.push(truncateUserMessage(message, headRemaining));
    break;
  }

  let keptTokens = 0;
  for (const message of head) keptTokens += estimateMessage(message);
  for (const message of tail) keptTokens += estimateMessage(message);
  return { head, tail, elided: true, omittedTokens: Math.max(0, totalTokens - keptTokens) };
}

export function replaceMessageText<
  T extends { content: ContentPart[]; toolCalls?: readonly ToolCall[] },
>(message: T, text: string): T {
  return {
    ...message,
    content: [
      ...message.content.filter(
        (part) => isUserPromptSubmitHookPart(part) || isSkillActivationPart(part),
      ),
      { type: 'text', text },
    ],
    toolCalls: [],
  } as unknown as T;
}

export function truncateUserMessage<
  T extends { role: string; content: ContentPart[]; toolCalls?: readonly ToolCall[] },
>(message: T, maxTokens: number): T {
  return replaceMessageText(message, truncateTextToTokens(extractText(message.content), maxTokens));
}
