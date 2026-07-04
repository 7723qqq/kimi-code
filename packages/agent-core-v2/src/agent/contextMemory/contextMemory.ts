import { createDecorator } from "#/_base/di";
import type { ContentPart } from '#/app/llmProtocol';

import type { Hooks } from '#/hooks';
import type { AgentReplayRecordPayload } from '#/agent/replayBuilder/types';
import type { ContextMessage } from './types';

export interface ContextSplicedEvent {
  start: number;
  deleteCount: number;
  messages: ContextMessage[];
  tokens?: number;
}

export type ContextSplice = (
  start: number,
  deleteCount: number,
  insert: readonly ContextMessage[],
  tokens?: number,
) => void;

export interface ContextReplayWriter {
  push(record: AgentReplayRecordPayload): void;
  removeMessages(messageIds: ReadonlySet<string>): void;
  cut(): void;
}

export interface ContextOperationBlobTarget<T extends readonly unknown[]> {
  readonly parts: readonly ContentPart[];
  replace(args: T, parts: readonly ContentPart[]): T;
}

export interface ContextOperationDefinition<T extends readonly unknown[]> {
  readonly type: string;
  readonly apply: (splice: ContextSplice, ...args: T) => void;
  readonly replay: (replay: ContextReplayWriter, ...args: T) => void;
  readonly blobs?: (args: T) => Iterable<ContextOperationBlobTarget<T>>;
}

export type ContextOperation<T extends readonly unknown[]> = (...args: T) => void;

export interface IAgentContextMemoryService {
  readonly _serviceBrand: undefined;

  defineOperation<T extends readonly unknown[]>(
    definition: ContextOperationDefinition<T>,
  ): ContextOperation<T>;

  get(): readonly ContextMessage[];

  readonly hooks: Hooks<{
    onSpliced: ContextSplicedEvent;
  }>;
}

export const IAgentContextMemoryService = createDecorator<IAgentContextMemoryService>('agentContextMemoryService');
