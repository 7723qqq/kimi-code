import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import {
  createHash
} from 'node:crypto';

import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  createToolMessage,
  emptyUsage,
  isContentPart,
  isContextOverflowStatusError,
  isRetryableGenerateError,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
  type ContentPart,
  type ToolCall as KosongToolCall,
  type StreamedMessagePart,
  type TokenUsage,
} from '@moonshot-ai/kosong';

import {
  Disposable,
} from "#/_base/di";
import {
  ErrorCodes,
  isKimiError,
  toKimiErrorPayload,
  type KimiErrorPayload,
} from "#/errors";
import { canonicalTelemetryArgs } from '#/_base/utils/canonical-args';
import { IAgentContextMemoryService, newMessageId, type ContextMessage } from '#/agent/contextMemory';
import { IAgentContextProjectorService } from '#/agent/contextProjector';
import { IAgentContextSizeService } from '#/agent/contextSize';
import { IAgentRecordService } from '#/agent/record';
import { IAgentExternalHooksService } from '#/agent/externalHooks';
import { IAgentLLMRequesterService } from '#/agent/llmRequester';
import { OrderedHookSlot } from '#/hooks';
import { ILogService } from '#/app/log';
import { IAgentProfileService } from '#/agent/profile';
import { IConfigService } from '#/app/config';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import type { Turn, TurnResult } from '#/agent/turn';
import type {
  LoopEvent,
  LoopEventDispatcher,
  LoopRecordedEvent,
} from './events';
import type { LLM, LLMChatParams, LLMChatResponse } from './llm';
import { IAgentLoopService } from './loop';
import {
  LOOP_CONTROL_SECTION,
  type LoopControl,
} from './configSection';
import { runTurn as runLoopTurn } from './run-turn';
import type {
  ExecutableTool,
  ExecutableToolResult,
} from '#/agent/tool';
import type { LoopHooks } from './types';

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';
type ToolTelemetryEvent = 'tool_call' | 'tool_call_dedup_detected' | 'tool_call_repeat';
type TelemetryProperties = Record<string, unknown>;

export class AgentLoopService extends Disposable implements IAgentLoopService {
  declare readonly _serviceBrand: undefined;
  readonly hooks: IAgentLoopService['hooks'] = {
    beforeStep: new OrderedHookSlot(),
    onStepUsage: new OrderedHookSlot(),
    afterStep: new OrderedHookSlot(),
    onContextOverflow: new OrderedHookSlot(),
  };

  private readonly openSteps = new Map<string, OpenStep>();
  private readonly toolCallStartedAt = new Map<string, ToolCallTelemetryStart>();
  private readonly toolCallDupType = new Map<string, 'normal' | 'cross_step'>();
  private readonly stepToolCallKeys = new Map<number, Set<string>>();
  private readonly stepFailureByTurn = new Map<number, Extract<LoopEvent, { type: 'turn.interrupted' }>>();
  private readonly pendingMeasurements = new Map<string, PendingContextMeasurement>();
  private ownSpliceDepth = 0;
  private protocolTurnId: number | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentRecordService private readonly record: IAgentRecordService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentExternalHooksService private readonly externalHooks: IAgentExternalHooksService,
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(
      this.hooks.beforeStep.register('turn-before-step-event', async (_ctx, next) => {
        await next();
      }),
    );
    this.context.hooks.onSpliced.register('loop-service-reconcile', async (_event, next) => {
      if (this.ownSpliceDepth === 0) {
        this.resetLiveStateFromHistory();
      }
      await next();
    });
    this.record.hooks.onResumeEnded.register(
      'loop-service-finish-resume',
      async (_event, next) => {
        this.finishResume();
        await next();
      },
    );
  }

  async runTurn(turn: Turn): Promise<TurnResult> {
    const startedAt = Date.now();
    this.protocolTurnId = turn.id;
    const llm = this.createLLM(turn.id);
    const loopHooks = this.loopHooks(turn);
    try {
      // Preflight the model configuration before any step begins. Legacy reads
      // `config.model` at the top of its step loop, so a missing model fails the
      // turn before `step.begin` ever fires (no step.interrupted, no api_error).
      this.profile.resolveModelContext();
      while (true) {
        try {
          const result = await runLoopTurn({
            turnId: String(turn.id),
            signal: turn.abortController.signal,
            llm,
            buildMessages: () => [...this.projector.project(this.context.get())],
            dispatchEvent: this.dispatchEvent,
            tools: this.executableTools(),
            hooks: loopHooks,
            log: this.log,
            toolExecutor: this.toolExecutor,
            maxSteps: this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn,
            maxRetryAttempts: this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxRetriesPerStep,
            recordStepUsage: async (usage, context) => {
              const tokens = tokenUsageTotal(usage);
              if (tokens > 0) {
                if (context.toolCallCount > 0) {
                  this.pendingMeasurements.set(context.stepUuid, {
                    tokens,
                    remainingToolCalls: context.toolCallCount,
                  });
                } else {
                  this.contextSize.measured(this.measurementLength(context.stepUuid), tokens);
                }
              }
              const usageContext = {
                turn,
                usage,
                stepNumber: context.stepNumber,
                stepUuid: context.stepUuid,
                toolCallCount: context.toolCallCount,
                stopTurn: false,
              };
              await this.hooks.onStepUsage.run(usageContext);
              return usageContext.stopTurn ? { stopTurn: true } : undefined;
            },
          });
          if (result.stopReason === 'aborted') {
            return { reason: 'cancelled', error: turn.abortController.signal.reason };
          }
          if (result.stopReason === 'filtered') {
            return { reason: 'filtered' };
          }
          return { reason: 'completed' };
        } catch (error) {
          if (isContextOverflowError(error)) {
            const context = { turn, error, handled: false };
            await this.hooks.onContextOverflow.run(context);
            if (context.handled) continue;
          }
          throw error;
        }
      }
    } catch (error) {
      this.trackApiError(turn.id, error, startedAt);
      throw error;
    } finally {
      if (this.protocolTurnId === turn.id) {
        this.protocolTurnId = undefined;
      }
      this.toolCallStartedAt.clear();
      this.toolCallDupType.clear();
      this.stepToolCallKeys.clear();
      this.stepFailureByTurn.delete(turn.id);
      this.pendingMeasurements.clear();
    }
  }

  private handleEvent(event: LoopRecordedEvent): void {
    switch (event.type) {
      case 'step.begin': {
        const message: ContextMessage = {
          id: newMessageId(),
          role: 'assistant',
          content: [],
          toolCalls: [],
        };
        this.openSteps.set(event.uuid, { message, inserted: false });
        return;
      }
      case 'step.end': {
        if (event.providerMessageId !== undefined) {
          this.stampProviderMessageId(event.uuid, event.providerMessageId);
        }
        this.openSteps.delete(event.uuid);
        this.pendingMeasurements.delete(event.uuid);
        return;
      }
      case 'content.part':
        this.replaceOpenStep(event.stepUuid, (message) => ({
          ...message,
          content: [...message.content, cloneContentPart(event.part)],
        }));
        return;
      case 'tool.call':
        this.replaceOpenStep(event.stepUuid, (message) => ({
          ...message,
          toolCalls: [
            ...message.toolCalls,
            {
              type: 'function',
              id: event.toolCallId,
              name: event.name,
              arguments: stringifyToolArguments(event.args),
            },
          ],
        }));
        this.applyPendingMeasurementAfterToolCall(event.stepUuid);
        return;
      case 'tool.result':
        this.appendToolResult(event.toolCallId, event.result);
        return;
    }
  }

  private readonly dispatchEvent = ((event: LoopEvent) => {
    if (isRecordedLoopEvent(event)) {
      this.handleEvent(event);
      this.emitProtocolEvent(event);
      return Promise.resolve();
    }
    this.emitProtocolEvent(event);
    return undefined;
  }) as LoopEventDispatcher;

  private emitProtocolEvent(event: LoopEvent): void {
    switch (event.type) {
      case 'step.begin':
        this.beginTrackedStep(event.step);
        this.record.signal({
          type: 'turn.step.started',
          turnId: Number(event.turnId),
          step: event.step,
          stepId: event.uuid,
        });
        return;
      case 'step.end':
        this.record.signal({
          type: 'turn.step.completed',
          turnId: Number(event.turnId),
          step: event.step,
          stepId: event.uuid,
          usage: event.usage,
          finishReason: event.finishReason,
          llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
          llmStreamDurationMs: event.llmStreamDurationMs,
          llmRequestBuildMs: event.llmRequestBuildMs,
          llmServerFirstTokenMs: event.llmServerFirstTokenMs,
          llmServerDecodeMs: event.llmServerDecodeMs,
          llmClientConsumeMs: event.llmClientConsumeMs,
          providerFinishReason: event.providerFinishReason,
          rawFinishReason: event.rawFinishReason,
        });
        return;
      case 'step.retrying':
        this.record.signal({
          type: 'turn.step.retrying',
          turnId: Number(event.turnId),
          step: event.step,
          stepId: event.stepUuid,
          failedAttempt: event.failedAttempt,
          nextAttempt: event.nextAttempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorName: event.errorName,
          errorMessage: event.errorMessage,
          statusCode: event.statusCode,
        });
        return;
      case 'turn.interrupted':
        if (this.protocolTurnId !== undefined) {
          if (event.reason === 'error' && event.activeStep !== undefined) {
            this.stepFailureByTurn.set(this.protocolTurnId, event);
          }
        }
        if (this.protocolTurnId === undefined || event.activeStep === undefined) return;
        this.record.signal({
          type: 'turn.step.interrupted',
          turnId: this.protocolTurnId,
          step: event.activeStep,
          reason: event.reason,
          message: event.message,
        });
        return;
      case 'text.delta':
        if (this.protocolTurnId === undefined) return;
        this.record.signal({
          type: 'assistant.delta',
          turnId: this.protocolTurnId,
          delta: event.delta,
        });
        return;
      case 'thinking.delta':
        if (this.protocolTurnId === undefined) return;
        this.record.signal({
          type: 'thinking.delta',
          turnId: this.protocolTurnId,
          delta: event.delta,
        });
        return;
      case 'tool.call.delta':
        if (this.protocolTurnId === undefined) return;
        this.record.signal({
          type: 'tool.call.delta',
          turnId: this.protocolTurnId,
          toolCallId: event.toolCallId,
          name: event.name,
          argumentsPart: event.argumentsPart,
        });
        return;
      case 'tool.call':
        this.trackToolCallStarted(event);
        this.record.signal({
          type: 'tool.call.started',
          turnId: Number(event.turnId),
          toolCallId: event.toolCallId,
          name: event.name,
          args: event.args,
          description: event.description,
          display: event.display,
        });
        return;
      case 'tool.progress':
        if (this.protocolTurnId === undefined) return;
        this.record.signal({
          type: 'tool.progress',
          turnId: this.protocolTurnId,
          toolCallId: event.toolCallId,
          update: event.update,
        });
        return;
      case 'tool.result':
        if (this.protocolTurnId === undefined) return;
        this.trackToolCallResult(event);
        this.record.signal({
          type: 'tool.result',
          turnId: this.protocolTurnId,
          toolCallId: event.toolCallId,
          output: event.result.output,
          isError: event.result.isError,
        });
        return;
      default:
        return;
    }
  }

  private beginTrackedStep(step: number): void {
    if (!this.stepToolCallKeys.has(step)) {
      this.stepToolCallKeys.set(step, new Set());
    }
  }

  private trackToolCallStarted(event: Extract<LoopEvent, { type: 'tool.call' }>): void {
    const dupType = this.trackDuplicateToolCall(
      Number(event.turnId),
      event.step,
      event.name,
      event.args,
    );
    this.toolCallDupType.set(
      event.toolCallId,
      dupType === 'cross_step' ? 'cross_step' : 'normal',
    );
    this.toolCallStartedAt.set(event.toolCallId, {
      name: event.name,
      startedAt: Date.now(),
    });
  }

  private trackToolCallResult(event: Extract<LoopEvent, { type: 'tool.result' }>): void {
    const started = this.toolCallStartedAt.get(event.toolCallId);
    if (started === undefined) return;
    this.toolCallStartedAt.delete(event.toolCallId);
    const dupType = this.toolCallDupType.get(event.toolCallId) ?? 'normal';
    this.toolCallDupType.delete(event.toolCallId);

    const outcome = telemetryToolOutcome(event.result);
    const properties: Record<string, string | number | boolean | undefined> = {
      tool_name: started.name,
      outcome,
      duration_ms: Date.now() - started.startedAt,
      dup_type: dupType,
    };
    const errorType = outcome === 'error' ? telemetryToolErrorType(event.result) : undefined;
    if (errorType !== undefined) {
      properties['error_type'] = errorType;
    }
    this.emitToolTelemetry('tool_call', properties);
  }

  private trackDuplicateToolCall(
    turnId: number,
    step: number,
    toolName: string,
    args: unknown,
  ): 'normal' | 'same_step' | 'cross_step' {
    const argsText = canonicalTelemetryArgs(args);
    const key = `${toolName}\u0000${argsText}`;
    const stepKeys = this.stepToolCallKeys.get(step) ?? new Set<string>();
    this.stepToolCallKeys.set(step, stepKeys);

    let dupType: 'same_step' | 'cross_step' | undefined;
    if (stepKeys.has(key)) {
      dupType = 'same_step';
    } else if (this.hasPriorStepToolCallKey(step, key)) {
      dupType = 'cross_step';
    }

    stepKeys.add(key);
    if (dupType === undefined) return 'normal';

    this.emitToolTelemetry(
      'tool_call_dedup_detected',
      {
        turn_id: turnId,
        step_no: step,
        tool_name: toolName,
        dup_type: dupType,
        args_hash: createHash('sha256').update(argsText).digest('hex').slice(0, 8),
      },
    );
    return dupType;
  }

  private emitToolTelemetry(event: ToolTelemetryEvent, properties: TelemetryProperties = {}): void {
    this.telemetry.track(event, properties);
  }

  private trackApiError(turnId: number, error: unknown, startedAt: number): void {
    if (!this.shouldTrackApiError(turnId)) return;
    const summary = toKimiErrorPayload(error);
    const classification = classifyApiError(error, summary);
    const properties: Record<string, string | number | boolean | undefined> = {
      error_type: classification.errorType,
      model: this.profile.data().modelAlias ?? 'unknown',
      retryable: summary.retryable,
      duration_ms: Date.now() - startedAt,
    };
    if (classification.statusCode !== undefined) {
      properties['status_code'] = classification.statusCode;
    }
    this.telemetry.track('api_error', properties);
  }

  private shouldTrackApiError(turnId: number): boolean {
    const failure = this.stepFailureByTurn.get(turnId);
    return failure?.reason === 'error' && failure.activeStep !== undefined;
  }

  private hasPriorStepToolCallKey(step: number, key: string): boolean {
    for (const [seenStep, keys] of this.stepToolCallKeys) {
      if (seenStep !== step && keys.has(key)) return true;
    }
    return false;
  }

  private createLLM(turnId: number): LLM {
    return {
      systemPrompt: this.profile.getSystemPrompt(),
      modelName: this.profile.data().modelAlias ?? 'unknown',
      isRetryableError: (error: unknown) => isRetryableGenerateError(error),
      chat: async (params) => this.chat(params, turnId),
    };
  }

  private async chat(
    params: LLMChatParams,
    turnId: number,
  ): Promise<LLMChatResponse> {
    const collector = new LLMEventCollector();
    const toolCallDeltas = new ToolCallDeltaEmitter(params);
    let usage = emptyUsage();
    let providerFinishReason: LLMChatResponse['providerFinishReason'];
    let rawFinishReason: string | undefined;
    let providerMessageId: string | undefined;
    let streamTiming: LLMChatResponse['streamTiming'];
    const stream = this.llmRequester.request(
      {
        messages: params.messages,
        tools: params.tools,
        systemPrompt: this.profile.getSystemPrompt(),
        requestLogFields: params.requestLogFields,
        usageContext: { type: 'turn', turnId },
      },
      params.signal,
    );

    for await (const event of stream) {
      params.signal.throwIfAborted();
      switch (event.type) {
        case 'part':
          emitStreamDelta(params, event.part);
          toolCallDeltas.accept(event.part);
          collector.accept(event.part);
          continue;
        case 'usage':
          usage = event.usage;
          continue;
        case 'finish':
          providerFinishReason = event.providerFinishReason;
          rawFinishReason = event.rawFinishReason;
          providerMessageId = event.id;
          continue;
        case 'timing':
          streamTiming = {
            firstTokenLatencyMs: event.firstTokenLatencyMs,
            streamDurationMs: event.streamDurationMs,
            requestBuildMs: event.requestBuildMs,
            serverFirstTokenMs: event.serverFirstTokenMs,
            serverDecodeMs: event.serverDecodeMs,
            clientConsumeMs: event.clientConsumeMs,
          };
          continue;
      }
    }

    const assistant = collector.toAssistantMessage();
    for (const part of assistant.content) {
      await emitCompletedContentPart(params, part);
    }
    return {
      toolCalls: assistant.toolCalls,
      usage,
      providerFinishReason,
      rawFinishReason,
      providerMessageId,
      streamTiming,
    };
  }

  private executableTools(): readonly ExecutableTool[] {
    return this.toolRegistry
      .list()
      .filter((tool) => this.profile.isToolActive(tool.name, tool.source))
      .flatMap((toolInfo) => {
        const tool = this.toolRegistry.resolve(toolInfo.name);
        return tool === undefined ? [] : [tool];
      });
  }

  private loopHooks(turn: Turn): LoopHooks {
    let continueAfterStop = false;
    let stopHookContinuationUsed = false;
    return {
      beforeStep: async () => {
        await this.hooks.beforeStep.run({ turn, continueTurn: false });
        return undefined;
      },
      afterStep: async (context) => {
        const turnContext = { turn, continueTurn: false };
        await this.hooks.afterStep.run(turnContext);
        if (context.stopReason !== 'tool_use' && turnContext.continueTurn) {
          continueAfterStop = true;
        }
        return undefined;
      },
      shouldContinueAfterStop: async (context) => {
        const shouldContinue = continueAfterStop;
        continueAfterStop = false;
        if (shouldContinue) return { continue: true };

        if (!stopHookContinuationUsed) {
          const reason = await this.externalHooks.triggerStop(
            context.signal,
            stopHookContinuationUsed,
          );
          if (reason !== undefined) {
            stopHookContinuationUsed = true;
            this.appendImmediately({
              role: 'user',
              content: [{ type: 'text', text: reason }],
              toolCalls: [],
              origin: { kind: 'system_trigger', name: 'stop_hook' },
            });
            if (
              !hasStepBudgetRemaining(
                this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn,
                context.stepNumber,
              )
            ) {
              this.removeMatchedTailMessage(isStopHookMessage);
              return { continue: false };
            }
            return { continue: true };
          }
        }

        return { continue: false };
      },
    };
  }

  private finishResume(): void {
    // Interrupted (unanswered) tool calls are closed by the projector on every
    // projection, so resume does not persist any synthetic results — it only
    // needs to drop the live in-progress step state from before the restart.
    this.openSteps.clear();
  }

  private replaceOpenStep(
    stepUuid: string,
    update: (message: ContextMessage) => ContextMessage,
  ): void {
    const message = this.openSteps.get(stepUuid);
    if (message === undefined) {
      throw new Error(
        `Received loop event for unknown step_uuid '${stepUuid}' (no open step_begin)`,
      );
    }

    const next = update(message.message);
    if (!message.inserted) {
      this.appendImmediately(next);
      this.openSteps.set(stepUuid, { message: next, inserted: true });
      return;
    }

    const history = this.context.get();
    const index = history.indexOf(message.message);
    if (index < 0) {
      throw new Error(`Open loop step '${stepUuid}' is no longer present in context history`);
    }
      this.spliceHistory(index, 1, [next]);
    this.openSteps.set(stepUuid, { message: next, inserted: true });
  }

  private stampProviderMessageId(stepUuid: string, providerMessageId: string): void {
    const openStep = this.openSteps.get(stepUuid);
    if (openStep === undefined || !openStep.inserted) return;
    const index = this.context.get().indexOf(openStep.message);
    if (index < 0) return;
    this.spliceHistory(index, 1, [{ ...openStep.message, providerMessageId }]);
  }

  private appendToolResult(toolCallId: string, result: ExecutableToolResult): void {
    const message = createToolMessage(toolCallId, toolResultOutputForModel(result));
    this.appendImmediately({
      ...message,
      role: 'tool',
      isError: result.isError,
    });
  }

  private appendImmediately(...messages: ContextMessage[]): void {
    if (messages.length === 0) return;
    this.spliceHistory(this.context.get().length, 0, messages);
  }

  private removeMatchedTailMessage(matcher: (message: ContextMessage) => boolean): boolean {
    const history = this.context.get();
    const index = history.length - 1;
    const message = history[index];
    if (message === undefined || !matcher(message)) return false;
    this.spliceHistory(index, 1, []);
    return true;
  }

  private spliceHistory(
    start: number,
    deleteCount: number,
    messages: readonly ContextMessage[],
  ): void {
    this.ownSpliceDepth++;
    try {
      this.context.splice(start, deleteCount, messages);
    } finally {
      this.ownSpliceDepth--;
    }
  }

  private resetLiveStateFromHistory(): void {
    this.openSteps.clear();
  }

  private measurementLength(stepUuid: string): number {
    const openStep = this.openSteps.get(stepUuid);
    const history = this.context.get();
    if (openStep === undefined) return history.length;
    const index = history.indexOf(openStep.message);
    return index === -1 ? history.length : index + 1;
  }

  private applyPendingMeasurementAfterToolCall(stepUuid: string): void {
    const pending = this.pendingMeasurements.get(stepUuid);
    if (pending === undefined) return;

    const remainingToolCalls = pending.remainingToolCalls - 1;
    if (remainingToolCalls > 0) {
      this.pendingMeasurements.set(stepUuid, {
        ...pending,
        remainingToolCalls,
      });
      return;
    }

    this.pendingMeasurements.delete(stepUuid);
    this.contextSize.measured(this.measurementLength(stepUuid), pending.tokens);
  }
}

interface OpenStep {
  readonly message: ContextMessage;
  readonly inserted: boolean;
}

interface PendingContextMeasurement {
  readonly tokens: number;
  readonly remainingToolCalls: number;
}

interface ToolCallTelemetryStart {
  readonly name: string;
  readonly startedAt: number;
}


function stringifyToolArguments(args: unknown): string | null {
  if (args === undefined) return null;
  return JSON.stringify(args) ?? null;
}

function isStopHookMessage(message: ContextMessage): boolean {
  return message.origin?.kind === 'system_trigger' && message.origin.name === 'stop_hook';
}

function hasStepBudgetRemaining(maxSteps: number | undefined, currentStep: number): boolean {
  return maxSteps === undefined || maxSteps <= 0 || currentStep < maxSteps;
}

function isContextOverflowError(error: unknown): boolean {
  return (
    error instanceof APIContextOverflowError ||
    (isKimiError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW)
  );
}

interface ApiErrorClassification {
  readonly errorType: string;
  readonly statusCode?: number;
}

function classifyApiError(error: unknown, summary: KimiErrorPayload): ApiErrorClassification {
  const statusCode = apiStatusCode(error) ?? summaryStatusCode(summary);
  if (statusCode !== undefined) {
    if (statusCode === 429) return { errorType: 'rate_limit', statusCode };
    if (statusCode === 401 || statusCode === 403) return { errorType: 'auth', statusCode };
    if (statusCode >= 500) return { errorType: '5xx_server', statusCode };
    if (isContextOverflowStatusError(statusCode, summary.message)) {
      return { errorType: 'context_overflow', statusCode };
    }
    if (statusCode >= 400) return { errorType: '4xx_client', statusCode };
    return { errorType: 'api', statusCode };
  }

  if (summary.code === ErrorCodes.PROVIDER_RATE_LIMIT) return { errorType: 'rate_limit' };
  if (summary.code === ErrorCodes.PROVIDER_AUTH_ERROR) return { errorType: 'auth' };
  if (summary.code === ErrorCodes.CONTEXT_OVERFLOW) return { errorType: 'context_overflow' };
  if (isApiConnectionError(error, summary)) return { errorType: 'network' };
  if (isApiTimeoutError(error, summary)) return { errorType: 'timeout' };
  if (isApiEmptyResponseError(error, summary)) return { errorType: 'empty_response' };
  return { errorType: 'other' };
}

function apiStatusCode(error: unknown): number | undefined {
  if (error instanceof APIStatusError) return error.statusCode;
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function summaryStatusCode(summary: KimiErrorPayload): number | undefined {
  const statusCode = summary.details?.['statusCode'];
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function isApiConnectionError(error: unknown, summary: KimiErrorPayload): boolean {
  return error instanceof APIConnectionError || summary.name === 'APIConnectionError';
}

function isApiTimeoutError(error: unknown, summary: KimiErrorPayload): boolean {
  return (
    error instanceof APITimeoutError ||
    summary.name === 'APITimeoutError' ||
    summary.name === 'TimeoutError'
  );
}

function isApiEmptyResponseError(error: unknown, summary: KimiErrorPayload): boolean {
  return error instanceof APIEmptyResponseError || summary.name === 'APIEmptyResponseError';
}

function toolResultOutputForModel(result: ExecutableToolResult): string | ContentPart[] {
  const output = result.output;
  if (typeof output === 'string') {
    if (result.isError === true) {
      if (output.length === 0) return TOOL_EMPTY_ERROR_STATUS;
      if (output.trimStart().startsWith('<system>ERROR:')) return output;
      return `${TOOL_ERROR_STATUS}\n${output}`;
    }
    return isEmptyOutputText(output) ? TOOL_EMPTY_STATUS : output;
  }

  if (output.length === 0) {
    return [
      {
        type: 'text',
        text: result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS,
      },
    ];
  }
  if (result.isError === true) {
    return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...output.map(cloneContentPart)];
  }
  return output.map(cloneContentPart);
}

function isEmptyOutputText(output: string): boolean {
  return output.length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT;
}

function cloneContentPart<T extends ContentPart>(part: T): T {
  return { ...part };
}

function isRecordedLoopEvent(event: LoopEvent): event is LoopRecordedEvent {
  return (
    event.type === 'step.begin' ||
    event.type === 'step.end' ||
    event.type === 'content.part' ||
    event.type === 'tool.call' ||
    event.type === 'tool.result'
  );
}

function tokenUsageTotal(usage: TokenUsage): number {
  return usage.inputCacheRead + usage.inputCacheCreation + usage.inputOther + usage.output;
}

function emitStreamDelta(params: LLMChatParams, part: StreamedMessagePart): void {
  if (part.type === 'text') {
    params.onTextDelta?.(part.text);
    return;
  }
  if (part.type === 'think') {
    params.onThinkDelta?.(part.think);
  }
}

async function emitCompletedContentPart(
  params: LLMChatParams,
  part: ContentPart,
): Promise<void> {
  if (part.type === 'text') {
    await params.onTextPart?.(part);
    return;
  }
  if (part.type === 'think') {
    await params.onThinkPart?.(part);
  }
}

function telemetryToolOutcome(result: ExecutableToolResult): 'success' | 'error' | 'cancelled' {
  if (result.isError !== true) return 'success';
  const text = toolResultText(result).toLowerCase();
  return text.includes('aborted') ||
    text.includes('cancelled') ||
    text.includes('manually interrupted')
    ? 'cancelled'
    : 'error';
}

function telemetryToolErrorType(result: ExecutableToolResult): string {
  const text = toolResultText(result);
  if (text.startsWith('Tool "') && text.includes('" not found')) return 'ToolNotFound';
  if (text.startsWith('Invalid args for tool "')) return 'ToolInputError';
  if (text.includes('prepareToolExecution hook failed')) return 'HookError';
  if (text.includes('finalizeToolResult hook failed')) return 'HookError';
  if (text.includes('blocked')) return 'ToolBlocked';
  return 'ToolError';
}

function toolResultText(result: ExecutableToolResult): string {
  return toolOutputText(result.output);
}

function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

class LLMEventCollector {
  private readonly parts: StreamedMessagePart[] = [];
  private readonly indexedToolCalls = new Map<number | string, KosongToolCall>();
  private readonly pendingIndexedToolCallDeltas = new Map<
    number | string,
    StreamedMessagePart[]
  >();
  private lastToolCall: KosongToolCall | undefined;

  accept(part: StreamedMessagePart): void {
    if (isToolCallPart(part)) {
      if (part.index !== undefined) {
        const toolCall = this.indexedToolCalls.get(part.index);
        if (toolCall !== undefined) {
          mergeInPlace(toolCall, part);
          return;
        }
        const pending = this.pendingIndexedToolCallDeltas.get(part.index) ?? [];
        pending.push(cloneStreamedPart(part));
        this.pendingIndexedToolCallDeltas.set(part.index, pending);
        return;
      }
      if (this.lastToolCall !== undefined) {
        mergeInPlace(this.lastToolCall, part);
      }
      return;
    }

    const previous = this.parts.at(-1);
    if (previous !== undefined && mergeInPlace(previous, part)) {
      return;
    }

    if (isToolCall(part)) {
      const cloned = cloneStreamedPart(part) as KosongToolCall;
      this.parts.push(cloned);
      this.lastToolCall = cloned;
      if (part._streamIndex !== undefined) {
        this.indexedToolCalls.set(part._streamIndex, cloned);
        const pending = this.pendingIndexedToolCallDeltas.get(part._streamIndex);
        if (pending !== undefined) {
          this.pendingIndexedToolCallDeltas.delete(part._streamIndex);
          for (const delta of pending) {
            mergeInPlace(cloned, delta);
          }
        }
      }
      return;
    }

    this.parts.push(cloneStreamedPart(part));
  }

  toAssistantMessage(): Pick<ContextMessage, 'content' | 'toolCalls'> {
    const content: ContentPart[] = [];
    const toolCalls: KosongToolCall[] = [];
    for (const part of this.parts) {
      if (isContentPart(part)) {
        content.push(part);
      } else if (isToolCall(part)) {
        toolCalls.push(stripStreamIndex(part));
      }
    }

    return { content, toolCalls };
  }
}

function cloneStreamedPart(part: StreamedMessagePart): StreamedMessagePart {
  return { ...part } as StreamedMessagePart;
}

function stripStreamIndex(toolCall: KosongToolCall): KosongToolCall {
  const { _streamIndex, ...rest } = toolCall;
  void _streamIndex;
  return rest;
}

class ToolCallDeltaEmitter {
  private readonly toolCallIdentities = new Map<number | string, ToolCallIdentity>();
  private readonly pendingIndexedDeltas = new Map<number | string, ToolCallDelta[]>();
  private lastToolCallIdentity: ToolCallIdentity | undefined;

  constructor(private readonly params: LLMChatParams) {}

  accept(part: StreamedMessagePart): void {
    if (isToolCall(part)) {
      const identity = { toolCallId: part.id, name: part.name };
      this.lastToolCallIdentity = identity;
      if (part._streamIndex !== undefined) {
        this.toolCallIdentities.set(part._streamIndex, identity);
      }
      this.emit(identity, part.arguments === null ? {} : { argumentsPart: part.arguments });
      if (part._streamIndex !== undefined) {
        const pending = this.pendingIndexedDeltas.get(part._streamIndex);
        if (pending !== undefined) {
          this.pendingIndexedDeltas.delete(part._streamIndex);
          for (const delta of pending) {
            this.emit(identity, delta);
          }
        }
      }
      return;
    }

    if (!isToolCallPart(part)) return;

    const delta = part.argumentsPart === null ? {} : { argumentsPart: part.argumentsPart };
    if (part.index !== undefined) {
      const identity = this.toolCallIdentities.get(part.index);
      if (identity !== undefined) {
        this.emit(identity, delta);
        return;
      }
      const pending = this.pendingIndexedDeltas.get(part.index) ?? [];
      pending.push(delta);
      this.pendingIndexedDeltas.set(part.index, pending);
      return;
    }

    if (this.lastToolCallIdentity !== undefined) {
      this.emit(this.lastToolCallIdentity, delta);
    }
  }

  private emit(identity: ToolCallIdentity, delta: ToolCallDelta): void {
    this.params.onToolCallDelta?.({
      toolCallId: identity.toolCallId,
      name: identity.name,
      ...delta,
    });
  }
}

interface ToolCallIdentity {
  readonly toolCallId: string;
  readonly name: string;
}

interface ToolCallDelta {
  readonly argumentsPart?: string;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopService,
  AgentLoopService,
  InstantiationType.Delayed,
  'loop',
);
