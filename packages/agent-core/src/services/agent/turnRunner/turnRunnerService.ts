import { randomUUID } from 'node:crypto';

import {
  createToolMessage,
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
  type ContentPart,
  type StreamedMessagePart,
  type ToolCall as KosongToolCall,
} from '@moonshot-ai/kosong';

import { registerSingleton, SyncDescriptor } from '../../../di';
import { IProfileService } from '../profile/profile';
import { IUsageService } from '../usage/usage';
import { OrderedHookSlot } from '../hooks';
import { IContextMemory } from '../contextMemory/contextMemory';
import { ILLMRequester } from '../llmRequester/llmRequester';
import { IToolExecutor } from '../toolExecutor/toolExecutor';
import type { ContextMessage, LLMEvent, ToolCall, Turn, TurnResult } from '../types';
import { ITurnRunner } from './turnRunner';

export class TurnRunnerService implements ITurnRunner {
  private activeTurn: Turn | undefined;

  readonly hooks = {
    onLaunched: new OrderedHookSlot<{ turn: Turn }>(),
    beforeStep: new OrderedHookSlot<{ turn: Turn }>(),
    afterStep: new OrderedHookSlot<{ turn: Turn }>(),
  };

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @ILLMRequester private readonly llmRequester: ILLMRequester,
    @IToolExecutor private readonly toolExecutor: IToolExecutor,
    @IUsageService private readonly usage: IUsageService,
    @IProfileService private readonly profile: IProfileService,
  ) {}

  launch(): Turn {
    if (this.activeTurn !== undefined) {
      throw new Error(`Cannot launch a new turn while turn ${this.activeTurn.id} is active`);
    }

    const abortController = new AbortController();
    const ready = createControlledPromise<void>();
    const turn: MutableTurn = {
      id: randomUUID(),
      abortController,
      ready: ready.promise,
      result: Promise.resolve({ reason: 'failed' }),
    };
    turn.result = this.runTurn(turn, ready).finally(() => {
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
    });
    this.activeTurn = turn;
    void this.hooks.onLaunched.run({ turn });
    return turn;
  }

  getActiveTurn(): Turn | undefined {
    return this.activeTurn;
  }

  private async runTurn(
    turn: Turn,
    ready: ControlledPromise<void>,
  ): Promise<TurnResult> {
    try {
      this.usage.beginTurn();
      await this.hooks.beforeStep.run({ turn });
      const collector = new LLMEventCollector();
      const stream = this.llmRequester.request(undefined, turn.abortController.signal);
      ready.resolve();

      for await (const event of stream) {
        turn.abortController.signal.throwIfAborted();
        if (event.type === 'usage') {
          this.usage.record(
            event.model ?? this.profile.data().modelAlias ?? 'unknown',
            event.usage,
            'turn',
          );
        }
        collector.accept(event);
      }

      const assistant = collector.toAssistantMessage();
      if (assistant.content.length > 0 || assistant.toolCalls.length > 0) {
        this.appendMessage(assistant);
      }
      for (const toolCall of assistant.toolCalls) {
        const result = await this.toolExecutor.execute(toToolCall(toolCall));
        const toolMessage = createToolMessage(toolCall.id, result.output);
        this.appendMessage({
          ...toolMessage,
          role: 'tool',
          isError: result.isError,
        });
      }

      await this.hooks.afterStep.run({ turn });
      return { reason: 'completed' };
    } catch (error) {
      if (turn.abortController.signal.aborted) {
        ready.resolve();
        return { reason: 'cancelled', error: turn.abortController.signal.reason };
      }
      ready.reject(error);
      return { reason: 'failed', error };
    } finally {
      this.usage.endTurn();
    }
  }

  private appendMessage(message: ContextMessage): void {
    this.context.spliceHistory(this.context.getHistory().length, 0, message);
  }
}

interface ControlledPromise<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

function createControlledPromise<T>(): ControlledPromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class LLMEventCollector {
  private readonly parts: StreamedMessagePart[] = [];

  accept(event: LLMEvent): void {
    if (event.type !== 'part') return;
    this.acceptPart(event.part);
  }

  toAssistantMessage(): ContextMessage {
    const content: ContentPart[] = [];
    const toolCalls: KosongToolCall[] = [];
    for (const part of this.parts) {
      if (isContentPart(part)) {
        content.push(part);
      } else if (isToolCall(part)) {
        toolCalls.push(stripStreamIndex(part));
      }
    }

    return {
      role: 'assistant',
      content,
      toolCalls,
    };
  }

  private acceptPart(part: StreamedMessagePart): void {
    const previous = this.parts.at(-1);
    if (previous !== undefined && mergeInPlace(previous, part)) {
      return;
    }
    if (isToolCallPart(part)) {
      return;
    }
    this.parts.push(clonePart(part));
  }
}

function clonePart(part: StreamedMessagePart): StreamedMessagePart {
  return { ...part } as StreamedMessagePart;
}

function stripStreamIndex(toolCall: KosongToolCall): KosongToolCall {
  const { _streamIndex, ...rest } = toolCall;
  void _streamIndex;
  return rest;
}

function toToolCall(toolCall: KosongToolCall): ToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: parseToolArguments(toolCall.arguments),
    raw: toolCall,
  };
}

function parseToolArguments(args: string | null): unknown {
  if (args === null || args.length === 0) return undefined;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

registerSingleton(ITurnRunner, new SyncDescriptor(TurnRunnerService, [], true));
