import {
  IInstantiationService,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { ErrorCodes, KimiError } from '#/errors';
import { IAgentMicroCompactionService } from '#/agent/microCompaction';
import type { ContentPart, Message, TextPart, ToolCall } from '#/app/llmProtocol';
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

// Projects the stored context history into the wire messages sent to the
// model, in two passes over the history:
//
// Pass 1 resolves which recorded result answers each assistant tool call. A
// call stays open until its first result; a call id reused by a later
// assistant re-opens for the results that follow. Partial messages (stream
// interrupted) are invisible here, so their calls never anchor an exchange.
//
// Pass 2 emits the projection. Strict providers require every tool call to be
// answered right after the assistant message, so each call's result is emitted
// beside it (a synthetic interrupted result when none was recorded), and tool
// messages are skipped where they originally sat — a result is either
// re-emitted beside its call or it is an orphan, wire-invalid and useless to
// the model. A history with no assistant at all is a bare sizing slice
// (micro-compaction sizes single messages this way) and passes through as-is.
// Emitting cleans each message (drops empty / whitespace-only text blocks,
// rejected by strict providers), merges adjacent user prompts, and strips
// context-only metadata off the wire.
function project(history: readonly ContextMessage[]): Message[] {
  const openCalls = new Map<string, ToolCall>();
  const answers = new Map<ToolCall, ContextMessage>();
  let hasAssistant = false;
  for (const message of history) {
    if (message.partial === true) continue;
    if (message.role === 'assistant') {
      hasAssistant = true;
      for (const call of message.toolCalls) openCalls.set(call.id, call);
    } else if (message.role === 'tool' && message.toolCallId !== undefined) {
      const call = openCalls.get(message.toolCallId);
      if (call === undefined) continue;
      answers.set(call, message);
      openCalls.delete(message.toolCallId);
    }
  }

  const out: Message[] = [];
  let mergeSource: ContextMessage | undefined;

  const emit = (source: ContextMessage): void => {
    const content = source.content.some(isBlankText)
      ? source.content.filter((part) => !isBlankText(part))
      : source.content;
    if (source.role === 'tool' && content.length === 0) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        'Tool result message content cannot be empty after removing empty text blocks.',
        { details: { toolCallId: source.toolCallId } },
      );
    }
    if (content.length === 0 && source.toolCalls.length === 0) return;

    const message = content === source.content ? source : { ...source, content };
    if (mergeSource !== undefined && canMergeUserMessage(message)) {
      mergeSource = mergeTwoUserMessages(mergeSource, message);
      out[out.length - 1] = stripContextMetadata(mergeSource);
      return;
    }
    mergeSource = canMergeUserMessage(message) ? message : undefined;
    out.push(stripContextMetadata(message));
  };

  for (const message of history) {
    if (message.partial === true) continue;
    if (message.role === 'tool') {
      if (!hasAssistant) emit(message);
      continue;
    }
    emit(message);
    for (const call of message.toolCalls) {
      emit(answers.get(call) ?? createInterruptedToolResult(call.id));
    }
  }
  return out;
}

const TOOL_INTERRUPTED_TEXT =
  '<system>ERROR: Tool execution failed.</system>\n' +
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

function createInterruptedToolResult(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: TOOL_INTERRUPTED_TEXT }],
    toolCalls: [],
    toolCallId,
    isError: true,
  };
}

function isBlankText(part: ContentPart): boolean {
  return part.type === 'text' && part.text.trim().length === 0;
}

function canMergeUserMessage(message: ContextMessage): boolean {
  return message.role === 'user' && message.origin?.kind === 'user';
}

function mergeTwoUserMessages(a: ContextMessage, b: ContextMessage): ContextMessage {
  // Join only the non-empty sides so merging an image-only message never
  // produces a whitespace-only text block (rejected by strict providers).
  const text = [a, b].map(extractText).filter((t) => t.length > 0).join('\n\n');
  const content: ContentPart[] = text === '' ? [] : [{ type: 'text', text }];
  content.push(
    ...a.content.filter((part) => part.type !== 'text'),
    ...b.content.filter((part) => part.type !== 'text'),
  );
  return { role: 'user', content, toolCalls: [], origin: a.origin };
}

function extractText(message: ContextMessage): string {
  return message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function stripContextMetadata(message: ContextMessage): Message {
  return {
    role: message.role,
    name: message.name,
    content: message.content.map((part) => ({ ...part })) as ContentPart[],
    toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })),
    toolCallId: message.toolCallId,
    partial: message.partial,
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextProjectorService,
  AgentContextProjectorService,
  InstantiationType.Delayed,
  'contextProjector',
);
