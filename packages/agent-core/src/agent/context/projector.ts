import type { ContentPart, Message, TextPart } from '@moonshot-ai/kosong';

import { ErrorCodes, KimiError } from '../../errors';
import type { ContextMessage } from './types';

export function project(history: readonly ContextMessage[]): Message[] {
  return repairToolExchangeAdjacency(mergeAdjacentUserMessages(history));
}

// Strict providers (Anthropic) require every assistant `tool_use` to be answered
// by a matching `tool_result` in the immediately following message(s). A
// misordered history — where a `tool_result` is not adjacent to its `tool_use`,
// e.g. because a user message (background-task notification, flushed steer)
// landed in between, or because an interrupted / nested step delayed the result
// — is rejected with HTTP 400 ("`tool_use` without `tool_result` immediately
// after"). Micro compaction only exposed this latent misordering by busting the
// prompt cache and forcing a full revalidation.
//
// Repair the adjacency so every assistant `tool_use` is immediately followed by
// its matching `tool_result` message(s). Matching results are moved up from
// wherever they appear later in the history; any intervening messages keep their
// relative order and simply follow the repaired exchange. A tool call with no
// recorded result anywhere later in the history is left untouched — it is still
// in-flight (pending) rather than orphaned, and the trailing-open-exchange trim
// plus the interrupted-result synthesis during replay own those cases. This is
// purely a projection-time fix: the underlying history is left untouched, so
// replay and transcripts keep their original order, while the model always sees
// a well-formed tool exchange.
function repairToolExchangeAdjacency(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  const consumed = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (consumed.has(i)) continue;
    const message = messages[i]!;
    if (message.role !== 'assistant' || message.toolCalls.length === 0) {
      out.push(message);
      continue;
    }

    out.push(message);
    const pending = new Set(message.toolCalls.map((toolCall) => toolCall.id));
    for (let j = i + 1; j < messages.length && pending.size > 0; j++) {
      if (consumed.has(j)) continue;
      const next = messages[j]!;
      const toolCallId = next.toolCallId;
      if (next.role === 'tool' && toolCallId !== undefined && pending.has(toolCallId)) {
        out.push(next);
        consumed.add(j);
        pending.delete(toolCallId);
      }
    }
    // If a tool call has no recorded result anywhere later in the history, it is
    // still in-flight (pending) rather than orphaned, so leave it untouched — the
    // trailing-open-exchange trim and the interrupted-result synthesis during
    // replay own those cases, and synthesizing here would wrongly close a call
    // that is simply still running.
  }
  return out;
}

function mergeAdjacentUserMessages(history: readonly ContextMessage[]): Message[] {
  const out: ContextMessage[] = [];
  for (const source of history) {
    const message = prepareMessageForProjection(source);
    if (message === null) continue;

    const previous = out.at(-1);
    if (
      canMergeUserMessage(message) &&
      previous !== undefined &&
      canMergeUserMessage(previous)
    ) {
      out[out.length - 1] = mergeTwoUserMessages(previous, message);
      continue;
    }
    out.push(message);
  }
  return out.map(stripContextMetadata);
}

function prepareMessageForProjection(message: ContextMessage): ContextMessage | null {
  if (message.partial === true) return null;

  let content: ContentPart[] | undefined;
  for (const [index, part] of message.content.entries()) {
    if (part.type === 'text' && part.text.length === 0) {
      content ??= message.content.slice(0, index);
      continue;
    }
    content?.push(part);
  }

  const next = content === undefined ? message : { ...message, content };
  if (next.role === 'tool' && next.content.length === 0) {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      'Tool result message content cannot be empty after removing empty text blocks.',
      {
        details: {
          toolCallId: next.toolCallId,
        },
      },
    );
  }
  return next.content.length === 0 && next.toolCalls.length === 0 ? null : next;
}

function canMergeUserMessage(message: ContextMessage): boolean {
  return message.role === 'user' && message.origin?.kind === 'user';
}

function mergeTwoUserMessages(a: ContextMessage, b: ContextMessage): ContextMessage {
  const aText = extractTextOnly(a);
  const bText = extractTextOnly(b);
  const nonTextParts = [
    ...a.content.filter((p) => p.type !== 'text'),
    ...b.content.filter((p) => p.type !== 'text'),
  ];
  const mergedText: TextPart = { type: 'text', text: `${aText}\n\n${bText}` };
  const content: ContentPart[] = [mergedText, ...nonTextParts];
  return {
    role: 'user',
    content,
    toolCalls: [],
    origin: a.origin,
  };
}

function extractTextOnly(message: Message): string {
  return message.content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function stripContextMetadata(message: ContextMessage): Message {
  return {
    role: message.role,
    name: message.name,
    content: message.content.map((p) => ({ ...p })) as ContentPart[],
    toolCalls: message.toolCalls.map((tc) => ({ ...tc })),
    toolCallId: message.toolCallId,
    partial: message.partial,
  };
}

export function trimTrailingOpenToolExchange(history: readonly Message[]): Message[] {
  let lastNonToolIndex = history.length - 1;
  while (lastNonToolIndex >= 0 && history[lastNonToolIndex]?.role === 'tool') {
    lastNonToolIndex -= 1;
  }

  const assistant = history[lastNonToolIndex];
  if (assistant === undefined) return [];
  if (assistant.role !== 'assistant' || assistant.toolCalls.length === 0) return [...history];

  const trailingToolCallIds = new Set(
    history
      .slice(lastNonToolIndex + 1)
      .map((message) => message.toolCallId)
      .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string'),
  );
  const closed = assistant.toolCalls.every((toolCall) => trailingToolCallIds.has(toolCall.id));
  return closed ? [...history] : history.slice(0, lastNonToolIndex);
}
