/**
 * `loop` domain (L4) — `IAgentLoopService` implementation.
 *
 * Drives one agent turn by draining an agent-scoped `StepRequestQueue` one
 * batch per step: each batch's driver request (plus any mergeable requests
 * folded into it) materializes its context messages, then one LLM step runs
 * (`beforeStep` → streamed request → content parts → tool execution →
 * `step.end` → `afterStep`). A step that executed tools enqueues a
 * `ContinuationStepRequest` for the next step; a plain assistant message
 * enqueues nothing, so the queue empties and the turn completes. A failed
 * step is retried by head-inserting its driver (`onError` hook opt-in);
 * orchestrators (`prompt`, `goal`, `externalHooks`) steer the turn purely by
 * enqueueing further requests. Emits `turn.step.*` / delta events through
 * `event`, persists loop events through `contextMemory`, and reads step /
 * retry budgets from `config`. Bound at Agent scope.
 */

import { randomUUID } from 'node:crypto';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { isAbortError, isUserCancellation } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import type {
  AssistantDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepRetryingEvent,
  TurnStepStartedEvent,
} from '@moonshot-ai/protocol';
import { IAgentLLMRequesterService, type LLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { type FinishReason } from '#/app/llmProtocol/finishReason';
import { type StreamedMessagePart } from '#/app/llmProtocol/message';
import { type TokenUsage } from '#/app/llmProtocol/usage';
import { ErrorCodes, KimiError } from '#/errors';
import { OrderedHookSlot } from '#/hooks';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { LOOP_CONTROL_SECTION, type LoopControl } from './configSection';
import {
  createMaxStepsExceededError,
  IAgentLoopService,
  isMaxStepsExceededError,
  type LoopRunOptions,
  type AfterStepContext,
  type LoopRunResult,
  type StepEnqueueOptions,
} from './loop';
import {
  ContinuationStepRequest,
  type StepRequest,
} from './stepRequest';
import { StepRequestQueue, type StepRequestBatch } from './stepRequestQueue';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'turn.step.started': TurnStepStartedEvent;
    'turn.step.retrying': TurnStepRetryingEvent;
    'turn.step.completed': TurnStepCompletedEvent;
    'turn.step.interrupted': TurnStepInterruptedEvent;
    'assistant.delta': AssistantDeltaEvent;
    'thinking.delta': ThinkingDeltaEvent;
    'tool.call.delta': ToolCallDeltaEvent;
  }
}

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error';

export class AgentLoopService implements IAgentLoopService {
  declare readonly _serviceBrand: undefined;

  readonly hooks: IAgentLoopService['hooks'] = {
    beforeStep: new OrderedHookSlot(),
    afterStep: new OrderedHookSlot(),
    onError: new OrderedHookSlot(),
  };

  private readonly stepQueue = new StepRequestQueue();

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IConfigService private readonly config: IConfigService,
  ) { }

  enqueue(request: StepRequest, options?: StepEnqueueOptions): void {
    this.stepQueue.enqueue(request, options?.at ?? 'tail');
  }

  hasPendingRequests(): boolean {
    return this.stepQueue.hasPendingRequests();
  }

  async run(options: LoopRunOptions): Promise<LoopRunResult> {
    const { turnId } = options;
    const signal = options.signal ?? new AbortController().signal;

    let steps = 0;
    let activeStep: number | undefined;
    let lastStopReason: FinishReason | undefined;
    try {
      while (true) {
        let failedDriver: StepRequest | undefined;
        try {
          activeStep = undefined;
          signal.throwIfAborted();

          if (!this.stepQueue.hasPendingRequests()) {
            return { type: 'completed', steps, truncated: lastStopReason === 'truncated' };
          }

          const maxSteps = this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;

          if (maxSteps !== undefined && maxSteps > 0 && steps >= maxSteps) {
            throw createMaxStepsExceededError(maxSteps);
          }

          steps += 1;
          activeStep = steps;
          const batch = this.stepQueue.takeNextBatch()!;
          failedDriver = batch.driver;
          this.materializeBatch(batch);
          const stepResult = await this.executeLoopStep(
            turnId,
            signal,
            steps,
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
          // reaches the error events, the onError hook, or the failure path —
          // `signal` is the single source of truth for turn cancellation.
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

          // ② Failures from down-stack arrive already coded (provider errors
          // are translated at the model boundary). Report the interruption,
          // then let onError handlers (e.g. full-compaction) opt into recovery.
          const reason: LoopInterruptReason = isMaxStepsExceededError(error) ? 'max_steps' : 'error';
          this.emitStepInterrupted(turnId, activeStep, reason, toErrorMessage(error));

          const context = { turnId, step: activeStep, signal, error, retry: false };
          try {
            await this.hooks.onError.run(context);
          } catch (hookError) {
            return { type: 'failed', error: hookError, steps };
          }

          // ③ Recover by retrying the failed driver, or fail the turn.
          if (context.retry && failedDriver !== undefined) {
            // Retry jumps the queue: the failed driver re-runs as the very next
            // step. It is already materialized, so its messages are not
            // appended a second time.
            this.stepQueue.enqueue(failedDriver, 'head');
            activeStep = undefined;
            continue;
          }
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
    onStarted: ((step: number) => void) | undefined,
  ): Promise<{
    readonly stopReason: FinishReason;
    readonly enqueueContinuation: boolean;
    readonly hookStopTurn: boolean;
  }> {
    await this.hooks.beforeStep.run({ turnId, step: currentStep, signal });
    signal.throwIfAborted();

    const stepUuid = randomUUID();

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
        retry: {
          maxAttempts: this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxRetriesPerStep,
          onRetry: (retry) => {
            this.eventBus.publish({
              type: 'turn.step.retrying',
              turnId,
              step: currentStep,
              stepId: stepUuid,
              failedAttempt: retry.failedAttempt,
              nextAttempt: retry.nextAttempt,
              maxAttempts: retry.maxAttempts,
              delayMs: retry.delayMs,
              errorName: retry.errorName,
              errorMessage: retry.errorMessage,
              statusCode: retry.statusCode,
            });
          },
        },
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopService,
  AgentLoopService,
  InstantiationType.Delayed,
  'loop',
);
