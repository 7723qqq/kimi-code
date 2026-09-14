/**
 * Local copies of the `@moonshot-ai/agent-core-v2` context-memory helpers that
 * `context-projector.ts` replays wires with: the loop-event fold, the
 * compaction-shape builder, and the undo walk.
 *
 * The v2 engine was removed from the repo (P157-P162), but vis replays session
 * files (wire.jsonl) that the engine wrote. Those files are versioned by the
 * wire protocol, so a local copy stays in sync by definition — same rationale
 * as ./v1-compat.ts and ./v2-wire.ts.
 *
 * Only the subset used by vis is included.
 */

import type { ContentPart, Message, ToolCall } from '@moonshot-ai/kosong';
import { createToolMessage } from '@moonshot-ai/kosong/message';

import type { ContextMessage, LoopRecordedEvent, PromptOrigin } from './v1-compat';
import { renderToolResultForModel } from './v1-compat';

export { renderToolResultForModel };

// ════════════════════════════════════════════════════════════════════════════
// Token estimation (llm-adapter/contract/tokens.ts)
// ════════════════════════════════════════════════════════════════════════════

const messageTokenEstimateCache = new WeakMap<Message, number>();

export function estimateTokens(text: string): number {
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }
  return Math.ceil(asciiCount / 4) + nonAsciiCount;
}

export function estimateTokensForMessages(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokensForMessage(message);
  }
  return total;
}

export function estimateTokensForMessage(message: Message): number {
  const cached = messageTokenEstimateCache.get(message);
  if (cached !== undefined) {
    return cached;
  }

  let total = estimateTokens(message.role);
  total += estimateTokensForContentParts(message.content);
  if (message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      total += estimateTokens(call.name);
      total += estimateTokens(JSON.stringify(call.arguments));
    }
  }
  messageTokenEstimateCache.set(message, total);
  return total;
}

export function estimateTokensForContentParts(parts: readonly ContentPart[]): number {
  let total = 0;
  for (const part of parts) {
    total += estimateTokensForContentPart(part);
  }
  return total;
}

export const MEDIA_TOKEN_ESTIMATE = 2000;

export function estimateTokensForContentPart(part: ContentPart): number {
  switch (part.type) {
    case 'text':
      return estimateTokens(part.text);
    case 'think':
      return estimateTokens(part.think);
    case 'image_url':
    case 'audio_url':
    case 'video_url':
      return MEDIA_TOKEN_ESTIMATE;
    default: {
      const exhaustive: never = part;
      void exhaustive;
      return 0;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// System reminders (features/reminder/systemReminder.ts)
// ════════════════════════════════════════════════════════════════════════════

const SYSTEM_REMINDER_PREFIX = '<system-reminder>\n';
const SYSTEM_REMINDER_SUFFIX = '\n</system-reminder>';

export function wrapSystemReminder(content: string): string {
  return `${SYSTEM_REMINDER_PREFIX}${content.trim()}${SYSTEM_REMINDER_SUFFIX}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Vacuous content (agent/contextMemory/vacuousContent.ts)
// ════════════════════════════════════════════════════════════════════════════

export function isVacuousContentPart(part: ContentPart): boolean {
  switch (part.type) {
    case 'text':
      return part.text.trim().length === 0;
    case 'think':
      return part.encrypted === undefined && part.think.trim().length === 0;
    case 'image_url':
    case 'audio_url':
    case 'video_url':
      return false;
    default: {
      const exhaustive: never = part;
      void exhaustive;
      return false;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Compaction handoff (agent/contextMemory/compactionHandoff.ts)
// ════════════════════════════════════════════════════════════════════════════

export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
export const COMPACT_USER_MESSAGE_HEAD_TOKENS = 2_000;
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
  const keptMessages =
    elisionMessage === undefined
      ? [...selection.head, ...selection.tail]
      : [...selection.head, elisionMessage, ...selection.tail];
  const contextSummary = input.contextSummary ?? input.summary;
  const continuationMessage = createCompactionContinuationMessage();
  const tokensAfter =
    input.tokensAfter ??
    (input.requestOverheadTokens ?? 0) +
      (input.summaryOutputTokens ?? estimate.text(contextSummary)) +
      estimate.messages([...keptMessages, continuationMessage]);
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
    messages: [
      ...keptMessages,
      createCompactionSummaryMessage(contextSummary),
      continuationMessage,
    ],
  };
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

export function createCompactionContinuationMessage(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: buildCompactionContinuationText() }],
    toolCalls: [],
    origin: { kind: 'injection', variant: COMPACTION_CONTINUATION_VARIANT },
  };
}

export function buildCompactionContinuationText(): string {
  return wrapSystemReminder(
    'Context compaction is complete — continue the work that was in progress when it began.',
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
    case 'background_task':
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

// ════════════════════════════════════════════════════════════════════════════
// Loop-event fold (agent/contextMemory/loopEventFold.ts)
// ════════════════════════════════════════════════════════════════════════════

const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

export interface LoopEventFoldSink {
  openAssistant(time: number | undefined): void;
  appendOpenContent(part: ContentPart): void;
  appendOpenToolCall(call: ToolCall): void;
  dropOpenAssistant(): void;
  sealOpenAssistant(): void;
  pushToolMessage(message: ContextMessage, time: number | undefined): void;
  pushMessage(message: ContextMessage, time: number | undefined): void;
}

export interface LoopEventFold {
  appendMessage(message: ContextMessage, time?: number): void;
  loopEvent(event: LoopRecordedEvent, time?: number): void;
  settle(time?: number): void;
  reset(): void;
}

export function createLoopEventFold(sink: LoopEventFoldSink): LoopEventFold {
  let openStepUuid: string | null | undefined;
  let openHasToolCalls = false;
  let openVacuous = true;
  const pending = new Set<string>();
  let deferred: { message: ContextMessage; time: number | undefined }[] = [];

  const flushDeferred = (): void => {
    if (pending.size > 0 || deferred.length === 0) return;
    for (const entry of deferred) sink.pushMessage(entry.message, entry.time);
    deferred = [];
  };
  const closePending = (time: number | undefined): void => {
    if (pending.size === 0) return;
    for (const toolCallId of pending) {
      sink.pushToolMessage(interruptedToolMessage(toolCallId), time);
    }
    pending.clear();
    flushDeferred();
  };
  const settleOpen = (time: number | undefined): void => {
    if (openStepUuid === undefined) return;
    closePending(time);
    if (!openHasToolCalls && openVacuous) {
      sink.dropOpenAssistant();
    } else {
      sink.sealOpenAssistant();
    }
    openStepUuid = undefined;
  };
  const acceptsOpenStep = (stepUuid: string): boolean => {
    if (openStepUuid === undefined) return false;
    if (openStepUuid === null) {
      openStepUuid = stepUuid;
      return true;
    }
    return stepUuid === openStepUuid;
  };

  return {
    appendMessage(message, time) {
      if (pending.size > 0) {
        deferred.push({ message, time });
        return;
      }
      sink.pushMessage(message, time);
    },
    loopEvent(event, time) {
      switch (event.type) {
        case 'step.begin': {
          settleOpen(time);
          sink.openAssistant(time);
          openStepUuid = event.uuid;
          openHasToolCalls = false;
          openVacuous = true;
          return;
        }
        case 'step.end': {
          if (event.finishReason === 'interrupted' || event.finishReason === 'error') return;
          settleOpen(time);
          flushDeferred();
          return;
        }
        case 'content.part': {
          if (!acceptsOpenStep(event.stepUuid)) return;
          sink.appendOpenContent(event.part);
          openVacuous = openVacuous && isVacuousContentPart(event.part);
          return;
        }
        case 'tool.call': {
          if (!acceptsOpenStep(event.stepUuid)) return;
          const call: ToolCall = {
            type: 'function',
            id: event.toolCallId,
            name: event.name,
            arguments: event.args === undefined ? null : JSON.stringify(event.args),
            ...(event.extras !== undefined ? { extras: event.extras } : {}),
          };
          sink.appendOpenToolCall(call);
          pending.add(event.toolCallId);
          openHasToolCalls = true;
          return;
        }
        case 'tool.result': {
          if (!pending.has(event.toolCallId)) return;
          pending.delete(event.toolCallId);
          const output = event.result.output;
          sink.pushToolMessage(
            {
              ...createToolMessage(
                event.toolCallId,
                typeof output === 'string' ? output : [...output],
              ),
              isError: event.result.isError,
              note: event.result.note,
            },
            time,
          );
          flushDeferred();
          return;
        }
      }
    },
    settle(time) {
      settleOpen(time);
      flushDeferred();
    },
    reset() {
      openStepUuid = undefined;
      openHasToolCalls = false;
      openVacuous = true;
      pending.clear();
      deferred = [];
    },
  };
}

function interruptedToolMessage(toolCallId: string): ContextMessage {
  return {
    ...createToolMessage(toolCallId, TOOL_INTERRUPTED_ON_RESUME_OUTPUT),
    isError: true,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Context ops (agent/contextMemory/contextOps.ts)
// ════════════════════════════════════════════════════════════════════════════

interface UnknownRecord {
  readonly [key: string]: unknown;
}

/** A `context.apply_compaction` payload of any protocol variant. Typed loosely
 *  because the projector feeds it straight from an untrusted wire record. */
export type ContextCompactionRecord = object;

export function readContextCompactionShapeInput(
  record: ContextCompactionRecord,
): ContextCompactionShapeInput {
  const fields = record as UnknownRecord;
  const keptUserMessageCount = readOptionalNumber(fields, 'keptUserMessageCount');
  return {
    summary: readContextCompactionRawSummary(fields),
    legacySummaryMessage: readLegacySummaryMessage(fields),
    contextSummary: readOptionalString(fields, 'contextSummary'),
    compactedCount: readContextCompactedCount(fields),
    tokensBefore: readOptionalNumber(fields, 'tokensBefore') ?? 0,
    tokensAfter: readOptionalNumber(fields, 'tokensAfter'),
    summaryOutputTokens: readOptionalNumber(fields, 'summaryOutputTokens'),
    keptUserMessageCount,
    keptHeadUserMessageCount: readOptionalNumber(fields, 'keptHeadUserMessageCount'),
    droppedCount: readOptionalNumber(fields, 'droppedCount'),
    legacyTail: readOptionalBoolean(fields, 'legacyTail') ?? keptUserMessageCount === undefined,
  };
}

export function readContextCompactedCount(record: ContextCompactionRecord): number {
  const fields = record as UnknownRecord;
  const compactedCount = fields['compactedCount'];
  if (typeof compactedCount === 'number') return compactedCount;
  const legacyCount = fields['count'];
  if (typeof legacyCount === 'number') return legacyCount;
  throw new Error('Invalid context.apply_compaction record: missing compactedCount');
}

function readContextCompactionRawSummary(record: UnknownRecord): string {
  const summary = record['summary'];
  if (typeof summary === 'string') return summary;
  const contextSummary = record['contextSummary'];
  if (typeof contextSummary === 'string') return contextSummary;
  if (isContextMessage(summary)) {
    return textOf(summary);
  }
  throw new Error('Invalid context.apply_compaction record: missing summary');
}

function readLegacySummaryMessage(record: UnknownRecord): ContextMessage | undefined {
  const summary = record['summary'];
  return isContextMessage(summary) ? summary : undefined;
}

function readOptionalNumber(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function readOptionalString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readOptionalBoolean(record: UnknownRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function textOf(message: ContextMessage): string {
  let text = '';
  for (const part of message.content) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

function isContextMessage(value: unknown): value is ContextMessage {
  if (value === null || typeof value !== 'object') return false;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.role === 'string' && Array.isArray(message.content);
}

export interface UndoCut {
  readonly cutIndex: number;
  readonly removedCount: number;
  readonly stoppedAtCompaction: boolean;
}

export function computeUndoCut(state: readonly ContextMessage[], count: number): UndoCut {
  let remaining = count;
  let cutIndex = -1;
  let removedCount = 0;
  let stoppedAtCompaction = false;
  for (let i = state.length - 1; i >= 0 && remaining > 0; i--) {
    const message = state[i];
    if (message === undefined || message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') {
      stoppedAtCompaction = true;
      break;
    }
    if (isUndoAnchor(message)) {
      remaining--;
      removedCount++;
      cutIndex = i;
      while (cutIndex > 0 && isPromptOwnedInjection(state[cutIndex - 1]!, message)) {
        cutIndex--;
      }
    }
  }
  return { cutIndex, removedCount, stoppedAtCompaction };
}

export function isFullyUndoable(cut: UndoCut, count: number): boolean {
  return cut.cutIndex >= 0 && cut.removedCount >= count;
}

// ════════════════════════════════════════════════════════════════════════════
// Conversation time (agent/contextMemory/conversationTime.ts)
// ════════════════════════════════════════════════════════════════════════════

export function isUndoAnchorOrigin(origin: ContextMessage['origin']): boolean {
  if (origin === undefined || origin.kind === 'user') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

export function isUndoAnchor(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  return isUndoAnchorOrigin(message.origin);
}

export function isPromptOwnedInjection(message: ContextMessage, prompt: ContextMessage): boolean {
  const origin = message.origin;
  return (
    origin?.kind === 'injection' &&
    origin.ownerPromptId !== undefined &&
    origin.ownerPromptId === prompt.id
  );
}

export function isValidUndoCount(count: number): boolean {
  return Number.isSafeInteger(count) && count > 0;
}
