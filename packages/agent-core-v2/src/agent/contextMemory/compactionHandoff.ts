import { estimateTokens, estimateTokensForMessage, estimateTokensForMessages } from '#/kosong/contract/tokens';
import type { ContentPart } from '#/kosong/contract/message';
import { tryNativeSelectCompactionUserMessages, type NativeCompactionUserSelection } from '#/_base/native-tools';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import summaryPrefixTemplate from './compaction-summary-prefix.md?raw';
import type { ContextMessage, PromptOrigin } from './types';

export const COMPACTION_SUMMARY_PREFIX = summaryPrefixTemplate.trimEnd();
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
export const COMPACT_USER_MESSAGE_HEAD_TOKENS = 2_000;
export const COMPACTION_ELISION_VARIANT = 'compaction_elision';

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

export interface CompactionUserSelection<T> {
  readonly head: T[];
  readonly tail: T[];
  readonly elided: boolean;
  readonly omittedTokens: number;
}

export interface ContextCompactionShapeInput {
  readonly summary: string;
  readonly legacySummaryMessage?: ContextMessage;
  readonly contextSummary?: string;
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
  const keptMessages = elisionMessage === undefined
    ? [...selection.head, ...selection.tail]
    : [...selection.head, elisionMessage, ...selection.tail];
  const contextSummary = input.contextSummary ?? input.summary;
  const tokensAfter =
    input.tokensAfter ??
    (input.requestOverheadTokens ?? 0) +
      (input.summaryOutputTokens ?? estimate.text(contextSummary)) +
      estimate.messages(keptMessages);
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
    droppedCount: input.droppedCount,
    messages: [...keptMessages, createCompactionSummaryMessage(contextSummary)],
  };
}

export function buildCompactionSummaryText(summary: string): string {
  const suffix = summary.trim();
  return `${COMPACTION_SUMMARY_PREFIX}\n${suffix.length > 0 ? suffix : '(no summary available)'}`;
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

export function buildCompactionElisionText(omittedTokens: number): string {
  return wrapSystemReminder(
    `Some of this conversation's user messages were omitted here during compaction: the messages above this note are the oldest user input, the messages below are the most recent, and roughly ${String(omittedTokens)} tokens in between were dropped. The omitted content is covered by the compaction summary at the end of the conversation.`,
  );
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

export function selectCompactionUserMessages<T extends MessageLike>(
  messages: readonly T[],
  maxTokens: number = COMPACT_USER_MESSAGE_MAX_TOKENS,
  headTokens: number = COMPACT_USER_MESSAGE_HEAD_TOKENS,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): CompactionUserSelection<T> {
  // Native fast path: the Rust engine selects head/tail indices and reports
  // the truncation boundary chars. Falls back to the TS implementation when
  // the native module is unavailable.
  const native = tryNativeSelectCompactionUserMessages(
    messages.map((message) => ({
      role: message.role,
      text: extractText(message.content),
      tokens: estimateMessage(message),
    })),
    maxTokens,
    headTokens,
  );
  if (native !== undefined) {
    return rebuildFromNativeSelection(native, messages, estimateMessage);
  }

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

function usesLegacyTailShape(input: ContextCompactionShapeInput): boolean {
  return input.legacyTail === true;
}

/**
 * Rebuild the head/tail message arrays from a native selection. Native
 * truncation reports the number of UTF-8 bytes retained at the truncated
 * boundary (head keeps its beginning, tail keeps its end), so the boundary
 * message is sliced to exactly that byte length.
 *
 * `omittedTokens` is recomputed with the TS estimator over the rebuilt
 * messages so it matches the TS fallback path exactly (the native count
 * uses the pre-truncation message tokens, which undercounts the truncation
 * loss).
 */
function rebuildFromNativeSelection<T extends MessageLike>(
  selection: NativeCompactionUserSelection,
  messages: readonly T[],
  estimateMessage: (message: T) => number,
): CompactionUserSelection<T> {
  const head: T[] = [];
  const { headIndices, tailIndices } = selection;
  for (let i = 0; i < headIndices.length; i++) {
    const index = headIndices[i]!;
    const message = messages[index]!;
    const truncated =
      selection.headTruncateChars !== null && i === headIndices.length - 1;
    head.push(
      truncated
        ? replaceMessageText(
            message,
            sliceByUtf8Bytes(extractText(message.content), selection.headTruncateChars!),
          )
        : message,
    );
  }

  const tail: T[] = [];
  for (let i = 0; i < tailIndices.length; i++) {
    const index = tailIndices[i]!;
    const message = messages[index]!;
    const truncated =
      selection.tailTruncateChars !== null && i === 0;
    tail.push(
      truncated
        ? replaceMessageText(
            message,
            sliceByUtf8BytesFromEnd(extractText(message.content), selection.tailTruncateChars!),
          )
        : message,
    );
  }

  let totalTokens = 0;
  for (const message of messages) totalTokens += estimateMessage(message);
  let keptTokens = 0;
  for (const message of head) keptTokens += estimateMessage(message);
  for (const message of tail) keptTokens += estimateMessage(message);

  return {
    head,
    tail,
    elided: selection.elided,
    omittedTokens: Math.max(0, totalTokens - keptTokens),
  };
}

/** Keep the first `byteLength` UTF-8 bytes of `text` (no partial code points). */
function sliceByUtf8Bytes(text: string, byteLength: number): string {
  if (byteLength <= 0) return '';
  const bytes = Buffer.from(text, 'utf8');
  if (byteLength >= bytes.length) return text;
  let cut = byteLength;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) {
    cut--;
  }
  return bytes.subarray(0, cut).toString('utf8');
}

/** Keep the last `byteLength` UTF-8 bytes of `text` (no partial code points). */
function sliceByUtf8BytesFromEnd(text: string, byteLength: number): string {
  if (byteLength <= 0) return '';
  const bytes = Buffer.from(text, 'utf8');
  if (byteLength >= bytes.length) return text;
  let start = bytes.length - byteLength;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
    start++;
  }
  return bytes.subarray(start).toString('utf8');
}

function extractText(content: readonly ContentPart[]): string {
  let text = '';
  for (const part of content) {
    if (part.type === 'text') {
      text += part.text;
    }
  }
  return text;
}

function truncateTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let asciiCount = 0;
  let nonAsciiCount = 0;
  let end = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
    if (Math.ceil(asciiCount / 4) + nonAsciiCount > maxTokens) break;
    end += char.length;
  }
  return text.slice(0, end);
}

function truncateTextToTokensFromEnd(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let asciiCount = 0;
  let nonAsciiCount = 0;
  let start = text.length;
  for (let i = text.length - 1; i >= 0; i--) {
    let isAscii = false;
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
      const high = text.charCodeAt(i - 1);
      if (high >= 0xd800 && high <= 0xdbff) {
        i--;
      }
    } else {
      isAscii = code <= 127;
    }
    if (isAscii) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
    if (Math.ceil(asciiCount / 4) + nonAsciiCount > maxTokens) break;
    start = i;
  }
  return text.slice(start);
}

function replaceMessageText<T extends MessageLike>(message: T, text: string): T {
  return {
    ...message,
    content: [{ type: 'text', text }],
    toolCalls: [],
  } as unknown as T;
}

function truncateUserMessage<T extends MessageLike>(message: T, maxTokens: number): T {
  return replaceMessageText(message, truncateTextToTokens(extractText(message.content), maxTokens));
}
