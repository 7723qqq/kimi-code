/**
 * `contextMemory` test stubs — shared doubles for `IAgentContextMemoryService` and its
 * collaborators (`IAgentWireRecordService`, `IAgentRecordService`).
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../contextMemory/stubs`).
 */

import { toDisposable } from '#/_base/di';
import type { ServiceRegistration } from '#/_base/di/test';
import { createHooks } from '#/hooks';
import type { Hooks } from '#/hooks';
import { ensureMessageId, IAgentContextMemoryService, type ContextMessage, type ContextOperation, type ContextOperationDefinition } from '#/agent/contextMemory';
import { IAgentRecordService } from '#/agent/record';
import { IAgentWireRecordService } from '#/agent/wireRecord';

/**
 * A no-op `IAgentWireRecordService`. `register` returns a disposable so services that
 * `_register(wireRecord.register(...))` in their constructor can be disposed
 * cleanly; `append` is a no-op (in-memory history is driven by `applySplice`).
 */
export function stubWireRecord(): IAgentWireRecordService {
  const hooks = createHooks(['onRestoredRecord', 'onResumeEnded']) as IAgentWireRecordService['hooks'];
  return {
    _serviceBrand: undefined,
    restoring: null,
    postRestoring: false,
    hooks,
    append: () => {},
    register: () => toDisposable(() => {}),
    restore: () => Promise.resolve({}),
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
    getRecords: () => [],
  };
}

/** A no-op `IAgentRecordService` — every mutator is a no-op and `buildReplay` is empty. */
export function stubRecord(): IAgentRecordService {
  const hooks = createHooks(['onRestoredRecord', 'onResumeEnded']) as IAgentRecordService['hooks'];
  return {
    _serviceBrand: undefined,
    restoring: null,
    postRestoring: false,
    captureLiveRecords: false,
    hooks,
    append: () => {},
    on: () => toDisposable(() => {}),
    signal: () => {},
    define: () => toDisposable(() => {}),
    push: () => {},
    patchLast: () => {},
    removeMessages: () => {},
    cut: () => {},
    buildReplay: () => [],
  };
}

export interface StubContextMemory extends IAgentContextMemoryService {
  /** The live backing history, exposed so tests can inspect splices. */
  readonly messages: readonly ContextMessage[];
  /** Direct splice helper for tests that pre-date the operation registry. */
  splice(
    start: number,
    deleteCount: number,
    inserted: readonly ContextMessage[],
    tokens?: number,
  ): void;
}

/**
 * An in-memory `IAgentContextMemoryService`. `spliceHistory` mutates the backing history
 * and fires `onSpliced`, mirroring `AgentContextMemoryService.applySplice` enough
 * for collaborators (e.g. `DynamicInjectorService`) to react to splices.
 */
export function stubContextMemory(): StubContextMemory {
  const messages: ContextMessage[] = [];
  const operationTypes = new Set<string>();
  const hooks = {
    onSpliced: createHooks(['onSpliced'])['onSpliced'],
  } as unknown as Hooks<{
    onSpliced: {
      start: number;
      deleteCount: number;
      messages: ContextMessage[];
      tokens?: number;
    };
  }>;

  const splice: (start: number, deleteCount: number, inserted: readonly ContextMessage[], tokens?: number) => void = (start, deleteCount, inserted, tokens) => {
    const boundedStart = normalizeSpliceStart(start, messages.length);
    const boundedDeleteCount = clampDeleteCount(deleteCount, messages.length - boundedStart);
    const stamped = inserted.map(ensureMessageId);
    messages.splice(boundedStart, boundedDeleteCount, ...stamped);
    void hooks.onSpliced.run({
      start: boundedStart,
      deleteCount: boundedDeleteCount,
      messages: [...stamped],
      tokens,
    });
  };

  return {
    _serviceBrand: undefined,
    hooks,
    get messages() {
      return messages;
    },
    get: () => [...messages],
    defineOperation: <T extends readonly unknown[]>(definition: ContextOperationDefinition<T>): ContextOperation<T> => {
      const recordType = `context.${definition.type}`;
      operationTypes.add(recordType);
      return (...args: T) => {
        definition.apply(splice, ...args);
      };
    },
    splice,
  };
}

/**
 * Register the default collaborators consumed by `AgentContextMemoryService`
 * (`IAgentWireRecordService`, `IAgentRecordService`) and an in-memory `IAgentContextMemoryService`.
 * Tests that exercise the real `AgentContextMemoryService` should override
 * `IAgentContextMemoryService` via `additionalServices`.
 */
export function registerContextMemoryServices(reg: ServiceRegistration): void {
  reg.defineInstance(IAgentWireRecordService, stubWireRecord());
  reg.defineInstance(IAgentRecordService, stubRecord());
  reg.defineInstance(IAgentContextMemoryService, stubContextMemory());
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
