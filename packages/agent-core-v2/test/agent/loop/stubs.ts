import type { UserMessage } from '#human/llm/message';
import { toDisposable } from '#/_base/di/lifecycle';
import { Event } from '#/_base/event';
import type {
  IAgentLoopService,
  LoopErrorHandler,
  LoopErrorHandlerRegistrationOptions,
  LoopCancelTarget,
  LoopNotify,
  LoopNotifyHandle,
  LoopSubmitOptions,
  LoopSubmitResult,
  PromptHandle,
  Turn,
  TurnResult,
} from '#/agent/loop/loop';
import type { UserEntry } from '#human/agent/turn';
import { loopUserAttributes, loopUserEntry, type LoopUserEntry } from '#/agent/loop/userEntry';

export function submitPromptTurn(
  loop: IAgentLoopService,
  input: UserEntry | UserMessage,
  options?: LoopSubmitOptions,
): { readonly turn: Turn } {
  const entry = 'message' in input ? loopUserEntry(input as unknown as LoopUserEntry) : input;
  const { id } = loop.submit(entry, options);
  const handle = loop.promptHandle(id);
  if (handle === undefined) throw new Error(`missing prompt handle for ${id}`);
  let backing: Turn | undefined;
  let settledCancelled = false;
  void handle.launched.then((turn) => {
    backing = turn;
  });
  void handle.completion.then((completion) => {
    settledCancelled = completion.state === 'cancelled';
  });
  const controller = new AbortController();
  const result: Promise<TurnResult> = handle.launched.then(
    (turn) =>
      turn?.result ??
      handle.completion.then((completion) => {
        if (completion.result !== undefined) return completion.result;
        if (completion.state === 'cancelled') {
          return { type: 'cancelled', steps: 0, reason: undefined } as TurnResult;
        }
        return new Promise<TurnResult>(() => {});
      }),
  );
  return {
    turn: {
      get id() {
        return backing?.id;
      },
      get state() {
        return backing?.state ?? (settledCancelled ? 'cancelled' : 'queued');
      },
      signal: controller.signal,
      ready: handle.launched.then(async (turn) => {
        await turn?.ready;
      }),
      started: handle.launched.then(async (turn) => {
        await turn?.started;
      }),
      result,
      cancel: (reason) => loop.cancel({ promptId: id }, reason),
    },
  };
}
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  WillExecuteToolEvent,
} from '#/agent/toolExecutor/toolHooks';
import { OrderedHookSlot } from '#/hooks';
import { createHooks } from '#/hooks';
import type { IWireService } from '#/wire/wire';

import { stubAgentWire } from '../../wire/stubs';

export interface StubLoopOptions {
  readonly hasActiveTurn?: boolean;
  readonly currentId?: string | number;
  readonly pendingTurnResult?: boolean;
  readonly manualTurnResult?: boolean;
}
export type StubTurn = Turn & { readonly id: number };
export type StubLoop = IAgentLoopService & {
  readonly launches: readonly number[];
  readonly cancels: readonly { readonly turnId?: number; readonly reason?: unknown }[];
  readonly queue: { hasPendingRequests(): boolean };
  startTurn(): StubTurn;
  settleActive(result?: TurnResult): void;
  drainNextBatch(context: {
    append(...messages: ContextMessage[]): void;
  }): { readonly driver: { readonly kind: string } } | undefined;
};
const turnControllers = new WeakMap<Turn, AbortController>();
export function makeTurn(id: number): StubTurn {
  const controller = new AbortController();
  const turn: StubTurn = {
    id,
    signal: controller.signal,
    ready: Promise.resolve(),
    started: Promise.resolve(),
    result: Promise.resolve({ type: 'completed', steps: 0, truncated: false }),
    cancel: (reason) => {
      controller.abort(reason);
      return true;
    },
  };
  turnControllers.set(turn, controller);
  return turn;
}
interface PendingEntry {
  readonly kind: string;
  readonly message?: ContextMessage;
  readonly onConsume?: () => void;
}
function registry(): {
  handlers: LoopErrorHandler[];
  register: IAgentLoopService['registerLoopErrorHandler'];
} {
  const handlers: LoopErrorHandler[] = [];
  const remove = (id: string) => {
    const i = handlers.findIndex((h) => h.id === id);
    if (i >= 0) handlers.splice(i, 1);
  };
  const register = (
    handler: LoopErrorHandler,
    options: LoopErrorHandlerRegistrationOptions = {},
  ) => {
    remove(handler.id);
    const target = options.before ?? options.after;
    if (target === undefined) handlers.push(handler);
    else {
      const i = handlers.findIndex((h) => h.id === target);
      if (i < 0) throw new Error(`Loop error handler target "${target}" is not registered`);
      handlers.splice(options.before !== undefined ? i : i + 1, 0, handler);
    }
    return toDisposable(() => remove(handler.id));
  };
  return { handlers, register };
}
export function stubLoopWithHooks(options: StubLoopOptions = {}): StubLoop {
  const hooks = createHooks([
    'onWillBeginStep',
    'onDidFinishStep',
    'onBeforeSubmitPrompt',
  ]) as IAgentLoopService['hooks'];
  const errorHandlers = registry();
  const launches: number[] = [];
  const cancels: { turnId?: number; reason?: unknown }[] = [];
  const pending: PendingEntry[] = [];
  const handles = new Map<string, PromptHandle>();
  let active: Turn | undefined;
  let nextId = typeof options.currentId === 'number' ? options.currentId : 0;
  let releaseActiveResult: ((result: TurnResult) => void) | undefined;
  const startTurn = () => {
    const turn = makeTurn(nextId++);
    const result =
      options.manualTurnResult === true
        ? new Promise<TurnResult>((resolve) => {
            releaseActiveResult = resolve;
          })
        : options.pendingTurnResult === true
          ? new Promise<never>(() => {})
          : turn.result;
    const configured = { ...turn, result };
    launches.push(configured.id);
    active = configured;
    return configured;
  };
  const hasPending = () => pending.length > 0;
  const stub = {
    _serviceBrand: undefined,
    requester: {} as never,
    async start() {},
    started: false,
    hasPersistedState: false,
    baselineTools: () => [],
    update() {},
    history: () => [],
    historyRevision: () => 0,
    replaceHistory: () => false,
    async initializeHistory() {},
    async close() {},
    async retry() {
      return undefined;
    },
    abortTool() {},
    detachTool() {},
    suppressTaskNotifications() {},
    addActiveTool() {},
    removeActiveTool() {},
    remind() {},
    flushReminders() {},
    registerToolBatchStarting() {
      return { dispose() {} };
    },
    async notifyClient() {
      return { prompt_id: 'p', created_at: new Date().toISOString(), state: 'queued' };
    },
    hooks,
    launches,
    cancels,
    startTurn,
    queue: { hasPendingRequests: hasPending },
    settleActive(result: TurnResult = { type: 'completed', steps: 0, truncated: false }) {
      releaseActiveResult?.(result);
    },
    submit: ((input: UserMessage, options?: LoopSubmitOptions) => {
      const turn = startTurn();
      const attributes = loopUserAttributes(input);
      const id = attributes.promptId ?? 'p';
      const message: ContextMessage = {
        ...input,
        toolCalls: [],
        id: attributes.promptId,
        origin: attributes.origin as PromptOrigin | undefined,
      } as unknown as ContextMessage;
      pending.push({ kind: 'prompt', message, onConsume: options?.onMaterialize });
      handles.set(id, {
        id,
        userMessageId: id,
        createdAt: '',
        state: 'running',
        message,
        launched: Promise.resolve(turn),
        completion: new Promise(() => {}),
      });
      return { id };
    }) as IAgentLoopService['submit'],
    steer: async () => {},
    notify: ((note: LoopNotify | UserMessage = {}): LoopSubmitResult | LoopNotifyHandle => {
      if ('role' in note) {
        const turn = startTurn();
        const attributes = loopUserAttributes(note);
        const id = attributes.promptId ?? 'p';
        const message: ContextMessage = {
          ...note,
          toolCalls: [],
          id: attributes.promptId,
          origin: attributes.origin as PromptOrigin | undefined,
        } as unknown as ContextMessage;
        pending.push({ kind: 'message', message });
        handles.set(id, {
          id,
          userMessageId: id,
          createdAt: '',
          state: 'running',
          message,
          launched: Promise.resolve(turn),
          completion: new Promise(() => {}),
        });
        return { id };
      }
      const entry: PendingEntry = {
        kind:
          note.bypassMaxSteps === true
            ? 'handoff'
            : note.message !== undefined
              ? 'message'
              : 'continuation',
        message: note.message,
        onConsume: note.onConsume,
      };
      pending.push(entry);
      let dropped = false;
      return {
        get dropped() {
          return dropped;
        },
        drop: () => {
          if (dropped) return;
          dropped = true;
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          note.onDrop?.();
        },
      };
    }) as IAgentLoopService['notify'],
    snapshot() {
      return {
        state: active !== undefined ? 'running' : 'idle',
        activeTurnId: active?.id,
        activePromptId: undefined,
        queue: [],
        notificationCount: 0,
        paused: false,
        hasPendingRequests: hasPending(),
        turn: undefined,
        activeRequestId: undefined,
      };
    },
    promptHandle: (id: string) => handles.get(id),
    cancel(target: LoopCancelTarget | undefined, reason: unknown) {
      cancels.push({ turnId: target?.turnId, reason });
      if (target?.promptId !== undefined) return true;
      if (active === undefined || (target?.turnId !== undefined && active.id !== target.turnId))
        return false;
      active.cancel(reason);
      return true;
    },
    tryAcquireQuiescence: () => toDisposable(() => {}),
    tryAcquireHistorySnapshot: () => toDisposable(() => {}),
    resetLoop: async () => {},
    registerLoopErrorHandler: errorHandlers.register,
    settled: () => Promise.resolve(undefined),
    drainNextBatch(context: { append(...messages: ContextMessage[]): void }) {
      const batch = pending.splice(0);
      if (batch.length === 0) return undefined;
      for (const entry of batch) {
        entry.onConsume?.();
        if (entry.message !== undefined && entry.message.content.length > 0)
          context.append(entry.message);
      }
      return { driver: { kind: batch[0]!.kind } };
    },
  } as unknown as StubLoop;
  return stub;
}
export async function runWillBeginStepHooks(
  loop: IAgentLoopService,
  firstStepOfTurn = false,
): Promise<void> {
  await loop.hooks.onWillBeginStep.run({
    turnId: 0,
    step: 0,
    firstStepOfTurn,
    signal: new AbortController().signal,
  });
}
export function stubWire(): IWireService {
  return stubAgentWire();
}
export function stubToolExecutor(): IAgentToolExecutorService {
  return {
    _serviceBrand: undefined,
    execute: async function* () {},
    onBeforeExecuteTool: Event.None as Event<BeforeToolExecuteEvent>,
    onWillExecuteTool: Event.None as Event<WillExecuteToolEvent>,
    executor: { execute: async () => ({ content: [], isError: false } as never) } as never,
    registerHook: () => ({ dispose() {} }),
    registerLegacyStarting: () => ({ dispose() {} }),
    handlers: () => [],
    handler: () => undefined,
    handlerForCall: () => undefined,
    release: () => {},
    hooks: {
      onExecuteTool: new OrderedHookSlot<ResolvedToolExecutionHookContext>(),
      onDidExecuteTool: new OrderedHookSlot<ToolDidExecuteContext>(),
    },
    recordDupType: () => {},
    registerToolCallGuard: () => ({ dispose() {} }),
    registerUnavailableToolDescriber: () => ({ dispose() {} }),
    registerMissingToolDescriber: () => ({ dispose() {} }),
  };
}
