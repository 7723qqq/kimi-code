import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import {
  buildCompactionContinuationText,
  buildCompactionElisionText,
  COMPACT_USER_MESSAGE_HEAD_TOKENS,
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  selectCompactionUserMessages,
  truncateUserMessage,
} from '#/llm-adapter/contract/compaction';
import {
  estimateTokens,
  estimateTokensForMessage,
  estimateTokensForMessages,
} from '#/llm-adapter/contract/tokens';

export {
  buildCompactionContinuationText,
  buildCompactionElisionText,
  COMPACT_USER_MESSAGE_HEAD_TOKENS,
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  selectCompactionUserMessages,
  replaceMessageText,
  type CompactionUserSelection,
} from '#/llm-adapter/contract/compaction';

import summaryPrefixTemplate from './compaction-summary-prefix.md?raw';
import type { ContextMessage, PromptOrigin } from './types';

export const COMPACTION_SUMMARY_PREFIX = summaryPrefixTemplate.trimEnd();
export const COMPACTION_ELISION_VARIANT = 'compaction_elision';
export const COMPACTION_CONTINUATION_VARIANT = 'compaction_continuation';

type MessageLike = ContextMessage;

export interface TokenEstimate {
  readonly text: (text: string) => number;
  readonly message: (message: MessageLike) => number;
  readonly messages: (messages: readonly MessageLike[]) => number;
}

export const defaultTokenEstimate: TokenEstimate = {
  text: estimateTokens,
  message: estimateTokensForMessage,
  messages: estimateTokensForMessages,
};

export interface ContextCompactionShapeInput {
  readonly summary: string;
  readonly legacySummaryMessage?: ContextMessage;
  readonly contextSummary?: string;
  readonly inFlightTurn?: readonly ContextMessage[];
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter?: number;
  readonly summaryOutputTokens?: number;
  readonly requestOverheadTokens?: number;
  readonly keptUserMessageCount?: number;
  readonly keptHeadUserMessageCount?: number;
  readonly droppedCount?: number;
  readonly legacyTail?: boolean;
}

export interface ContextCompactionShape {
  readonly summary: string;
  readonly contextSummary: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly keptUserMessageCount: number;
  readonly keptHeadUserMessageCount?: number;
  readonly appendedInjectionCount: number;
  readonly droppedCount?: number;
  readonly messages: readonly ContextMessage[];
}

export function buildContextCompactionShape(
  history: readonly ContextMessage[],
  input: ContextCompactionShapeInput,
  estimate: TokenEstimate = defaultTokenEstimate,
): ContextCompactionShape {
  if (usesLegacyTailShape(input)) {
    const contextSummary = input.contextSummary ?? input.summary;
    const messages = [
      input.legacySummaryMessage ?? createCompactionSummaryMessage(contextSummary),
      ...history.slice(input.compactedCount),
    ];
    return {
      summary: input.summary,
      contextSummary,
      compactedCount: input.compactedCount,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter ?? estimate.messages(messages),
      keptUserMessageCount: 0,
      appendedInjectionCount: 0,
      droppedCount: input.droppedCount,
      messages,
    };
  }

  const compactableUserMessages = collectCompactableUserMessages(history);
  const selection = selectCompactionUserMessages(
    compactableUserMessages,
    COMPACT_USER_MESSAGE_MAX_TOKENS,
    COMPACT_USER_MESSAGE_HEAD_TOKENS,
    estimate.message,
  );
  const elisionMessage = selection.elided
    ? createCompactionElisionMessage(selection.omittedTokens)
    : undefined;
  const keptMessages =
    elisionMessage === undefined
      ? [...selection.head, ...selection.tail]
      : [...selection.head, elisionMessage, ...selection.tail];
  const contextSummary = input.contextSummary ?? input.summary;
  const continuationMessage = createCompactionContinuationMessage();
  const retainedInFlight = (message: ContextMessage): boolean =>
    !(message.origin?.kind === 'injection' && message.origin.rearmOnCompaction === true);
  const inFlightTurn = (input.inFlightTurn ?? []).filter(retainedInFlight);
  const inFlightMessages = new Set<ContextMessage>(inFlightTurn);
  const appendedInjections = history
    .slice(input.compactedCount)
    .filter(
      (message) =>
        message.origin?.kind === 'injection' &&
        retainedInFlight(message) &&
        !inFlightMessages.has(message),
    );
  const tokensAfter =
    input.tokensAfter ??
    (input.requestOverheadTokens ?? 0) +
      (input.summaryOutputTokens ?? estimate.text(contextSummary)) +
      estimate.messages([
        ...keptMessages,
        ...inFlightTurn,
        continuationMessage,
        ...appendedInjections,
      ]);
  const keptUserMessageCount =
    input.keptUserMessageCount ?? selection.head.length + selection.tail.length;
  const keptHeadUserMessageCount =
    input.keptHeadUserMessageCount ?? (selection.elided ? selection.head.length : undefined);

  return {
    summary: input.summary,
    contextSummary,
    compactedCount: input.compactedCount,
    tokensBefore: input.tokensBefore,
    tokensAfter,
    keptUserMessageCount,
    keptHeadUserMessageCount,
    appendedInjectionCount: appendedInjections.length,
    droppedCount: input.droppedCount,
    messages: [
      ...keptMessages,
      ...inFlightTurn,
      createCompactionSummaryMessage(contextSummary),
      continuationMessage,
      ...appendedInjections,
    ],
  };
}

export function buildCompactionSummaryText(summary: string): string {
  const suffix = summary.trim();
  return wrapSystemReminder(
    `${COMPACTION_SUMMARY_PREFIX}\n${suffix.length > 0 ? suffix : '(no summary available)'}`,
  );
}

export function createCompactionSummaryMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}

export function createCompactionElisionMessage(omittedTokens: number): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: buildCompactionElisionText(omittedTokens) }],
    toolCalls: [],
    origin: { kind: 'injection', variant: COMPACTION_ELISION_VARIANT },
  };
}

export function createCompactionContinuationMessage(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: buildCompactionContinuationText() }],
    toolCalls: [],
    origin: { kind: 'injection', variant: COMPACTION_CONTINUATION_VARIANT },
  };
}

export function collectCompactableUserMessages<T extends MessageLike>(messages: readonly T[]): T[] {
  return messages.filter(
    (message) => isRealUserInput(message) && !isCompactionSummaryMessage(message),
  );
}

export function isCompactionSummaryMessage(message: MessageLike): boolean {
  return message.origin?.kind === 'compaction_summary';
}

export function isRealUserInput(message: MessageLike): boolean {
  return message.role === 'user' && compactionUserMessageDisposition(message.origin) === 'keep';
}

export function compactionUserMessageDisposition(
  origin: PromptOrigin | undefined,
): 'keep' | 'drop' {
  if (origin === undefined) return 'keep';
  switch (origin.kind) {
    case 'user':
      return 'keep';
    case 'skill_activation':
    case 'plugin_command':
      return origin.trigger === 'user-slash' ? 'keep' : 'drop';
    case 'injection':
    case 'shell_command':
    case 'compaction_summary':
    case 'system_trigger':
    case 'task':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'retry':
      return 'drop';
    default: {
      const exhaustive: never = origin;
      void exhaustive;
      return 'drop';
    }
  }
}

export function selectRecentUserMessages<T extends MessageLike>(
  messages: readonly T[],
  maxTokens: number = COMPACT_USER_MESSAGE_MAX_TOKENS,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): T[] {
  const selected: T[] = [];
  let remaining = maxTokens;
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const message = messages[i]!;
    const tokens = estimateMessage(message);
    if (tokens <= remaining) {
      selected.push(message);
      remaining -= tokens;
    } else {
      selected.push(truncateUserMessage(message, remaining));
      break;
    }
  }
  selected.reverse();
  return selected;
}

function usesLegacyTailShape(input: ContextCompactionShapeInput): boolean {
  return input.legacyTail === true;
}
