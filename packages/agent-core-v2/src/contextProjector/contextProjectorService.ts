import {
  IInstantiationService,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { ContextMessage } from '#/contextMemory/types';
import { ErrorCodes, KimiError } from '#/errors';
import { IAgentMicroCompactionService } from '#/microCompaction';
import type { ContentPart, Message, TextPart } from '@moonshot-ai/kosong';
import { IAgentContextProjectorService } from './contextProjector';

export class AgentContextProjectorService implements IAgentContextProjectorService {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {}

  project(messages: readonly ContextMessage[]): readonly Message[] {
    return project(this.microCompaction().compact(messages));
  }

  private microCompaction(): IAgentMicroCompactionService {
    return this.instantiation.invokeFunction((accessor) =>
      accessor.get(IAgentMicroCompactionService),
    );
  }
}


export function project(history: readonly ContextMessage[]): Message[] {
  return finalizeProjectedMessages(mergeAdjacentUserMessages(normalizeToolExchanges(history)));
}

const TOOL_INTERRUPTED_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_INTERRUPTED_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

interface ToolExchangeProjection {
  pendingToolCalls: Set<string>;
  results: ContextMessage[];
}

export function normalizeToolExchanges(history: readonly ContextMessage[]): ContextMessage[] {
  const exchangeByToolCallId = new Map<string, ToolExchangeProjection>();
  const exchangeByAssistant = new Map<ContextMessage, ToolExchangeProjection>();
  const matchedResults = new Set<ContextMessage>();

  for (const message of history) {
    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      const exchange: ToolExchangeProjection = {
        pendingToolCalls: new Set(message.toolCalls.map((toolCall) => toolCall.id)),
        results: [],
      };
      exchangeByAssistant.set(message, exchange);
      for (const toolCall of message.toolCalls) {
        exchangeByToolCallId.set(toolCall.id, exchange);
      }
      continue;
    }

    if (message.role !== 'tool' || message.toolCallId === undefined) continue;

    const exchange = exchangeByToolCallId.get(message.toolCallId);
    if (exchange === undefined) continue;
    if (!exchange.pendingToolCalls.delete(message.toolCallId)) continue;
    exchange.results.push(message);
    matchedResults.add(message);
  }

  const out: ContextMessage[] = [];
  let sawAssistant = false;
  for (const message of history) {
    if (message.role === 'tool') {
      // A result matched to its call is emitted right after that call (below).
      if (matchedResults.has(message)) continue;
      // A result whose call was never seen is an orphan and is dropped — but
      // only once we are in a real projection context (an assistant has
      // appeared). A leading tool result with no assistant is a bare slice
      // (micro-compaction sizes single messages this way) and is kept.
      if (sawAssistant) continue;
      out.push(message);
      continue;
    }

    out.push(message);
    if (message.role === 'assistant') sawAssistant = true;
    const exchange = exchangeByAssistant.get(message);
    if (exchange === undefined) continue;

    out.push(...exchange.results);
    for (const toolCallId of exchange.pendingToolCalls) {
      out.push(createInterruptedToolResult(toolCallId));
    }
  }

  return out;
}

function createInterruptedToolResult(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [
      { type: 'text', text: `${TOOL_INTERRUPTED_STATUS}\n${TOOL_INTERRUPTED_OUTPUT}` },
    ],
    toolCalls: [],
    toolCallId,
    isError: true,
  };
}

function mergeAdjacentUserMessages(history: readonly ContextMessage[]): ContextMessage[] {
  const out: ContextMessage[] = [];
  for (const message of history) {
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
  return out;
}

function finalizeProjectedMessages(history: readonly ContextMessage[]): Message[] {
  const out: Message[] = [];
  for (const message of history) {
    if (message.partial === true) continue;

    let content: ContentPart[] | undefined;
    for (const [index, part] of message.content.entries()) {
      if (part.type === 'text' && part.text.length === 0) {
        content ??= message.content.slice(0, index);
        continue;
      }
      content?.push(part);
    }

    const projectedContent = content ?? message.content;
    if (message.role === 'tool' && projectedContent.length === 0) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        'Tool result message content cannot be empty after removing empty text blocks.',
        {
          details: {
            toolCallId: message.toolCallId,
          },
        },
      );
    }
    if (projectedContent.length === 0 && message.toolCalls.length === 0) continue;

    out.push({
      role: message.role,
      name: message.name,
      content: projectedContent.map((p) => ({ ...p })) as ContentPart[],
      toolCalls: message.toolCalls.map((tc) => ({ ...tc })),
      toolCallId: message.toolCallId,
      partial: message.partial,
    });
  }
  return out;
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
      .filter((message) => !isInterruptedToolResult(message))
      .map((message) => message.toolCallId)
      .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string'),
  );
  const closed = assistant.toolCalls.every((toolCall) => trailingToolCallIds.has(toolCall.id));
  return closed ? [...history] : history.slice(0, lastNonToolIndex);
}

function isInterruptedToolResult(message: Message): boolean {
  const content = message.content[0];
  return (
    message.role === 'tool' &&
    message.content.length === 1 &&
    content?.type === 'text' &&
    content.text === `${TOOL_INTERRUPTED_STATUS}\n${TOOL_INTERRUPTED_OUTPUT}`
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextProjectorService,
  AgentContextProjectorService,
  InstantiationType.Delayed,
  'contextProjector',
);
