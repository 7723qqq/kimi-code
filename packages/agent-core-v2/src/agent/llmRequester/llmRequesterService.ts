import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { errorFromLlmMessage } from '#/llm-adapter/contract/errors';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { AssistantMessage } from '@moonshot-ai/core/llm/message';
import type { LlmOutcome, LlmRunEvent } from '@moonshot-ai/core/llm/response';
import { emptyUsage } from '@moonshot-ai/core/llm/usage';

import {
  IAgentLLMRequesterService,
  type AgentLLMRequestAttemptFailure,
  type AgentLLMRequestFinish,
  type AgentLLMRequestOverrides,
  type AgentLLMRequestPartHandler,
  type AgentLLMRequestSource,
  type AgentLLMRequestTask,
} from './llmRequester';

const noopOnPart: AgentLLMRequestPartHandler = () => {};

export class AgentLLMRequesterService implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
  ) {}

  async request(
    overrides: AgentLLMRequestOverrides = {},
    onPart: AgentLLMRequestPartHandler = noopOnPart,
    signal?: AbortSignal,
  ): Promise<AgentLLMRequestFinish> {
    return this.start(overrides, onPart, signal).result;
  }

  start(
    overrides: AgentLLMRequestOverrides = {},
    onPart: AgentLLMRequestPartHandler = noopOnPart,
    signal?: AbortSignal,
  ): AgentLLMRequestTask {
    const trace = new MutableLLMRequestTrace();
    let attemptFailure: AgentLLMRequestAttemptFailure | undefined;
    return {
      trace,
      result: this.run(trace, overrides, onPart, signal, (failure) => {
        attemptFailure = failure;
      }),
      attemptFailure: () => attemptFailure,
    };
  }

  private async run(
    trace: MutableLLMRequestTrace,
    overrides: AgentLLMRequestOverrides,
    onPart: AgentLLMRequestPartHandler,
    signal: AbortSignal | undefined,
    onAttemptFailure: (failure: AgentLLMRequestAttemptFailure) => void,
  ): Promise<AgentLLMRequestFinish> {
    signal?.throwIfAborted();
    const operationSignal = signal ?? new AbortController().signal;
    const source: AgentLLMRequestSource = overrides.source ?? { type: 'operation' };
    const requester = await this.loop.requester.prepareOperation(
      {
        source: () => source,
        maxOutputSize: overrides.maxOutputSize,
        tools: overrides.tools,
        promptCacheProbe: overrides.promptCacheProbe,
        onTrace: (observed) => {
          trace.requestId = observed.requestId;
        },
      },
      operationSignal,
    );

    let parts: Promise<void> = Promise.resolve();
    const outcome = await requester.generate(
      {
        content: {
          messages: overrides.messages ?? this.context.get(),
          ...(overrides.usedContextTokens === undefined
            ? {}
            : { usedTokens: overrides.usedContextTokens }),
        },
        profile: {
          systemPrompt: overrides.systemPrompt ?? this.profile.getSystemPrompt(),
          ...(overrides.tools === undefined ? {} : { tools: overrides.tools }),
        },
      },
      {
        signal: operationSignal,
        onEvent: (event) => {
          if (event.type === 'llm.streaming.request_id') {
            trace.requestId = event.requestId;
          }
          if (event.type === 'llm.streaming.part') {
            const part = event.part;
            parts = parts.then(() => onPart(part));
          }
          this.recordAttempt(event, onAttemptFailure, overrides.onAttemptRetry);
        },
      },
    );
    await parts;

    if (outcome.type === 'failed') {
      throw errorFromLlmMessage(outcome.error, outcome.diagnostics);
    }
    if (outcome.type === 'aborted') {
      const message =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : 'The operation was aborted.';
      throw new DOMException(message, 'AbortError');
    }
    return finishOf(outcome, this.profile.getModel());
  }

  private recordAttempt(
    event: LlmRunEvent,
    onAttemptFailure: (failure: AgentLLMRequestAttemptFailure) => void,
    onAttemptRetry: (() => void) | undefined,
  ): void {
    if (event.type !== 'llm.retrying') return;
    onAttemptFailure({
      usage: event.usage,
      messageId: event.messageId,
      timing: event.timing,
    });
    onAttemptRetry?.();
  }
}

class MutableLLMRequestTrace implements LLMRequestTrace {
  requestId: string | undefined;
}

function finishOf(
  outcome: Extract<LlmOutcome, { type: 'done' }>,
  model: string,
): AgentLLMRequestFinish {
  const message: AssistantMessage = outcome.message;
  return {
    message,
    usage: outcome.usage ?? emptyUsage(),
    model,
    providerFinishReason: outcome.finish?.finishReason ?? undefined,
    rawFinishReason: outcome.finish?.rawFinishReason ?? undefined,
    providerMessageId: outcome.messageId,
    timing: outcome.timing,
    traceId: outcome.requestId,
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLLMRequesterService,
  AgentLLMRequesterService,
  ScopeActivation.OnScopeCreated,
  'llmRequester',
);
