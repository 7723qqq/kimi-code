import {
  Disposable,
} from "#/_base/di";
import { OrderedHookSlot } from '#/hooks';
import { IAgentRecordService, type AgentRecord } from '#/agent/record';
import type { WireRecordBlobSelector } from '#/agent/wireRecord';
import {
  IAgentContextMemoryService,
  type ContextOperation,
  type ContextOperationDefinition,
  type ContextReplayWriter,
  type ContextSplice,
  type ContextSplicedEvent,
} from './contextMemory';
import { ensureMessageId } from './messageId';
import type { ContextMessage } from './types';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

const CONTEXT_OPERATION_PREFIX = 'context.';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    [type: `${typeof CONTEXT_OPERATION_PREFIX}${string}`]: { readonly args: readonly unknown[] };
  }
}

export class AgentContextMemoryService extends Disposable implements IAgentContextMemoryService {
  declare readonly _serviceBrand: undefined;
  private readonly history: ContextMessage[] = [];
  private readonly operationTypes = new Set<string>();
  private applying = false;

  readonly hooks = {
    onSpliced: new OrderedHookSlot<ContextSplicedEvent>(),
  };

  constructor(
    @IAgentRecordService private readonly record: IAgentRecordService,
  ) {
    super();
    this._register(
      this.record.hooks.onRestoredRecord.register('context-operation-guard', async (ctx, next) => {
        const type = ctx.record.type;
        if (type.startsWith(CONTEXT_OPERATION_PREFIX) && !this.operationTypes.has(type)) {
          throw new Error(`No context operation registered for restored record "${type}"`);
        }
        await next();
      }),
    );
  }

  defineOperation<T extends readonly unknown[]>(
    definition: ContextOperationDefinition<T>,
  ): ContextOperation<T> {
    const recordType = `${CONTEXT_OPERATION_PREFIX}${definition.type}` as const;
    if (this.operationTypes.has(recordType)) {
      throw new Error(`Context operation "${recordType}" is already defined`);
    }
    this.operationTypes.add(recordType);
    const blobs = definition.blobs;
    this._register(
      this.record.define(recordType, {
        resume: (record) => {
          this.runOperation(definition, record.args as T);
        },
        blobs:
          blobs === undefined
            ? undefined
            : (adaptBlobSelector(blobs) as unknown as WireRecordBlobSelector<
                AgentRecord<typeof recordType>
              >),
      }),
    );
    return (...args: T): void => {
      if (this.applying) {
        throw new Error(
          `Context operation "${recordType}" invoked while another operation is applying`,
        );
      }
      this.record.append({ type: recordType, args });
      this.runOperation(definition, args);
    };
  }

  get(): readonly ContextMessage[] {
    return [...this.history];
  }

  private runOperation<T extends readonly unknown[]>(
    definition: ContextOperationDefinition<T>,
    args: T,
  ): void {
    this.applying = true;
    try {
      definition.apply(this.splice, ...args);
      definition.replay(this.replayWriter, ...args);
    } finally {
      this.applying = false;
    }
  }

  private readonly splice: ContextSplice = (start, deleteCount, insert, tokens) => {
    const boundedStart = normalizeSpliceStart(start, this.history.length);
    const boundedDeleteCount = clampDeleteCount(deleteCount, this.history.length - boundedStart);
    const messages = insert.map(ensureMessageId);
    this.history.splice(boundedStart, boundedDeleteCount, ...messages);
    void this.hooks.onSpliced.run({
      start: boundedStart,
      deleteCount: boundedDeleteCount,
      messages,
      tokens,
    });
  };

  private readonly replayWriter: ContextReplayWriter = {
    push: (record) => {
      this.record.push(record);
    },
    removeMessages: (messageIds) => {
      this.record.removeMessages(messageIds);
    },
    cut: () => {
      this.record.cut();
    },
  };
}

function normalizeSpliceStart(start: number, length: number): number {
  if (Number.isNaN(start)) return length;
  if (start < 0) return Math.max(0, length + Math.floor(start));
  return Math.min(Math.floor(start), length);
}

function clampDeleteCount(deleteCount: number, max: number): number {
  if (Number.isNaN(deleteCount) || deleteCount <= 0) return 0;
  return Math.min(Math.floor(deleteCount), Math.max(0, max));
}

function adaptBlobSelector<T extends readonly unknown[]>(
  blobs: NonNullable<ContextOperationDefinition<T>['blobs']>,
): WireRecordBlobSelector<{ args: T }> {
  return (record) =>
    Array.from(blobs(record.args), (target) => ({
      parts: target.parts,
      replace: (current: { args: T }, parts: NonNullable<typeof target.parts>) => ({
        ...current,
        args: target.replace(current.args, parts),
      }),
    }));
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextMemoryService,
  AgentContextMemoryService,
  InstantiationType.Delayed,
  'contextMemory',
);
