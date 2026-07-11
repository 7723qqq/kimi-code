/**
 * `loop` domain (L4) — `IAgentLoopService` implementation.
 *
 * Owns the whole turn lifecycle: a turn is one drain of the agent-scoped
 * `StepRequestQueue`, and it starts when `enqueue` receives a `nextTurn`
 * request while the loop is idle. Starting a turn synchronously takes the
 * turn lane through the `activity` kernel (`activity.begin('turn')`, whose
 * coded admission errors propagate to the caller before the request enters
 * the queue), records `turn.prompt`, publishes `turn.started`, and kicks the
 * run; ending it publishes `turn.ended` / `error` after `lease.end()` returns
 * the lane to idle (so `turn.ended` subscribers can start the next turn).
 * A `tryInTurn` request never starts a turn: it joins the active run or waits
 * in the queue for the next one.
 *
 * The run drains the queue one batch per step: each batch's driver request
 * (plus any mergeable requests folded into it) materializes its context
 * messages, then one LLM step runs (`beforeStep` → streamed request → content
 * parts → tool execution → `step.end` → `afterStep`). A step that executed
 * tools enqueues a `ContinuationStepRequest` for the next step; a plain
 * assistant message enqueues nothing, so the queue empties and the turn
 * completes. A failed step is dispatched to the registered error handlers
 * (first match wins); a handler that claims the error continues the turn with
 * the recovery's requests head-inserted into the queue — `stepRetry` re-runs
 * the failed driver after backoff, `fullCompaction` recovers provider
 * overflow — while an unclaimed error fails the turn. Orchestrators
 * (`prompt`, `goal`, `externalHooks`, `task`) steer the turn purely by
 * enqueueing further requests. Emits `turn.*` / delta events through `event`,
 * persists loop events through `contextMemory`, and reads the step budget
 * from `config`. Bound at Agent scope.
 */

import { randomUUID } from 'node:crypto';

import { createControlledPromise } from '@antfu/utils';

import { InstantiationType } from '#/_base/di/extensions';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { abortError, isAbortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import type {
  AssistantDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  TurnEndedEvent,
  TurnStartedEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepStartedEvent,
} from '@moonshot-ai/protocol';
import { IAgentLLMRequesterService, type LLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { type FinishReason } from '#/app/llmProtocol/finishReason';
import { type StreamedMessagePart } from '#/app/llmProtocol/message';
import { type TokenUsage } from '#/app/llmProtocol/usage';
import { BugIndicatingError, ErrorCodes, KimiError, toKimiErrorPayload } from '#/errors';
import { OrderedHookSlot } from '#/hooks';

import type { ActivityLease } from '#/activity/activity';
import { IAgentActivityService } from '#/activity/activity';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';
import { LOOP_CONTROL_SECTION, type LoopControl } from './configSection';
import {
  createMaxStepsExceededError,
  IAgentLoopService,
  isMaxStepsExceededError,
  type AfterStepContext,
  type EnqueueReceipt,
  type LoopErrorContext,
  type LoopErrorHandler,
  type LoopErrorHandlerRegistrationOptions,
  type LoopRunOptions,
  type LoopRunResult,
  type StepEnqueueOptions,
  type Turn,
  type TurnResult,
} from './loop';
import {
  ContinuationStepRequest,
  type StepRequest,
  type TurnSeed,
} from './stepRequest';
import { StepRequestQueue, type StepRequestBatch } from './stepRequestQueue';
import { cancelTurn, promptTurn } from './turnOps';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'turn.started': TurnStartedEvent;
    'turn.ended': TurnEndedEvent;
    'turn.step.started': TurnStepStartedEvent;
    'turn.step.completed': TurnStepCompletedEvent;
    'turn.step.interrupted': TurnStepInterruptedEvent;
    'assistant.delta': AssistantDeltaEvent;
    'thinking.delta': ThinkingDeltaEvent;
    'tool.call.delta': ToolCallDeltaEvent;
    // `error` is declared by the `mcp` domain (interface-merge); reused here,
    // not re-declared.
  }
}

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error';

export class AgentLoopService implements IAgentLoopService {
  declare readonly _serviceBrand: undefined;

  readonly hooks: IAgentLoopService['hooks'] = {
    beforeStep: new OrderedHookSlot(),
    afterStep: new OrderedHookSlot(),
  };

  private readonly stepQueue = new StepRequestQueue();
  private readonly errorHandlers: LoopErrorHandler[] = [];
  private activeTurn: Turn | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IConfigService private readonly config: IConfigService,
    @IAgentActivityService private readonly activity: IAgentActivityService,
    @IAgentWireService private readonly wire: IWireService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTelemetryContextService private readonly telemetryContext: IAgentTelemetryContextService,
  ) { }

  enqueue(request: StepRequest, options?: StepEnqueueOptions): EnqueueReceipt {
    const retract = (): boolean => request.abort();
    if (request.priority === 'nextTurn') {
      const seed = request.turnSeed;
      if (seed === undefined) {
        throw new BugIndicatingError(
          `Step request "${request.kind}" is nextTurn but carries no turnSeed`,
        );
      }
      // `startTurn` admits through the activity kernel BEFORE the request
      // enters the queue: a rejected admission throws with no queue residue,
      // so callers never need an abort-on-failure cleanup.
      return { turn: this.startTurn(request, seed), abort: retract };
    }
    this.stepQueue.enqueue(request, options?.at ?? 'tail');
    return { turn: this.activeTurn, abort: retract };
  }

  getActiveTurn(): Turn | undefined {
    return this.activeTurn;
  }

  cancel(turnId?: number, reason?: unknown): boolean {
    this.wire.dispatch(cancelTurn({ turnId }));
    const turn = this.activeTurn;
    if (turn === undefined) return false;
    if (turnId !== undefined && turn.id !== turnId) return false;
    return this.activity.cancel(reason ?? userCancellationReason());
  }

  hasPendingRequests(): boolean {
    return this.stepQueue.hasPendingRequests();
  }

  /**
   * Open a turn around the queue: admission → seed the driver → `turn.prompt`
   * record → `turn.started` → run. The whole prefix up to the first
   * `beforeStep` hook runs synchronously inside the caller's `enqueue`.
   */
  private startTurn(request: StepRequest, seed: TurnSeed): Turn {
    const lease = this.activity.begin('turn', { origin: seed.origin });
    this.stepQueue.enqueue(request);
    this.wire.dispatch(promptTurn({ input: seed.input, origin: lease.origin }));
    const ready = createControlledPromise<void>();
    const turn: MutableTurn = {
      id: lease.turnId,
      signal: lease.signal,
      ready,
      result: Promise.resolve({
        type: 'failed',
        steps: 0,
        error: new BugIndicatingError('Turn result was not initialized'),
      }),
    };
    void ready.catch(() => undefined);
    this.activeTurn = turn;
    this.eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: lease.origin });
    turn.result = this.runTurn(turn, lease, ready);
    return turn;
  }

  private async runTurn(
    turn: Turn,
    lease: ActivityLease,
    ready: ReturnType<typeof createControlledPromise<void>>,
  ): Promise<TurnResult> {
    const startedAt = Date.now();
    const turnTelemetry = this.telemetry.withContext(this.telemetryContext.get());
    let result: TurnResult | undefined;
    try {
      turnTelemetry.track('turn_started');
      result = await this.run({
        turnId: turn.id,
        signal: lease.signal,
        onStarted: () => ready.resolve(),
      });
      return result;
    } catch (error) {
      if (lease.signal.aborted) {
        result = {
          type: 'cancelled',
          steps: 0,
          reason: lease.signal.reason ?? error,
        };
        return result;
      }
      result = { type: 'failed', error, steps: 0 };
      return result;
    } finally {
      // `ready` rejects with the turn's own outcome: the real failure error,
      // the cancellation reason (control flow), or — for a turn that ended
      // before any step produced a response — an internal placeholder.
      if (result?.type === 'failed') {
        ready.reject(result.error);
      } else if (result?.type === 'cancelled') {
        ready.reject(result.reason instanceof Error ? result.reason : abortError('Turn cancelled'));
      } else {
        ready.reject(new KimiError(ErrorCodes.INTERNAL, 'Turn ended before first step'));
      }
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
      const outcome = result?.type ?? 'failed';
      lease.end(outcome, result?.type === 'failed' ? { error: result.error } : undefined);
      if (result !== undefined) {
        const error = result.type === 'failed' ? toKimiErrorPayload(result.error) : undefined;
        this.eventBus.publish({
          type: 'turn.ended',
          turnId: turn.id,
          reason: result.type,
          error,
          durationMs: Date.now() - startedAt,
        });
        if (error !== undefined) {
          this.eventBus.publish({ type: 'error', ...error });
        }
        if (result.type !== 'completed') {
          turnTelemetry.track('turn_interrupted', { at_step: result.steps });
        }
      }
      // `turn.ended` is published to `IEventBus` above; subscribers (swarm /
      // goal / externalHooks) react there — no hook slot to run here.
    }
  }

  registerLoopErrorHandler(
    handler: LoopErrorHandler,
    options: LoopErrorHandlerRegistrationOptions = {},
  ): IDisposable {
    if (options.before !== undefined && options.after !== undefined) {
      throw new Error('Loop error handler registration cannot specify both before and after');
    }
    this.deleteErrorHandler(handler.id);
    const target = options.before ?? options.after;
    if (target === undefined) {
      this.errorHandlers.push(handler);
    } else {
      const targetIndex = this.errorHandlers.findIndex((entry) => entry.id === target);
      if (targetIndex < 0) {
        throw new Error(`Loop error handler target "${target}" is not registered`);
      }
      const insertAt = options.before !== undefined ? targetIndex : targetIndex + 1;
      this.errorHandlers.splice(insertAt, 0, handler);
    }
    return toDisposable(() => {
      this.deleteErrorHandler(handler.id);
    });
  }

  private deleteErrorHandler(id: string): boolean {
    const index = this.errorHandlers.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.errorHandlers.splice(index, 1);
    return true;
  }

  /**
   * Drain the step queue for one turn: each queued `StepRequest` drives (or
   * merges into) one step, and the turn completes once the queue empties.
   * Only `runTurn` calls this — turns start exclusively through `enqueue`.
   */
  private async run(options: LoopRunOptions): Promise<LoopRunResult> {
    const { turnId } = options;
    const signal = options.signal ?? new AbortController().signal;

    let steps = 0;
    let activeStep: number | undefined;
    let resumeStep: number | undefined;
    let lastStopReason: FinishReason | undefined;
    try {
      while (true) {
        let failedDriver: StepRequest | undefined;
        let stepUuid: string | undefined;
        try {
          activeStep = undefined;
          signal.throwIfAborted();

          if (!this.stepQueue.hasPendingRequests()) {
            return { type: 'completed', steps, truncated: lastStopReason === 'truncated' };
          }

          // A handler that resumes the failed step (a loop-level retry) keeps
          // the failed step's number: the counter does not increment and the
          // maxSteps budget check is skipped.
          if (resumeStep !== undefined) {
            activeStep = resumeStep;
            resumeStep = undefined;
          } else {
            const maxSteps = this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
            if (maxSteps !== undefined && maxSteps > 0 && steps >= maxSteps) {
              throw createMaxStepsExceededError(maxSteps);
            }
            steps += 1;
            activeStep = steps;
          }

          const batch = this.stepQueue.takeNextBatch()!;
          failedDriver = batch.driver;
          stepUuid = randomUUID();
          this.materializeBatch(batch);
          const stepResult = await this.executeLoopStep(
            turnId,
            signal,
            activeStep,
            stepUuid,
            options.onStarted,
          );
          activeStep = undefined;
          lastStopReason = stepResult.stopReason;

          if (stepResult.stopReason === 'filtered') {
            throw new KimiError(
              ErrorCodes.PROVIDER_FILTERED,
              'Provider safety policy blocked the response.',
              {
                name: 'ProviderFilteredError',
                details: { finishReason: 'filtered' },
              },
            );
          }

          // A hook-set stopTurn is a hard stop: it wins over both requested
          // tool calls and any queued step requests, so the turn always ends
          // at this step boundary. Queued steers survive into the next turn.
          if (stepResult.hookStopTurn) {
            return { type: 'completed', steps, truncated: stepResult.stopReason === 'truncated' };
          }

          if (stepResult.enqueueContinuation) {
            this.stepQueue.enqueue(new ContinuationStepRequest());
          }
        } catch (error) {
          // ① Control flow first: cancellation is not an error. It never
          // reaches the error events, the error handlers, or the failure
          // path — `signal` is the single source of truth for turn
          // cancellation.
          if (isAbortError(error) || signal.aborted) {
            const abortReason = signal.reason ?? error;
            this.emitStepInterrupted(
              turnId,
              activeStep,
              'aborted',
              isUserCancellation(abortReason) ? undefined : toErrorMessage(abortReason),
            );
            return { type: 'cancelled', reason: abortReason, steps };
          }

          // ② Recovery: the first registered handler that claims the error
          // decides how (and whether) the turn continues — the loop knows
          // nothing about concrete error types. Awaiting inside the handler
          // suspends the loop here; an abort during it is still cancellation.
          const context: LoopErrorContext = {
            turnId,
            step: activeStep,
            stepId: stepUuid,
            signal,
            error,
            failedDriver,
          };
          const handler = this.errorHandlers.find((entry) => entry.match(context));
          if (handler !== undefined) {
            let recovery: Awaited<ReturnType<LoopErrorHandler['handle']>>;
            try {
              recovery = await handler.handle(context);
            } catch (handlerError) {
              if (isAbortError(handlerError) || signal.aborted) {
                const abortReason = signal.reason ?? handlerError;
                this.emitStepInterrupted(
                  turnId,
                  activeStep,
                  'aborted',
                  isUserCancellation(abortReason) ? undefined : toErrorMessage(abortReason),
                );
                return { type: 'cancelled', reason: abortReason, steps };
              }
              this.emitStepInterrupted(turnId, activeStep, 'error', toErrorMessage(handlerError));
              return { type: 'failed', error: handlerError, steps };
            }
            if (recovery !== undefined && recovery.requests.length > 0) {
              if (recovery.resumeStep === true && activeStep !== undefined) {
                resumeStep = activeStep;
              }
              this.stepQueue.enqueueFront(recovery.requests);
              activeStep = undefined;
              continue;
            }
          }

          // ③ Terminal failure: the interruption is reported only once the
          // error is known unrecoverable, so a recovered error never surfaces
          // as an interruption.
          const reason: LoopInterruptReason = isMaxStepsExceededError(error) ? 'max_steps' : 'error';
          this.emitStepInterrupted(turnId, activeStep, reason, toErrorMessage(error));
          return { type: 'failed', error, steps };
        }
      }
    } finally {
      this.stepQueue.abortTurnScoped();
    }
  }

  /**
   * Append the batch's context messages (driver first, then merged requests)
   * before `beforeStep` hooks run, so compaction / injection hooks observe the
   * full step input. A materialized driver (a retried step) is skipped.
   */
  private materializeBatch(batch: StepRequestBatch): void {
    this.materializeRequest(batch.driver);
    for (const request of batch.merged) {
      this.materializeRequest(request);
    }
  }

  private materializeRequest(request: StepRequest): void {
    if (request.state !== 'pending') return;
    request.onWillMaterialize();
    const messages = request.resolveContextMessages();
    if (messages.length > 0) {
      this.context.append(...messages);
    }
    request.markMaterialized();
  }

  private async executeLoopStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    stepUuid: string,
    onStarted: ((step: number) => void) | undefined,
  ): Promise<{
    readonly stopReason: FinishReason;
    readonly enqueueContinuation: boolean;
    readonly hookStopTurn: boolean;
  }> {
    await this.hooks.beforeStep.run({ turnId, step: currentStep, signal });
    signal.throwIfAborted();

    this.eventBus.publish({ type: 'turn.step.started', turnId, step: currentStep, stepId: stepUuid });
    this.context.appendLoopEvent({
      type: 'step.begin',
      uuid: stepUuid,
      turnId: String(turnId),
      step: currentStep,
    });

    let stepStarted = false;
    const markStepStarted = (): void => {
      if (stepStarted) return;
      stepStarted = true;
      onStarted?.(currentStep);
    };
    const emitStreamPart = this.createStreamPartHandler(turnId, markStepStarted);
    const response = await this.llmRequester.request(
      {
        source: { type: 'turn', turnId, step: currentStep },
      },
      emitStreamPart,
      signal,
    );

    const usage = response.usage;
    const { providerFinishReason, message } = response;
    let finishReason = providerFinishReason ?? 'completed';

    const turnIdStr = String(turnId);
    const toolCallUuids = new Map<string, string>();
    for (const part of message.content) {
      this.context.appendLoopEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId: turnIdStr,
        step: currentStep,
        stepUuid,
        part,
      });
    }

    const hasToolCalls = message.toolCalls.length > 0;
    let toolResultStopTurn = false;
    if (hasToolCalls) {
      for await (const toolResult of this.toolExecutor.execute(response.message.toolCalls, {
        signal,
        turnId,
        onToolCall: ({ toolCallId, name, args }) => {
          const callUuid = randomUUID();
          toolCallUuids.set(toolCallId, callUuid);
          this.context.appendLoopEvent({
            type: 'tool.call',
            uuid: callUuid,
            turnId: turnIdStr,
            step: currentStep,
            stepUuid,
            toolCallId,
            name,
            args,
          });
        },
      })) {
        const { result } = toolResult;
        this.context.appendLoopEvent({
          type: 'tool.result',
          parentUuid: toolCallUuids.get(toolResult.toolCallId) ?? randomUUID(),
          toolCallId: toolResult.toolCallId,
          result: { output: result.output, isError: result.isError, note: result.note },
        });
        if (result.stopTurn === true) toolResultStopTurn = true;
      }
      if (toolResultStopTurn) {
        finishReason = 'completed';
      } else {
        finishReason = 'tool_calls';
      }
    } else if (finishReason === 'tool_calls') {
      // The provider signaled a tool step but emitted no tool call structure.
      // Treat it as a terminal, non-tool step (v1 'unknown') instead of looping
      // on the bare signal, which would re-issue the model call until maxSteps.
      finishReason = 'other';
    }

    signal.throwIfAborted();

    markStepStarted();
    const timing = response.timing;
    const stepFinishReason = normalizeFinishReason(finishReason);
    this.context.appendLoopEvent({
      type: 'step.end',
      uuid: stepUuid,
      turnId: turnIdStr,
      step: currentStep,
      finishReason: stepFinishReason,
      usage,
      llmFirstTokenLatencyMs: timing?.firstTokenLatencyMs,
      llmStreamDurationMs: timing?.streamDurationMs,
      llmRequestBuildMs: timing?.requestBuildMs,
      llmServerFirstTokenMs: timing?.serverFirstTokenMs,
      llmServerDecodeMs: timing?.serverDecodeMs,
      llmClientConsumeMs: timing?.clientConsumeMs,
      messageId: response.providerMessageId,
      providerFinishReason,
      rawFinishReason: response.rawFinishReason,
    });
    this.emitStepCompleted(turnId, currentStep, stepUuid, usage, stepFinishReason, response);

    const afterStepContext: AfterStepContext = {
      turnId,
      step: currentStep,
      signal,
      usage,
      finishReason,
      stopTurn: false,
    };
    try {
      await this.hooks.afterStep.run(afterStepContext);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      // afterStep hook failures must not affect the turn result.
    }

    return {
      stopReason: finishReason,
      // A step that ran tools drives the next step; a plain assistant message
      // enqueues nothing, so the queue drains and the turn completes.
      enqueueContinuation: hasToolCalls && !toolResultStopTurn,
      hookStopTurn: afterStepContext.stopTurn,
    };
  }

  private emitStepCompleted(
    turnId: number,
    step: number,
    stepId: string,
    usage: TokenUsage,
    finishReason: string,
    response: LLMRequestFinish,
  ): void {
    this.eventBus.publish({
      type: 'turn.step.completed',
      turnId,
      step,
      stepId,
      usage,
      finishReason,
      llmFirstTokenLatencyMs: response.timing?.firstTokenLatencyMs,
      llmStreamDurationMs: response.timing?.streamDurationMs,
      llmRequestBuildMs: response.timing?.requestBuildMs,
      llmServerFirstTokenMs: response.timing?.serverFirstTokenMs,
      llmServerDecodeMs: response.timing?.serverDecodeMs,
      llmClientConsumeMs: response.timing?.clientConsumeMs,
      providerFinishReason: response.providerFinishReason,
      rawFinishReason: response.rawFinishReason,
    });
  }

  private emitStepInterrupted(
    turnId: number,
    activeStep: number | undefined,
    reason: LoopInterruptReason,
    message?: string,
  ): void {
    if (activeStep === undefined) return;
    this.eventBus.publish({
      type: 'turn.step.interrupted',
      turnId,
      step: activeStep,
      reason,
      message,
    });
  }

  private createStreamPartHandler(
    turnId: number,
    onResponseEvent: () => void,
  ): (part: StreamedMessagePart) => void {
    // Maps a tool call's streaming index to its identity so that interleaved
    // argument deltas from parallel tool calls can be routed to the right call.
    // Each provider emits a `function` header before any of its `tool_call_part`
    // deltas, and a delta's `index` always matches a previously-seen header's
    // `_streamIndex`. The `undefined` key doubles as the single-call fallback
    // for providers that stream without indices: those streams never mix indexed
    // and unindexed parts, so the most recent unindexed header is always the
    // target.
    const callsByIndex = new Map<number | string | undefined, { id: string; name: string }>();

    return (part) => {
      switch (part.type) {
        case 'text':
          onResponseEvent();
          this.eventBus.publish({ type: 'assistant.delta', turnId, delta: part.text });
          return;
        case 'think':
          onResponseEvent();
          this.eventBus.publish({ type: 'thinking.delta', turnId, delta: part.think });
          return;
        case 'image_url':
        case 'audio_url':
        case 'video_url':
          return;
        case 'function': {
          onResponseEvent();
          callsByIndex.set(part._streamIndex, { id: part.id, name: part.name });
          this.eventBus.publish({
            type: 'tool.call.delta',
            turnId,
            toolCallId: part.id,
            name: part.name,
            argumentsPart: part.arguments ?? undefined,
          });
          return;
        }
        case 'tool_call_part': {
          if (part.argumentsPart === null) return;
          const toolCall = callsByIndex.get(part.index);
          if (toolCall === undefined) return;
          onResponseEvent();
          this.eventBus.publish({
            type: 'tool.call.delta',
            turnId,
            toolCallId: toolCall.id,
            name: toolCall.name,
            argumentsPart: part.argumentsPart,
          });
          return;
        }
        default: {
          const _exhaustive: never = part;
          return _exhaustive;
        }
      }
    };
  }
}

function normalizeFinishReason(reason: FinishReason): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'completed') return 'end_turn';
  if (reason === 'truncated') return 'max_tokens';
  return reason;
}

type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopService,
  AgentLoopService,
  InstantiationType.Delayed,
  'loop',
);
