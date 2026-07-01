/**
 * Executes one provider step.
 *
 * A step owns the provider call, atomic transcript envelope, streaming callback
 * wiring, tool-call lifecycle, and post-step hooks. Provider usage is recorded
 * immediately after `llm.chat` returns so a later abort during tool execution
 * does not lose model usage that was already spent.
 */

import { randomUUID } from 'node:crypto';

import type { TokenUsage } from '@moonshot-ai/kosong';
import type { ILogger as Logger } from '#/log';

import type { IAgentToolExecutorService } from '#/toolExecutor';
import type { LoopEventDispatcher } from './events';
import type { LLM, LLMChatParams, LLMChatResponse } from './llm';
import { chatWithRetry } from './retry';
import type { ExecutableTool } from '#/tool';
import type {
  LoopHooks,
  LoopMessageBuilder,
  LoopStepStopReason,
  RecordStepUsageContext,
  RecordStepUsageResult,
} from './types';

type ChatStreamingCallbacks = Pick<
  LLMChatParams,
  'onTextDelta' | 'onThinkDelta' | 'onToolCallDelta' | 'onTextPart' | 'onThinkPart'
>;

export interface ExecuteLoopStepDeps {
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly buildMessages: LoopMessageBuilder;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly llm: LLM;
  readonly tools?: readonly ExecutableTool[] | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: Logger | undefined;
  readonly currentStep: number;
  readonly maxRetryAttempts?: number;
  readonly toolExecutor: IAgentToolExecutorService;
  readonly recordUsage: (
    usage: TokenUsage,
    context: RecordStepUsageContext,
  ) => RecordStepUsageResult | void | Promise<RecordStepUsageResult | void>;
}

export async function executeLoopStep(deps: ExecuteLoopStepDeps): Promise<{
  readonly usage: TokenUsage;
  readonly stopReason: LoopStepStopReason;
}> {
  const {
    turnId,
    signal,
    buildMessages,
    dispatchEvent,
    llm,
    tools,
    hooks,
    log,
    currentStep,
    maxRetryAttempts,
    toolExecutor,
    recordUsage,
  } = deps;

  if (hooks?.beforeStep !== undefined) {
    const beforeStep = await hooks.beforeStep({
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
    if (beforeStep?.block === true) {
      throw new Error(beforeStep.reason ?? `Step ${String(currentStep)} was blocked`);
    }
  }

  signal.throwIfAborted();

  const messages = await buildMessages();
  signal.throwIfAborted();

  const stepUuid = randomUUID();

  await dispatchEvent({
    type: 'step.begin',
    uuid: stepUuid,
    turnId,
    step: currentStep,
  });

  const chatParams: LLMChatParams = {
    messages,
    tools: tools ?? [],
    signal,
    ...createChatStreamingCallbacks({
      dispatchEvent,
      turnId,
      currentStep,
      stepUuid,
    }),
  };
  const response: LLMChatResponse = await chatWithRetry({
    llm,
    params: chatParams,
    dispatchEvent,
    turnId,
    currentStep,
    stepUuid,
    maxAttempts: maxRetryAttempts,
    log,
  });
  const usage = response.usage;
  const usageResult = await recordUsage(usage, {
    turnId,
    stepNumber: currentStep,
    stepUuid,
    toolCallCount: response.toolCalls.length,
  });
  const stopTurnAfterUsage = usageResult?.stopTurn === true;
  const stopReason = deriveStepStopReason(response);

  // Execute tools only when the normalized response shape represents a tool
  // step. Provider terminal diagnostics such as filtering or truncation must
  // not trigger side-effecting tool execution even if a malformed response also
  // contains tool calls.
  let effectiveStopReason: LoopStepStopReason =
    stopTurnAfterUsage && stopReason === 'tool_use' ? 'end_turn' : stopReason;
  if (effectiveStopReason === 'tool_use') {
      const toolResults = await toolExecutor.execute(response.toolCalls, {
        signal,
        turnId,
        stepNumber: currentStep,
        stepUuid,
        dispatchEvent,
        onProgress: (toolCallId, update) => {
          void dispatchEvent({ type: 'tool.progress', toolCallId, update });
      },
    });
    if (toolResults.some((r) => r.stopTurn === true)) {
      effectiveStopReason = 'end_turn';
    }
  }

  // When a tool batch runs, it drains paired `tool.result` events even when
  // cancellation is requested. Check the signal here before sealing the step.
  signal.throwIfAborted();

  await dispatchEvent({
    type: 'step.end',
    uuid: stepUuid,
    turnId,
    step: currentStep,
    usage,
    finishReason: effectiveStopReason,
    llmFirstTokenLatencyMs: response.streamTiming?.firstTokenLatencyMs,
    llmStreamDurationMs: response.streamTiming?.streamDurationMs,
    llmRequestBuildMs: response.streamTiming?.requestBuildMs,
    llmServerFirstTokenMs: response.streamTiming?.serverFirstTokenMs,
    llmServerDecodeMs: response.streamTiming?.serverDecodeMs,
    llmClientConsumeMs: response.streamTiming?.clientConsumeMs,
    providerMessageId: response.providerMessageId,
    ...stepEndProviderDiagnostics(response, effectiveStopReason),
  });

  logStepTiming(log, turnId, currentStep, response);

  let stopTurnAfterStep = stopTurnAfterUsage;
  if (hooks?.afterStep !== undefined) {
    try {
      const afterStep = await hooks.afterStep({
        turnId,
        stepNumber: currentStep,
        usage,
        stopReason: effectiveStopReason,
        signal,
        llm,
      });
      stopTurnAfterStep = stopTurnAfterStep || afterStep?.stopTurn === true;
    } catch {
      // The step is already sealed; observer hooks cannot change the result.
    }
  }

  return {
    usage,
    stopReason:
      stopTurnAfterStep && effectiveStopReason === 'tool_use' ? 'end_turn' : effectiveStopReason,
  };
}

/**
 * Emit a per-step completion log with the LLM response timing. TTFT is split
 * into the client-side request-build portion and the network + API-server
 * portion, and the decode window is split into server (awaiting parts) vs.
 * client (processing parts) time, so slow turns can be attributed without
 * parsing the wire log. Split components are omitted when the provider did not
 * report the corresponding boundary.
 */
function logStepTiming(
  log: Logger | undefined,
  turnId: string,
  currentStep: number,
  response: LLMChatResponse,
): void {
  if (log === undefined) return;
  const timing = response.streamTiming;
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

function deriveStepStopReason(response: LLMChatResponse): LoopStepStopReason {
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
      return response.toolCalls.length > 0 ? 'tool_use' : 'end_turn';
    case 'tool_calls':
      return response.toolCalls.length > 0 ? 'tool_use' : 'unknown';
    default: {
      const _exhaustive: never = response.providerFinishReason;
      return _exhaustive;
    }
  }
}

function stepEndProviderDiagnostics(
  response: LLMChatResponse,
  stopReason: LoopStepStopReason,
): Pick<LLMChatResponse, 'providerFinishReason' | 'rawFinishReason'> {
  const providerFinishReason = response.providerFinishReason;
  if (
    (providerFinishReason === 'completed' && stopReason === 'end_turn') ||
    (providerFinishReason === 'tool_calls' && stopReason === 'tool_use')
  ) {
    return {};
  }

  return {
    ...(providerFinishReason !== undefined ? { providerFinishReason } : {}),
    ...(response.rawFinishReason !== undefined
      ? { rawFinishReason: response.rawFinishReason }
      : {}),
  };
}

function createChatStreamingCallbacks(deps: {
  readonly dispatchEvent: LoopEventDispatcher;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
}): ChatStreamingCallbacks {
  const { dispatchEvent, turnId, currentStep, stepUuid } = deps;

  return {
    onTextDelta: (delta) => {
      dispatchEvent({ type: 'text.delta', delta });
    },
    onThinkDelta: (delta) => {
      dispatchEvent({ type: 'thinking.delta', delta });
    },
    onToolCallDelta: (delta) => {
      dispatchEvent({
        type: 'tool.call.delta',
        toolCallId: delta.toolCallId,
        name: delta.name,
        argumentsPart: delta.argumentsPart,
      });
    },
    onTextPart: async (part) => {
      await dispatchEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId,
        step: currentStep,
        stepUuid,
        part,
      });
    },
    onThinkPart: async (part) => {
      await dispatchEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId,
        step: currentStep,
        stepUuid,
        part,
      });
    },
  };
}
