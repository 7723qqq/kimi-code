import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  IAgentContextMemoryService,
  newMessageId,
  type ContextMessage,
} from '#/agent/contextMemory';
import { IAgentContextProjectorService } from '#/agent/contextProjector';
import { IAgentContextSizeService } from '#/agent/contextSize';
import { IAgentEventSinkService } from '#/agent/eventSink';
import { IAgentExternalHooksService } from '#/agent/externalHooks';
import {
  IAgentLLMRequesterService,
  type LLMRequestFinish,
} from '#/agent/llmRequester';
import { IAgentProfileService } from '#/agent/profile';
import type { ExecutableTool, ToolResult } from '#/agent/tool';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { IConfigRegistry, IConfigService } from '#/app/config';
import { ILogService } from '#/app/log';
import { ErrorCodes, isKimiError } from '#/errors';
import { OrderedHookSlot } from '#/hooks';
import {
  APIContextOverflowError,
  createToolMessage,
  isToolCall,
  isToolCallPart,
  type ContentPart,
  type StreamedMessagePart,
  type TokenUsage,
  type ToolCall,
} from '@moonshot-ai/kosong';
import type { AgentEvent } from '@moonshot-ai/protocol';
import { randomUUID } from 'node:crypto';
import {
  LOOP_CONTROL_SECTION,
  LoopControlSchema,
  loopControlFromToml,
  loopControlToToml,
  type LoopControl,
} from './configSection';
import {
  createMaxStepsExceededError,
  errorMessage,
  isAbortError,
  isMaxStepsExceededError,
} from './errors';
import type { LoopInterruptReason } from './events';
import { IAgentLoopService } from './loop';
import type {
  LoopStepStopReason,
  LoopTurnStopReason,
  TurnResult,
} from './types';

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';

export class AgentLoopService implements IAgentLoopService {
  declare readonly _serviceBrand: undefined;

  readonly hooks: IAgentLoopService['hooks'] = {
    beforeStep: new OrderedHookSlot(),
    onStepUsage: new OrderedHookSlot(),
    afterStep: new OrderedHookSlot(),
    onContextOverflow: new OrderedHookSlot(),
  };

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentEventSinkService private readonly events: IAgentEventSinkService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentExternalHooksService private readonly externalHooks: IAgentExternalHooksService,
    @IConfigRegistry configRegistry: IConfigRegistry,
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
  ) {
    configRegistry.registerSection(LOOP_CONTROL_SECTION, LoopControlSchema, {
      fromToml: loopControlFromToml,
      toToml: loopControlToToml,
    });
  }

  async runTurn(
    turnId: number,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TurnResult> {
    this.profile.resolveModelContext();

    while (true) {
      let steps = 0;
      let stopReason: LoopTurnStopReason = 'end_turn';
      let activeStep: number | undefined;
      const loopControl = this.config.get<LoopControl>(LOOP_CONTROL_SECTION);
      let stopHookContinuationUsed = false;

      try {
        while (true) {
          signal.throwIfAborted();

          const maxSteps = loopControl?.maxStepsPerTurn;
          if (maxSteps !== undefined && maxSteps > 0 && steps >= maxSteps) {
            throw createMaxStepsExceededError(maxSteps);
          }

          steps += 1;
          activeStep = steps;
          const stepResult = await this.executeLoopStep(turnId, signal, steps);
          activeStep = undefined;

          if (stepResult.stopReason === 'tool_use') {
            continue;
          }

          stopReason = stepResult.stopReason;

          if (stepResult.continueTurn) {
            continue;
          }

          if (!stopHookContinuationUsed) {
            const reason = await this.externalHooks.triggerStop(signal, stopHookContinuationUsed);
            if (reason !== undefined) {
              stopHookContinuationUsed = true;
              this.appendImmediately({
                role: 'user',
                content: [{ type: 'text', text: reason }],
                toolCalls: [],
                origin: { kind: 'system_trigger', name: 'stop_hook' },
              });
              if (!hasStepBudgetRemaining(loopControl?.maxStepsPerTurn, steps)) {
                this.removeMatchedTailMessage(isStopHookMessage);
                break;
              }
              continue;
            }
          }

          break;
        }
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          this.emitStepInterrupted(turnId, activeStep, 'aborted');
          return { stopReason: 'aborted', steps };
        }

        const reason: LoopInterruptReason = isMaxStepsExceededError(error)
          ? 'max_steps'
          : 'error';
        this.emitStepInterrupted(turnId, activeStep, reason, errorMessage(error));

        if (isContextOverflowError(error)) {
          const context = { turnId, signal, error, handled: false };
          await this.hooks.onContextOverflow.run(context);
          if (context.handled) continue;
        }
        throw error;
      }

      return { stopReason, steps };
    }
  }

  private async executeLoopStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
  ): Promise<{
    readonly stopReason: LoopStepStopReason;
    readonly continueTurn: boolean;
  }> {
    await this.hooks.beforeStep.run({ turnId, signal });

    signal.throwIfAborted();

    const messages = [...this.projector.project(this.context.get())];
    signal.throwIfAborted();

    const stepUuid = randomUUID();
    const loopControl = this.config.get<LoopControl>(LOOP_CONTROL_SECTION);
    const emit = (event: AgentEvent): void => {
      this.events.emit(event);
    };

    emit({ type: 'turn.step.started', turnId, step: currentStep, stepId: stepUuid });

    const tools = this.toolRegistry
      .list()
      .filter((tool) => this.profile.isToolActive(tool.name, tool.source))
      .flatMap((toolInfo): ExecutableTool[] => {
        const tool = this.toolRegistry.resolve(toolInfo.name);
        return tool === undefined ? [] : [tool];
      });
    const emitToolCallDelta = createToolCallDeltaHandler(emit, turnId);
    const response = await this.llmRequester.request(
      {
        messages,
        tools,
        requestLogFields: { turnStep: `${turnId}.${String(currentStep)}` },
        retry: {
          maxAttempts: loopControl?.maxRetriesPerStep,
          onRetry: (retry) => {
            emit({
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
              ...(retry.statusCode !== undefined ? { statusCode: retry.statusCode } : {}),
            });
          },
        },
        usageContext: { type: 'turn', turnId },
      },
      (part) => this.emitStreamPart(turnId, emitToolCallDelta, part),
      signal,
    );

    if (hasAssistantMessage(response)) {
      this.appendImmediately({
        id: newMessageId(),
        role: 'assistant',
        content: response.message.content.map(cloneContentPart),
        toolCalls: response.message.toolCalls.map(cloneToolCall),
        ...(response.providerMessageId !== undefined
          ? { providerMessageId: response.providerMessageId }
          : {}),
      });
    }

    const usage = response.usage;
    const usageContext = {
      turnId,
      signal,
      usage,
      stepNumber: currentStep,
      stepUuid,
      toolCallCount: response.message.toolCalls.length,
      stopTurn: false,
    };
    await this.hooks.onStepUsage.run(usageContext);
    this.recordContextSize(usage);
    const stopReason = deriveStepStopReason(response);

    let effectiveStopReason: LoopStepStopReason =
      usageContext.stopTurn && stopReason === 'tool_use' ? 'end_turn' : stopReason;
    if (effectiveStopReason === 'tool_use') {
      const toolResults = await this.toolExecutor.execute(response.message.toolCalls, {
        signal,
        turnId,
        stepNumber: currentStep,
        stepUuid,
        dispatchProtocolEvent: emit,
        onToolResult: (toolCallId, result) => {
          const message = createToolMessage(toolCallId, toolResultOutputForModel(result));
          this.appendImmediately({
            ...message,
            role: 'tool',
            ...(result.isError !== undefined ? { isError: result.isError } : {}),
          });
        },
        onProgress: (toolCallId, update) => {
          emit({ type: 'tool.progress', turnId, toolCallId, update });
        },
      });
      if (toolResults.some((r) => r.stopTurn === true)) {
        effectiveStopReason = 'end_turn';
      }
    }

    signal.throwIfAborted();

    this.emitStepCompleted(turnId, currentStep, stepUuid, usage, effectiveStopReason, response);
    logStepTiming(this.log, turnId, currentStep, response);

    const afterStepContext = { turnId, signal, continueTurn: false };
    try {
      await this.hooks.afterStep.run(afterStepContext);
    } catch (error) {
      void error;
    }

    return {
      stopReason: effectiveStopReason,
      continueTurn: effectiveStopReason !== 'tool_use' && afterStepContext.continueTurn,
    };
  }

  private appendImmediately(...messages: ContextMessage[]): void {
    if (messages.length === 0) return;
    this.context.splice(this.context.get().length, 0, messages);
  }

  private removeMatchedTailMessage(matcher: (message: ContextMessage) => boolean): boolean {
    const history = this.context.get();
    const index = history.length - 1;
    const message = history[index];
    if (message === undefined || !matcher(message)) return false;
    this.context.splice(index, 1, []);
    return true;
  }

  private recordContextSize(usage: TokenUsage): void {
    const tokens = tokenUsageTotal(usage);
    if (tokens <= 0) return;
    this.contextSize.measured(this.context.get().length, tokens);
  }

  private emitStreamPart(
    turnId: number,
    emitToolCallDelta: (part: StreamedMessagePart) => void,
    part: StreamedMessagePart,
  ): void {
    switch (part.type) {
      case 'text':
        this.events.emit({ type: 'assistant.delta', turnId, delta: part.text });
        return;
      case 'think':
        this.events.emit({ type: 'thinking.delta', turnId, delta: part.think });
        return;
      case 'image_url':
      case 'audio_url':
      case 'video_url':
        return;
      case 'function':
      case 'tool_call_part':
        emitToolCallDelta(part);
        return;
      default: {
        const _exhaustive: never = part;
        return _exhaustive;
      }
    }
  }

  private emitStepCompleted(
    turnId: number,
    step: number,
    stepId: string,
    usage: TokenUsage,
    finishReason: LoopStepStopReason,
    response: LLMRequestFinish,
  ): void {
    // Provider diagnostics are omitted when the normalized finish reason already
    // matches the provider's, and surfaced only when they diverge.
    const normalFinish =
      (response.providerFinishReason === 'completed' && finishReason === 'end_turn') ||
      (response.providerFinishReason === 'tool_calls' && finishReason === 'tool_use');
    this.events.emit({
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
      providerFinishReason: normalFinish ? undefined : response.providerFinishReason,
      rawFinishReason: normalFinish ? undefined : response.rawFinishReason,
    });
  }

  private emitStepInterrupted(
    turnId: number,
    activeStep: number | undefined,
    reason: LoopInterruptReason,
    message?: string,
  ): void {
    if (activeStep === undefined) return;
    this.events.emit({
      type: 'turn.step.interrupted',
      turnId,
      step: activeStep,
      reason,
      ...(message !== undefined ? { message } : {}),
    });
  }
}

function isContextOverflowError(error: unknown): boolean {
  return (
    error instanceof APIContextOverflowError ||
    (isKimiError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW)
  );
}

function tokenUsageTotal(usage: TokenUsage): number {
  return usage.inputCacheRead + usage.inputCacheCreation + usage.inputOther + usage.output;
}

function cloneContentPart<T extends ContentPart>(part: T): T {
  return { ...part };
}

function cloneToolCall<T extends ToolCall>(toolCall: T): T {
  return { ...toolCall };
}

function toolResultOutputForModel(result: ToolResult): string | ContentPart[] {
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

function isStopHookMessage(message: ContextMessage): boolean {
  return message.origin?.kind === 'system_trigger' && message.origin.name === 'stop_hook';
}

function hasStepBudgetRemaining(maxSteps: number | undefined, currentStep: number): boolean {
  return maxSteps === undefined || maxSteps <= 0 || currentStep < maxSteps;
}

function hasAssistantMessage(response: LLMRequestFinish): boolean {
  return response.message.content.length > 0 || response.message.toolCalls.length > 0;
}

function deriveStepStopReason(response: LLMRequestFinish): LoopStepStopReason {
  switch (response.providerFinishReason) {
    case 'truncated':
      return 'max_tokens';
    case 'filtered':
      return 'filtered';
    case 'paused':
      return 'paused';
    case 'other':
      return 'unknown';
    case 'completed':
    case undefined:
      return response.message.toolCalls.length > 0 ? 'tool_use' : 'end_turn';
    case 'tool_calls':
      return response.message.toolCalls.length > 0 ? 'tool_use' : 'unknown';
    default: {
      const _exhaustive: never = response.providerFinishReason;
      return _exhaustive;
    }
  }
}

function createToolCallDeltaHandler(
  emitEvent: (event: AgentEvent) => void,
  turnId: number,
): (part: StreamedMessagePart) => void {
  const callsByIndex = new Map<number | string, ToolCallDeltaIdentity>();
  const pendingByIndex = new Map<number | string, string[]>();
  let lastToolCall: ToolCallDeltaIdentity | undefined;

  const emit = (
    toolCallId: string,
    name: string | undefined,
    argumentsPart: string | undefined,
  ): void => {
    emitEvent({
      type: 'tool.call.delta',
      turnId,
      toolCallId,
      name,
      argumentsPart,
    });
  };

  const toolCallIdFor = (
    part: Extract<StreamedMessagePart, { type: 'tool_call_part' }>,
  ): ToolCallDeltaIdentity | undefined => {
    if (part.index !== undefined) {
      return callsByIndex.get(part.index);
    }
    return lastToolCall;
  };

  return (part) => {
    if (isToolCall(part)) {
      const toolCall = { id: part.id, name: part.name };
      lastToolCall = toolCall;
      const index = part._streamIndex;
      if (index !== undefined) {
        callsByIndex.set(index, toolCall);
      }
      emit(toolCall.id, toolCall.name, undefined);
      if (index !== undefined) {
        const pending = pendingByIndex.get(index);
        if (pending !== undefined) {
          pendingByIndex.delete(index);
          for (const argumentsPart of pending) {
            emit(toolCall.id, toolCall.name, argumentsPart);
          }
        }
      }
      return;
    }
    if (!isToolCallPart(part)) return;
    if (part.argumentsPart === null) return;
    const toolCall = toolCallIdFor(part);
    if (toolCall === undefined) {
      if (part.index !== undefined) {
        const pending = pendingByIndex.get(part.index) ?? [];
        pending.push(part.argumentsPart);
        pendingByIndex.set(part.index, pending);
      }
      return;
    }
    emit(toolCall.id, toolCall.name, part.argumentsPart);
  };
}

interface ToolCallDeltaIdentity {
  readonly id: string;
  readonly name: string;
}

function logStepTiming(
  log: ILogService,
  turnId: number,
  currentStep: number,
  response: LLMRequestFinish,
): void {
  const timing = response.timing;
  if (timing === undefined) return;
  const payload: {
    turnStep: string;
    ttftMs: number;
    requestBuildMs?: number;
    serverFirstTokenMs?: number;
    streamDurationMs: number;
    serverDecodeMs?: number;
    clientConsumeMs?: number;
    outputTokens: number;
  } = {
    turnStep: `${turnId}.${String(currentStep)}`,
    ttftMs: timing.firstTokenLatencyMs,
    streamDurationMs: timing.streamDurationMs,
    outputTokens: response.usage.output,
  };
  if (timing.requestBuildMs !== undefined) payload.requestBuildMs = timing.requestBuildMs;
  if (timing.serverFirstTokenMs !== undefined) {
    payload.serverFirstTokenMs = timing.serverFirstTokenMs;
  }
  if (timing.serverDecodeMs !== undefined) payload.serverDecodeMs = timing.serverDecodeMs;
  if (timing.clientConsumeMs !== undefined) payload.clientConsumeMs = timing.clientConsumeMs;
  log.info('llm response', payload);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopService,
  AgentLoopService,
  InstantiationType.Delayed,
  'loop',
);
