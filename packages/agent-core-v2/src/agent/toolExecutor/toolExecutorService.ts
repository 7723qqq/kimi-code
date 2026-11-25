import { Service } from '#/_base/di/service';
import { toDisposable } from '#/_base/di/lifecycle';
import { AsyncEmitter } from '#/_base/event';
import { OrderedHookSlot } from '#/hooks';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { defineState } from '#/state/state';
export { abortedToolOutput } from '#/_base/utils/abort';
import { isAbortError } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import type { ToolCallEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService, type ToolRegistryChange } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { IAgentTaskOutputService } from '#/agent/task/taskOutput';
import { ToolAccesses, type ExecutableTool, type ToolSource } from '#/tool/toolContract';
import type { ToolCall, ContentPart } from '@moonshot-ai/core/llm/message';
import type { ToolResult as CoreToolResult, ToolReturn } from '@moonshot-ai/core/tool/types';
import type { ToolResult } from '#/tool/toolContract';
import { compileToolArgsValidator, validateToolArgs, type JsonType } from '#/tool/args-validator';
import { parseToolCallArguments } from '#/tool/tool-args-parse';
import { BeforeToolExecuteEmitter } from './beforeToolExecuteEvent';
import {
  legacyDidExecuteContext,
  legacyExecutionContext,
  legacyRejectedResult,
  legacyStartingDecision,
  type LegacyDecisionContext,
} from './legacyHooks';
import type {
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  WillExecuteToolEvent,
} from './toolHooks';
import {
  composeToolExecutorHooks,
  LegacyExecutableToolAdapter,
  legacyToolDurationMs,
  memoryOutputStore,
  ToolExecutor,
  type ToolExecutionEvent,
} from '#/tool/executor';

import {
  IAgentToolExecutorService,
  type AgentToolExecutionHandler,
  type AgentToolExecutor,
  type AgentToolHook,
  type MissingToolDescriber,
  type ToolCallDupType,
  type ToolCallGuard,
  type ToolExecutionResult,
  type ToolExecutorExecuteOptions,
  type UnavailableToolDescriber,
} from './toolExecutor';
import { ToolCallStarted, ToolProgress, ToolUpdated, ToolResultEvent } from './toolExecutorEvents';
import { ToolScheduler } from './toolScheduler';

export const toolExecutorToolCallDupTypesKey = defineState<Map<string, ToolCallDupType>>(
  'toolExecutor.toolCallDupTypes',
  () => new Map(),
);
export const toolExecutorDupTypeTurnIdKey = defineState<number | undefined>(
  'toolExecutor.dupTypeTurnId',
  () => undefined as number | undefined,
);

interface AdapterEntry {
  readonly tool: ExecutableTool;
  readonly adapter: LegacyExecutableToolAdapter;
}

interface SchedulerBatch {
  readonly scheduler: ToolScheduler<void>;
  handlers: number;
}

export class AgentToolExecutorService extends Service implements IAgentToolExecutorService {
  declare readonly _serviceBrand: undefined;
  readonly executor: AgentToolExecutor;

  private readonly toolHooks: AgentToolHook[] = [];
  readonly hooks = {
    onExecuteTool: new OrderedHookSlot<ResolvedToolExecutionHookContext>(),
    onDidExecuteTool: new OrderedHookSlot<ToolDidExecuteContext>(),
  };
  private readonly legacyStarting = new BeforeToolExecuteEmitter();
  private readonly beforeExecuteEmitter = new BeforeToolExecuteEmitter();
  readonly onBeforeExecuteTool = this.beforeExecuteEmitter.event;
  private readonly willExecuteEmitter = new AsyncEmitter<WillExecuteToolEvent>();
  readonly onWillExecuteTool = this.willExecuteEmitter.event;
  private readonly toolCallGuards = new Set<ToolCallGuard>();
  private unavailableToolDescriber: UnavailableToolDescriber | undefined;
  private missingToolDescriber: MissingToolDescriber | undefined;
  private readonly adapters = new Map<string, AdapterEntry>();
  private readonly batches = new Map<string, SchedulerBatch>();
  private readonly batchByTask = new Map<string, string>();
  private readonly leases = new Map<string, () => void>();
  private readonly liveHandlers = new Map<string, AgentToolExecutionHandler>();
  private readonly taskIdsByCall = new Map<string, string[]>();
  private readonly announced = new WeakSet<object>();
  private readonly completed = new WeakSet<object>();
  private readonly progressByHandler = new WeakMap<object, string>();
  private readonly statusByHandler = new WeakMap<object, string>();
  private readonly executedPrepared = new WeakSet<object>();

  constructor(
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IAgentToolResultTruncationService private readonly truncation: IAgentToolResultTruncationService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentTaskOutputService private readonly taskOutputs: IAgentTaskOutputService | undefined,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(toolExecutorToolCallDupTypesKey);
    this.states.contributeState(toolExecutorDupTypeTurnIdKey);
    const resetHook: AgentToolHook = {
      starting: (context) => {
        if (context.context.turnId !== this.dupTypeTurnId) {
          this.dupTypeTurnId = context.context.turnId;
          this.toolCallDupTypes.clear();
        }
      },
    };
    const legacyHook: AgentToolHook = {
      starting: async (context) => {
        const decision = await this.legacyStarting.fireBeforeExecute(legacyExecutionContext(context));
        return legacyStartingDecision(context, decision);
      },
    };
    const forkHook: AgentToolHook = {
      starting: async (context) => {
        if (context.prepared.kind !== 'execute') return;
        const hookContext = legacyExecutionContext(context);
        const decision = await this.beforeExecuteEmitter.fireBeforeExecute(hookContext);
        const starting = legacyStartingDecision(context, decision);
        if (starting !== undefined) return starting;
        const source: ToolSource =
          this.registry.list().find((info) => info.name === context.call.name)?.source ?? 'builtin';
        for (const guard of this.toolCallGuards) {
          const reason = guard({ name: context.call.name, source });
          if (reason !== undefined) return { reject: reason };
        }
        return undefined;
      },
      beforeExecute: async (context) => {
        if (context.prepared.kind !== 'execute') return;
        const hookContext = legacyExecutionContext(context);
        await this.willExecuteEmitter.fireAsync(
          hookContext as unknown as WillExecuteToolEvent,
          context.signal,
        );
      },
      afterExecute: async (context) => {
        const executed = this.executedPrepared.has(context.prepared);
        const hookContext = executed
          ? { ...legacyDidExecuteContext(context), outcome: 'executed' as const }
          : legacyDidExecuteContext(context);
        try {
          await this.hooks.onDidExecuteTool.run(hookContext);
        } catch (error) {
          const text = `onDidExecuteTool hook failed for "${context.call.name}": ${toErrorMessage(error)}`;
          if (context.prepared?.kind === 'execute' || context.prepared?.kind === 'synthetic') {
            context.prepared.result = { output: text, isError: true };
          }
          return legacyRejectedResult(context, text);
        }
        if (context.prepared?.kind === 'execute') context.prepared.result = hookContext.result;
        return coreResultFromLegacy(
          hookContext.result,
          context.call.id,
          hookContext.stopTurn === true,
          hookContext.stopTurnReason,
        );
      },
    };
    const internalHook: AgentToolHook = {
      beforeExecute: async (context) => {
        if (context.prepared.kind !== 'execute') return;
        const { batch } = this.batch(context.context.turnId, context.context.step, context.taskId);
        const release = await batch.scheduler.lease(
          context.prepared.accesses ?? ToolAccesses.all(),
          context.signal,
        );
        this.leases.set(context.taskId, release);
        context.prepared.onExecuted = () => {
          this.leases.get(context.taskId)?.();
          this.leases.delete(context.taskId);
        };
      },
      observe: (event) => this.observe(event),
    };
    const hooks = this.toolHooks;
    this.executor = new ToolExecutor([], {
      outputStore: this.taskOutputs ?? memoryOutputStore(),
      preflight: (call) => this.preflightMessage(call),
      wrapExecute: (context, next) => this.wrapExecute(context as never, next),
      get hook() {
        return composeToolExecutorHooks([resetHook, legacyHook, forkHook, ...hooks, internalHook]);
      },
    });
    for (const reference of registry.listReferences()) {
      const tool = registry.resolve(reference.name);
      if (tool !== undefined) this.registerTool(tool);
    }
    this._register(this.legacyStarting);
    this._register(registry.onDidChange((change) => this.registryChanged(change)));
  }

  private get toolCallDupTypes(): Map<string, ToolCallDupType> {
    return this.states.get(toolExecutorToolCallDupTypesKey);
  }

  private preflightMessage(call: ToolCall): string | undefined {
    const toolName = call.name;
    const tool = this.registry.resolve(toolName);
    if (tool === undefined) {
      return this.missingToolDescriber?.(toolName) ?? `Tool "${toolName}" not found`;
    }
    const source = this.registry.list().find((info) => info.name === toolName)?.source ?? 'builtin';
    for (const guard of this.toolCallGuards) {
      const denied = guard({ name: toolName, source });
      if (denied !== undefined) return denied;
    }
    const unavailable = this.unavailableToolDescriber?.(toolName);
    if (unavailable !== undefined) return unavailable;
    const validation = validateExecutableToolArgs(tool, parseToolCallArguments(call.arguments).data);
    if (validation !== null) return `Invalid args for tool "${toolName}": ${validation}`;
    return undefined;
  }

  private get dupTypeTurnId(): number | undefined {
    return this.states.get(toolExecutorDupTypeTurnIdKey);
  }

  private set dupTypeTurnId(value: number | undefined) {
    this.states.set(toolExecutorDupTypeTurnIdKey, value);
  }

  registerHook(hook: AgentToolHook) {
    this.toolHooks.push(hook);
    return toDisposable(() => {
      const index = this.toolHooks.indexOf(hook);
      if (index >= 0) this.toolHooks.splice(index, 1);
    });
  }

  registerLegacyStarting(listener: Parameters<BeforeToolExecuteEmitter['event']>[0]) {
    return this.legacyStarting.event(listener);
  }

  registerToolCallGuard(guard: ToolCallGuard) {
    this.toolCallGuards.add(guard);
    return toDisposable(() => {
      this.toolCallGuards.delete(guard);
    });
  }

  registerUnavailableToolDescriber(describer: UnavailableToolDescriber) {
    this.unavailableToolDescriber = describer;
    return toDisposable(() => {
      if (this.unavailableToolDescriber === describer) this.unavailableToolDescriber = undefined;
    });
  }

  registerMissingToolDescriber(describer: MissingToolDescriber) {
    this.missingToolDescriber = describer;
    return toDisposable(() => {
      if (this.missingToolDescriber === describer) this.missingToolDescriber = undefined;
    });
  }

  async *execute(
    calls: ToolCall[],
    options: ToolExecutorExecuteOptions,
  ): AsyncIterable<ToolExecutionResult> {
    const started: StartedToolCall[] = [];
    let stopped = false;
    for (const call of calls) {
      if (stopped) {
        yield skippedToolResult(call);
        continue;
      }
      const startedAt = Date.now();
      const handler = this.executor.execute(call, {
        agent: this.scopeContext.agentContext,
        signal: options.signal,
        turnId: options.turnId,
        trace: options.trace,
        onToolCall: options.onToolCall,
      } as never);
      const entry: StartedToolCall = { call, handler, startedAt };
      started.push(entry);
      this.watchAbort(entry, options.signal);
      const prepared = await this.awaitPrepared(handler);
      const stopBatch = prepared?.kind === 'execute'
        ? prepared.execution.stopBatchAfterThis === true
        : prepared?.result?.stopTurn === true;
      if (stopBatch) {
        stopped = true;
      }
    }
    const pending = new Set(started);
    while (pending.size > 0) {
      const settled = await Promise.race(
        [...pending].map((entry): Promise<SettledToolCall> =>
          Promise.resolve(entry.handler.then(
            (response): SettledToolCall => ({
              entry,
              response: response as unknown as CoreToolResult,
            }),
            (error: unknown): SettledToolCall => ({ entry, error }),
          )),
        ),
      );
      pending.delete(settled.entry);
      if ('error' in settled) {
        yield failedToolResult(settled.entry, settled.error);
        continue;
      }
      yield this.executionResult(settled.entry, settled.response);
    }
  }

  private async awaitPrepared(
    handler: StartedToolCall['handler'],
  ): Promise<ReturnType<typeof handler.snapshot>['prepared']> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const snapshot = handler.snapshot();
      if (snapshot.prepared !== undefined || snapshot.status !== 'running') return snapshot.prepared;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return handler.snapshot().prepared;
  }

  private watchAbort(entry: StartedToolCall, signal: AbortSignal): void {
    const stop = (): void => {
      void entry.handler.stop(signal.reason);
    };
    if (signal.aborted) {
      stop();
      return;
    }
    const listener = (): void => stop();
    signal.addEventListener('abort', listener, { once: true });
    void entry.handler.then(
      () => signal.removeEventListener('abort', listener),
      () => signal.removeEventListener('abort', listener),
    );
  }

  private executionResult(entry: StartedToolCall, response: CoreToolResult): ToolExecutionResult {
    const prepared = entry.handler.snapshot().prepared;
    const legacy = prepared?.kind === 'execute' || prepared?.kind === 'synthetic'
      ? prepared.result
      : undefined;
    const content = response.content ?? [];
    const output = typeof legacy?.output === 'string'
      ? legacy.output
      : Array.isArray(legacy?.output)
        ? legacy.output
        : content.every((part) => part.type === 'text')
          ? content.map((part) => (part.type === 'text' ? part.text : '')).join('')
          : content;
    const stopTurnReason = response.stopTurnReason ?? legacy?.stopTurnReason;
    const stopTurn = response.stopTurn === true || legacy?.stopTurn === true;
    return {
      toolCallId: entry.call.id,
      toolName: entry.call.name,
      result: {
        ...legacy,
        output,
        isError: response.outcome.type === 'success' ? legacy?.isError : true,
        stopTurn,
        stopTurnReason,
        stopBatchAfterThis:
          (prepared?.kind === 'execute'
            ? prepared.execution.stopBatchAfterThis
            : legacy?.stopBatchAfterThis) ?? (stopTurn ? true : undefined),
      } as ToolResult,
      durationMs: Date.now() - entry.startedAt,
    };
  }

  private async wrapExecute(
    context: LegacyDecisionContext,
    next: () => Promise<ToolReturn>,
  ): Promise<ToolReturn> {
    const hookContext = legacyExecutionContext(context);
    let returned: ToolReturn | undefined;
    let terminalError: unknown;
    try {
      await this.hooks.onExecuteTool.run(hookContext, async () => {
        this.executedPrepared.add(context.prepared);
        try {
          returned = await next();
        } catch (error) {
          terminalError = error;
          throw error;
        }
      });
    } catch (error) {
      if (terminalError !== undefined) {
        throw terminalError instanceof Error ? terminalError : new Error(toErrorMessage(terminalError));
      }
      const aborted = isAbortError(error) || context.signal.aborted;
      const text = aborted
        ? `Tool "${hookContext.toolCall.name}" aborted during onExecuteTool hook.`
        : `onExecuteTool hook failed for "${hookContext.toolCall.name}": ${toErrorMessage(error)}`;
      return { content: [{ type: 'text', text }], outcome: 'failed', reason: text };
    }
    return returned ?? {
      content: [{
        type: 'text',
        text: `Tool "${hookContext.toolCall.name}" returned no result.`,
      }],
      outcome: 'failed',
      reason: `Tool "${hookContext.toolCall.name}" returned no result.`,
    };
  }

  handlers(): readonly AgentToolExecutionHandler[] {
    return [...this.liveHandlers.values()];
  }

  handler(taskId: string): AgentToolExecutionHandler | undefined {
    return this.liveHandlers.get(taskId);
  }

  handlerForCall(toolCallId: string): AgentToolExecutionHandler | undefined {
    const ids = this.taskIdsByCall.get(toolCallId);
    const taskId = ids?.at(-1);
    return taskId === undefined ? undefined : this.liveHandlers.get(taskId);
  }

  release(taskId: string): void {
    const handler = this.liveHandlers.get(taskId);
    if (handler === undefined) return;
    this.liveHandlers.delete(taskId);
    const callId = handler.snapshot().id;
    const ids = this.taskIdsByCall.get(callId);
    if (ids !== undefined) {
      const remaining = ids.filter((id) => id !== taskId);
      if (remaining.length === 0) this.taskIdsByCall.delete(callId);
      else this.taskIdsByCall.set(callId, remaining);
    }
    this.leases.get(taskId)?.();
    this.leases.delete(taskId);
    const key = this.batchByTask.get(taskId);
    this.batchByTask.delete(taskId);
    if (key === undefined) return;
    const batch = this.batches.get(key);
    if (batch === undefined) return;
    batch.handlers -= 1;
    if (batch.handlers === 0) this.batches.delete(key);
  }

  private batch(turnId: number, step: number | undefined, taskId: string): { readonly key: string; readonly batch: SchedulerBatch } {
    const key = `${turnId}:${step ?? taskId}`;
    let batch = this.batches.get(key);
    if (batch === undefined) {
      batch = { scheduler: new ToolScheduler<void>(), handlers: 0 };
      this.batches.set(key, batch);
    }
    return { key, batch };
  }

  recordDupType(toolCallId: string, dupType: ToolCallDupType): void {
    this.toolCallDupTypes.set(toolCallId, dupType);
  }

  private registerTool(tool: ExecutableTool): void {
    const adapter = new LegacyExecutableToolAdapter(
      tool,
      (input) => this.truncation.truncateForModel(input),
    );
    this.adapters.set(tool.name, { tool, adapter });
    this.executor.addExecute(adapter);
  }

  private registryChanged(change: ToolRegistryChange): void {
    const current = this.adapters.get(change.tool.name);
    if (change.type === 'unregistered') {
      if (current === undefined || current.tool !== change.tool) return;
      this.executor.removeExecute(current.adapter);
      this.adapters.delete(change.tool.name);
      return;
    }
    this.registerTool(change.tool);
  }

  private observe(event: ToolExecutionEvent<any, any, any>): void {
    const { handler } = event;
    if (event.type === 'created') {
      this.liveHandlers.set(handler.taskId, handler);
      const ids = this.taskIdsByCall.get(event.call.id) ?? [];
      ids.push(handler.taskId);
      this.taskIdsByCall.set(event.call.id, ids);
      const { key, batch } = this.batch(event.context.turnId, event.context.step, handler.taskId);
      batch.handlers += 1;
      this.batchByTask.set(handler.taskId, key);
      void handler.wait().catch(() => this.release(handler.taskId));
      return;
    }
    this.announce(event);
    if (!this.announced.has(handler)) return;
    const snapshot = handler.snapshot();
    if (event.type === 'change' && snapshot.detached) {
      this.leases.get(handler.taskId)?.();
      this.leases.delete(handler.taskId);
    }
    void this.dispatcher.dispatch(new ToolUpdated({
      agentId: this.scopeContext.agentId,
      origin: event.context.origin,
      turnId: event.context.turnId,
      toolCallId: event.call.id,
      taskId: handler.taskId,
      status: snapshot.status,
      detached: snapshot.detached,
      fields: snapshot.fields,
      output: event.type === 'output' ? { offset: event.offset, text: event.text } : undefined,
    }));
    if (event.type === 'change') {
      const progress = snapshot.fields['progress'] as
        | { readonly text?: string; readonly percent?: number; readonly replace?: boolean }
        | undefined;
      if (progress !== undefined) {
        const signature = JSON.stringify(progress);
        if (this.progressByHandler.get(handler) !== signature) {
          this.progressByHandler.set(handler, signature);
          void this.dispatcher.dispatch(new ToolProgress({
            agentId: this.scopeContext.agentId,
            turnId: event.context.turnId,
            toolCallId: event.call.id,
            update: {
              kind: 'progress',
              text: progress.text,
              percent: progress.percent,
              replace: progress.replace,
            },
          }));
        }
      }
      const rawStatus = snapshot.fields['status'] as
        | string
        | { readonly text?: string; readonly statusReplace?: boolean }
        | undefined;
      const statusText = typeof rawStatus === 'string' ? rawStatus : rawStatus?.text;
      const statusReplace =
        typeof rawStatus === 'string'
          ? (snapshot.fields['statusReplace'] as boolean | undefined)
          : rawStatus?.statusReplace;
      if (statusText !== undefined) {
        const signature = `${statusText}\u0000${String(statusReplace)}`;
        if (this.statusByHandler.get(handler) !== signature) {
          this.statusByHandler.set(handler, signature);
          void this.dispatcher.dispatch(new ToolProgress({
            agentId: this.scopeContext.agentId,
            turnId: event.context.turnId,
            toolCallId: event.call.id,
            update: {
              kind: 'status',
              text: statusText,
              replace: statusReplace,
            },
          }));
        }
      }
    }
    if (event.type === 'output') {
      void this.dispatcher.dispatch(new ToolProgress({
        agentId: this.scopeContext.agentId,
        turnId: event.context.turnId,
        toolCallId: event.call.id,
        update: { kind: 'stdout', text: event.text },
      }));
      return;
    }
    const status = snapshot.status;
    if (status !== 'success' && status !== 'failed' && status !== 'aborted') return;
    if (this.completed.has(handler)) return;
    this.completed.add(handler);
    this.leases.get(handler.taskId)?.();
    this.leases.delete(handler.taskId);
    const result = this.resultOf(event);
    const outcome = snapshot.error?.outcome ?? 'success';
    void this.dispatcher.dispatch(new ToolResultEvent({
      agentId: this.scopeContext.agentId,
      origin: event.context.origin,
      turnId: event.context.turnId,
      toolCallId: event.call.id,
      output: textToolOutput(result?.output ?? this.finalContent(event)),
      isError: outcome === 'success' ? undefined : true,
      synthetic: snapshot.prepared?.kind === 'synthetic' ? true : undefined,
    }));
    this.track(event, outcome);
  }

  private announce(event: ToolExecutionEvent<any, any, any>): void {
    if (this.announced.has(event.handler)) return;
    const snapshot = event.handler.snapshot();
    const ready = snapshot.phase === 'execute' ||
      snapshot.status === 'failed' ||
      snapshot.status === 'aborted' ||
      snapshot.status === 'success';
    if (!ready) return;
    this.announced.add(event.handler);
    const prepared = snapshot.prepared;
    void this.dispatcher.dispatch(new ToolCallStarted({
      agentId: this.scopeContext.agentId,
      origin: event.context.origin,
      turnId: event.context.turnId,
      toolCallId: event.call.id,
      name: event.call.name,
      args: snapshot.args,
      description: prepared?.kind === 'execute' ? prepared.description : undefined,
      display: prepared?.kind === 'execute' ? prepared.display : undefined,
    }));
  }

  private resultOf(event: ToolExecutionEvent<any, any, any>) {
    const prepared = event.handler.snapshot().prepared;
    if (prepared?.kind === 'execute') return prepared.result;
    return prepared?.kind === 'synthetic' ? prepared.result : undefined;
  }

  private finalContent(event: ToolExecutionEvent<any, any, any>) {
    const snapshot = event.handler.snapshot();
    return snapshot.error === undefined ? [] : [{ type: 'text' as const, text: snapshot.error.reason }];
  }

  private track(event: ToolExecutionEvent<any, any, any>, outcome: 'success' | 'failed' | 'aborted'): void {
    const snapshot = event.handler.snapshot();
    const properties: ToolCallEvent = {
      turn_id: event.context.turnId,
      tool_call_id: event.call.id,
      tool_name: event.call.name,
      outcome: outcome === 'success' ? 'success' : 'error',
      duration_ms: legacyToolDurationMs(snapshot),
      dup_type: this.toolCallDupTypes.get(event.call.id) ?? 'normal',
      trace_id: event.context.trace?.requestId,
      request_id: event.context.trace?.requestId,
    };
    this.toolCallDupTypes.delete(event.call.id);
    if (outcome !== 'success') properties['error_type'] = 'error';
    this.telemetry.track2('tool_call', properties);
  }
}

function textToolOutput(output: unknown): unknown {
  if (!Array.isArray(output)) return output;
  const parts = output as readonly { readonly type?: string; readonly text?: string }[];
  return parts.every((part) => part.type === 'text')
    ? parts.map((part) => part.text ?? '').join('')
    : output;
}

interface StartedToolCall {
  readonly call: ToolCall;
  readonly handler: ReturnType<AgentToolExecutor['execute']>;
  readonly startedAt: number;
}

type SettledToolCall =
  | { readonly entry: StartedToolCall; readonly response: CoreToolResult }
  | { readonly entry: StartedToolCall; readonly error: unknown };

const toolArgsValidators = new WeakMap<
  object,
  { readonly schema: Record<string, unknown>; readonly validator: ReturnType<typeof compileToolArgsValidator> }
>();

function skippedToolResult(call: ToolCall): ToolExecutionResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    result: {
      output: 'Tool skipped because a previous tool call stopped the turn.',
      isError: true,
      stopTurn: false,
    },
    durationMs: 0,
  };
}

function failedToolResult(entry: StartedToolCall, error: unknown): ToolExecutionResult {
  return {
    toolCallId: entry.call.id,
    toolName: entry.call.name,
    result: { output: toErrorMessage(error), isError: true, stopTurn: false },
    durationMs: Date.now() - entry.startedAt,
  };
}

function validateExecutableToolArgs(tool: ExecutableTool, args: unknown): string | null {
  const schema = tool.parameters;
  let cached = toolArgsValidators.get(tool);
  if (cached === undefined || cached.schema !== schema) {
    try {
      cached = { schema, validator: compileToolArgsValidator(schema) };
      toolArgsValidators.set(tool, cached);
    } catch (error) {
      return toErrorMessage(error);
    }
  }
  const properties = schema['properties'];
  const validParameterNames =
    typeof properties === 'object' && properties !== null && !Array.isArray(properties)
      ? Object.keys(properties)
      : [];
  return validateToolArgs(cached.validator, args as JsonType, validParameterNames);
}

function coreResultFromLegacy(
  result: ToolResult,
  toolCallId: string,
  stopTurn: boolean,
  stopTurnReason: string | undefined,
): CoreToolResult {
  const output = result.output;
  const content: ContentPart[] = typeof output === 'string'
    ? [{ type: 'text', text: output }]
    : [...output];
  const text = typeof output === 'string'
    ? output
    : output
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
  const outcome: CoreToolResult['outcome'] = result.isError === true
    ? {
        type: 'failed',
        error: {
          outcome: 'failed',
          type: 'unknown',
          phase: 'after-execute',
          reason: text,
        },
      }
    : { type: 'success' };
  const finalStopTurn = stopTurn || result.stopTurn === true;
  const finalStopReason = stopTurnReason ?? result.stopTurnReason;
  return {
    toolCallId,
    content,
    outcome,
    stopTurn: finalStopTurn,
    ...(finalStopReason === undefined ? {} : { stopTurnReason: finalStopReason }),
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolExecutorService,
  AgentToolExecutorService,
  ScopeActivation.OnScopeCreated,
  'toolExecutor',
);
