/**
 * `loop` test stubs — shared `IAgentLoopService` / `IWireService` stubs for
 * unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../loop/stubs`).
 */

import { toDisposable } from '#/_base/di/lifecycle';
import type {
  IAgentLoopService,
  LoopErrorHandler,
  LoopErrorHandlerRegistrationOptions,
  Turn,
} from '#/agent/loop/loop';
import type { StepRequest } from '#/agent/loop/stepRequest';
import { StepRequestQueue, type StepRequestBatch } from '#/agent/loop/stepRequestQueue';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ContentPart } from '#/app/llmProtocol/message';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { createHooks } from '#/hooks';
import type { Op } from '#/wire/op';
import type { IWireService } from '#/wire/wireService';

export interface StubLoopOptions {
  /** When set, `getActiveTurn()` returns the most recently started synthetic turn. */
  readonly hasActiveTurn?: boolean;
  /** Synthetic turn id counter start (defaults to `0`). */
  readonly currentId?: string | number;
}

/**
 * An `IAgentLoopService` stub backed by real hook slots, a real
 * `StepRequestQueue`, and a real error-handler registry. `enqueue` mirrors
 * production turn membership: a `nextTurn` request starts (and records) a
 * synthetic turn before entering the queue; a `tryInTurn` request just queues
 * and its receipt reports the current `getActiveTurn()`.
 */
export type StubLoop = IAgentLoopService & {
  /** The backing queue; tests may inspect or seed it directly. */
  readonly queue: StepRequestQueue;
  /** Ids of turns started by `enqueue(nextTurn)` / `startTurn`, in order. */
  readonly launches: readonly number[];
  readonly cancels: readonly {
    readonly turnId?: number;
    readonly reason?: unknown;
  }[];
  /** Create and record a synthetic active turn (the old `stubTurn().launch()`). */
  startTurn(): Turn;
  /**
   * Pop the next batch and materialize it into the given context, mirroring
   * `AgentLoopService.materializeBatch`. Returns undefined when the queue has
   * no runnable request. Stands in for a step boundary in stub-based tests.
   */
  drainNextBatch(context: { append(...messages: ContextMessage[]): void }): StepRequestBatch | undefined;
};

const turnControllers = new WeakMap<Turn, AbortController>();

/** A minimal synthetic `Turn` handle for stub-driven tests. */
export function makeTurn(id: number): Turn {
  const controller = new AbortController();
  const turn: Turn = {
    id,
    signal: controller.signal,
    ready: Promise.resolve(),
    result: Promise.resolve({ type: 'completed', steps: 0, truncated: false }),
  };
  turnControllers.set(turn, controller);
  return turn;
}

function makeAgentLoopHookSlots(): IAgentLoopService['hooks'] {
  return createHooks([
    'beforeStep',
    'afterStep',
  ]) as IAgentLoopService['hooks'];
}

/**
 * A real `registerLoopErrorHandler` registry for the loop stub, mirroring
 * `AgentLoopService`'s ordering (push by default, `before`/`after` relative
 * insertion, id-keyed replacement) so stub-based tests can register recovery
 * handlers exactly like production services do.
 */
function createLoopErrorHandlerRegistry(): {
  readonly handlers: LoopErrorHandler[];
  readonly register: IAgentLoopService['registerLoopErrorHandler'];
} {
  const handlers: LoopErrorHandler[] = [];
  const remove = (id: string): void => {
    const index = handlers.findIndex((entry) => entry.id === id);
    if (index >= 0) handlers.splice(index, 1);
  };
  const register = (
    handler: LoopErrorHandler,
    options: LoopErrorHandlerRegistrationOptions = {},
  ) => {
    if (options.before !== undefined && options.after !== undefined) {
      throw new Error('Loop error handler registration cannot specify both before and after');
    }
    remove(handler.id);
    const target = options.before ?? options.after;
    if (target === undefined) {
      handlers.push(handler);
    } else {
      const targetIndex = handlers.findIndex((entry) => entry.id === target);
      if (targetIndex < 0) {
        throw new Error(`Loop error handler target "${target}" is not registered`);
      }
      handlers.splice(options.before !== undefined ? targetIndex : targetIndex + 1, 0, handler);
    }
    return toDisposable(() => remove(handler.id));
  };
  return { handlers, register };
}

function materializeStubRequest(
  request: StepRequest,
  context: { append(...messages: ContextMessage[]): void },
): void {
  if (request.state !== 'pending') return;
  request.onWillMaterialize();
  const messages = request.resolveContextMessages();
  if (messages.length > 0) context.append(...messages);
  request.markMaterialized();
}

/** An `IAgentLoopService` stub backed by real hook slots and a real `StepRequestQueue`. */
export function stubLoopWithHooks(options: StubLoopOptions = {}): StubLoop {
  const hooks = makeAgentLoopHookSlots();
  const queue = new StepRequestQueue();
  const errorHandlers = createLoopErrorHandlerRegistry();
  const launches: number[] = [];
  const cancels: { turnId?: number; reason?: unknown }[] = [];
  let active: Turn | undefined;
  let nextId = typeof options.currentId === 'number' ? options.currentId : 0;

  const startTurn = (): Turn => {
    const turn = makeTurn(nextId++);
    launches.push(turn.id);
    active = turn;
    return turn;
  };

  const stub: StubLoop = {
    _serviceBrand: undefined,
    hooks,
    queue,
    launches,
    cancels,
    startTurn,
    enqueue(request, enqueueOptions) {
      if (request.priority === 'nextTurn') {
        const turn = startTurn();
        queue.enqueue(request, enqueueOptions?.at ?? 'tail');
        return { turn, abort: () => request.abort() };
      }
      queue.enqueue(request, enqueueOptions?.at ?? 'tail');
      return { turn: stub.getActiveTurn(), abort: () => request.abort() };
    },
    getActiveTurn() {
      return options.hasActiveTurn ? active : undefined;
    },
    cancel(turnId, reason) {
      cancels.push({ turnId, reason });
      const turn = this.getActiveTurn();
      if (turn === undefined) return false;
      if (turnId !== undefined && turn.id !== turnId) return false;
      turnControllers.get(turn)?.abort(reason);
      return true;
    },
    hasPendingRequests: () => queue.hasPendingRequests(),
    registerLoopErrorHandler: errorHandlers.register,
    drainNextBatch(context) {
      const batch = queue.takeNextBatch();
      if (batch === undefined) return undefined;
      materializeStubRequest(batch.driver, context);
      for (const request of batch.merged) {
        materializeStubRequest(request, context);
      }
      return batch;
    },
  };
  return stub;
}

export type StubWire = IWireService & {
  /** Every op handed to `dispatch`, in order. */
  readonly ops: readonly Op[];
  /** Payloads of dispatched `turn.steer` ops (the old `stubTurn().steered`). */
  readonly steered: readonly {
    readonly input: readonly ContentPart[];
    readonly origin?: PromptOrigin;
  }[];
};

/** An `IWireService` stub that records dispatched ops; every other member is an inert no-op. */
export function stubWire(): StubWire {
  const ops: Op[] = [];
  const steered: { input: readonly ContentPart[]; origin?: PromptOrigin }[] = [];
  return {
    _serviceBrand: undefined,
    ops,
    steered,
    dispatch: (...incoming: Op[]) => {
      for (const op of incoming) {
        ops.push(op);
        if (op.type === 'turn.steer') {
          steered.push(op.payload as { input: readonly ContentPart[]; origin?: PromptOrigin });
        }
      }
    },
    replay: async () => {},
    signal: () => {},
    flush: async () => {},
    attach: () => toDisposable(() => {}),
    getModel: () => ({}),
    subscribe: () => toDisposable(() => {}),
    onEmission: () => toDisposable(() => {}),
    onRestored: () => toDisposable(() => {}),
  } as unknown as StubWire;
}

/**
 * An `IAgentToolExecutorService` stub whose tool-execution hooks (`onWillExecuteTool` /
 * `onDidExecuteTool`) are real `OrderedHookSlot`s, so services that register
 * gate hooks in their constructor (AgentPermissionGate, AgentMcpService, …) can be built
 * in tests. `execute` yields an empty batch by default.
 */
export function stubToolExecutor(): IAgentToolExecutorService {
  return {
    _serviceBrand: undefined,
    execute: async function* () {},
    hooks: createHooks([
      'onWillExecuteTool',
      'onDidExecuteTool',
    ]) as IAgentToolExecutorService['hooks'],
    registerUnavailableToolDescriber: () => ({ dispose: () => {} }),
    registerMissingToolDescriber: () => ({ dispose: () => {} }),
  };
}
