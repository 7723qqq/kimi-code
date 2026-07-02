/**
 * `llmRequester` domain (L3) — `IAgentLLMRequesterService` implementation.
 *
 * Thin shell over the god-object `Model` (App scope). Assembles per-turn
 * `LLMRequestInput` from `profile` (system prompt), `contextMemory` +
 * `contextProjector` (history), and `toolRegistry` (tools), applies the
 * completion-token budget, then drives `model.request(input, signal)` with
 * bounded retry. Forwards streamed `part` events to the caller's `onPart`
 * handler, records `usage` through `IAgentUsageService`, resolves to an
 * `LLMRequestFinish` on the `finish` event, and logs the outbound request
 * (config deduplicated by content, plus per-request fields) through `log`.
 * Bound at Agent scope.
 */

import { createHash } from 'node:crypto';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  applyCompletionBudget,
  resolveCompletionBudget,
} from '#/app/model/completionBudget';
import {
  emptyUsage,
  isRetryableGenerateError,
  type Message,
  type ThinkingEffort,
  type Tool,
} from '#/app/llmProtocol';
import type { Protocol } from '#/app/protocol';
import { IConfigService } from '#/app/config';
import type { KimiModelOverrides, Model, ModelRequestEvent } from '#/app/model';
import { ILogService } from '#/app/log';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentContextProjectorService } from '#/agent/contextProjector';
import { IAgentContextSizeService } from '#/agent/contextSize';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import type {
  LLMRequestFinish,
  LLMRequestLogFields,
  LLMRequestOverrides,
  LLMRequestPartHandler,
  LLMStreamTiming,
} from './index';
import { IAgentUsageService } from '#/agent/usage';
import { IAgentLLMRequesterService } from './llmRequester';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  isAbortError,
  retryBackoffDelays,
  retryErrorFields,
  sleepForRetry,
} from './retry';

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

const noopOnPart: LLMRequestPartHandler = () => {};

interface ResolvedLLMRequest {
  readonly model: Model;
  readonly modelAlias: string;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: Message[];
  readonly requestLogFields: LLMRequestOverrides['requestLogFields'];
  readonly usageContext: LLMRequestOverrides['usageContext'];
}

interface LLMRequestLogInput {
  readonly protocol: Protocol;
  readonly modelName: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: ThinkingEffort | null;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly fields?: LLMRequestLogFields;
}

export class AgentLLMRequesterService implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;

  private lastConfigLogSignature: string | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
  ) {}

  async request(
    overrides: LLMRequestOverrides = {},
    onPart: LLMRequestPartHandler = noopOnPart,
    signal?: AbortSignal,
  ): Promise<LLMRequestFinish> {
    signal?.throwIfAborted();
    return await this.requestWithRetry(overrides, onPart, signal);
  }

  private async requestWithRetry(
    overrides: LLMRequestOverrides,
    onPart: LLMRequestPartHandler,
    signal: AbortSignal | undefined,
  ): Promise<LLMRequestFinish> {
    const maxAttempts = Math.max(overrides.retry?.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS, 1);

    if (maxAttempts <= 1) {
      try {
        return await this.executeRequestAttempt(overrides, onPart, signal, 1, maxAttempts);
      } catch (error) {
        this.logRequestFailure(error, overrides, signal, 1, maxAttempts);
        throw error;
      }
    }

    const delays = retryBackoffDelays(maxAttempts);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.executeRequestAttempt(overrides, onPart, signal, attempt, maxAttempts);
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableGenerateError(error)) {
          this.logRequestFailure(error, overrides, signal, attempt, maxAttempts);
          throw error;
        }

        signal?.throwIfAborted();
        const delayMs = delays[attempt - 1] ?? 0;
        await overrides.retry?.onRetry?.({
          failedAttempt: attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          delayMs,
          ...retryErrorFields(error),
        });
        await sleepForRetry(delayMs, signal);
      }
    }
  }

  private async executeRequestAttempt(
    overrides: LLMRequestOverrides,
    onPart: LLMRequestPartHandler,
    signal: AbortSignal | undefined,
    attempt: number,
    maxAttempts: number,
  ): Promise<LLMRequestFinish> {
    signal?.throwIfAborted();
    const request = this.resolveRequest(requestOverridesForAttempt(overrides, attempt, maxAttempts));
    return await this.runRequest(request, onPart, signal);
  }

  private logRequestFailure(
    error: unknown,
    overrides: LLMRequestOverrides,
    signal: AbortSignal | undefined,
    attempt: number,
    maxAttempts: number,
  ): void {
    if (isAbortError(error) || signal?.aborted === true) return;
    const payload: {
      turnStep?: string;
      attempt: string;
      model: string;
      errorName: string;
      errorMessage: string;
      statusCode?: number;
    } = {
      attempt: `${String(attempt)}/${String(maxAttempts)}`,
      model: this.profile.data().modelAlias ?? 'unknown',
      ...retryErrorFields(error),
    };
    if (overrides.requestLogFields?.turnStep !== undefined) {
      payload.turnStep = overrides.requestLogFields.turnStep;
    }
    this.log.warn('llm request failed', payload);
  }

  private async runRequest(
    request: ResolvedLLMRequest,
    onPart: LLMRequestPartHandler,
    signal: AbortSignal | undefined,
  ): Promise<LLMRequestFinish> {
    this.logRequest({
      protocol: request.model.protocol,
      modelName: request.model.name,
      modelAlias: request.modelAlias,
      thinkingEffort: request.model.thinkingEffort,
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      messages: request.messages,
      fields: request.requestLogFields,
    });

    const input = {
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      messages: request.messages,
    };

    let message: Message | undefined;
    let usage = emptyUsage();
    let timing: LLMStreamTiming | undefined;
    let finish: Extract<ModelRequestEvent, { type: 'finish' }> | undefined;

    for await (const event of request.model.request(input, signal)) {
      switch (event.type) {
        case 'part':
          await onPart(event.part);
          break;
        case 'usage':
          usage = event.usage;
          break;
        case 'finish':
          finish = event;
          message = event.message;
          break;
        case 'timing': {
          const { type: _type, ...streamTiming } = event;
          timing = streamTiming;
          break;
        }
      }
    }

    if (message === undefined || finish === undefined) {
      throw new Error('LLM request stream ended without a finish event.');
    }

    const usageModel = request.modelAlias;
    this.usage.record(usageModel, usage, request.usageContext);

    return {
      message,
      usage,
      model: usageModel,
      providerFinishReason: finish.providerFinishReason,
      rawFinishReason: finish.rawFinishReason,
      providerMessageId: finish.id,
      timing,
    };
  }

  private resolveRequest(overrides: LLMRequestOverrides): ResolvedLLMRequest {
    const resolved = this.profile.resolveModelContext();
    let model = this.profile.getProvider();
    model = applyCompletionBudget({
      model,
      budget: resolveCompletionBudget({
        maxOutputSize: overrides.maxOutputSize ?? resolved.maxOutputSize,
        reservedContextSize: resolved.reservedContextSize,
        maxCompletionTokensCap:
          this.config.get<KimiModelOverrides>('modelOverrides')?.maxCompletionTokens,
      }),
      capability: resolved.modelCapabilities,
      usedContextTokens: this.contextSize.getStatus().contextTokens,
    });

    return {
      model,
      modelAlias: resolved.modelAlias,
      systemPrompt: overrides.systemPrompt ?? this.profile.getSystemPrompt(),
      tools: [...(overrides.tools ?? this.defaultTools())],
      messages: [...(overrides.messages ?? this.projector.project(this.context.get()))],
      requestLogFields: overrides.requestLogFields,
      usageContext: overrides.usageContext,
    };
  }

  private logRequest(input: LLMRequestLogInput): void {
    const requestLogFields = input.fields ?? {};
    const config = {
      provider: input.protocol,
      model: input.modelName,
      modelAlias: input.modelAlias,
      thinkingEffort: input.thinkingEffort ?? undefined,
      systemPromptChars: input.systemPrompt.length,
      toolCount: input.tools.length,
    };
    const signature = JSON.stringify({
      ...config,
      systemPromptHash: fingerprint(input.systemPrompt),
      toolsHash: fingerprint(JSON.stringify(toolSignature(input.tools))),
    });
    if (signature !== this.lastConfigLogSignature) {
      this.lastConfigLogSignature = signature;
      this.log.info('llm config', { ...requestLogFields, ...config });
    }

    const partialMessageCount = input.messages.filter(
      (message) => message.partial === true,
    ).length;
    const requestFields: {
      turnStep?: string;
      attempt?: string;
      partialMessageCount?: number;
    } = { ...requestLogFields };
    if (partialMessageCount > 0) requestFields.partialMessageCount = partialMessageCount;
    this.log.info('llm request', requestFields);
  }

  private defaultTools(): readonly Tool[] {
    return this.tools
      .list()
      .filter((tool) => this.profile.isToolActive(tool.name, tool.source))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
      }));
  }
}

function requestOverridesForAttempt(
  overrides: LLMRequestOverrides,
  attempt: number,
  maxAttempts: number,
): LLMRequestOverrides {
  if (attempt === 1 || overrides.requestLogFields === undefined) {
    return overrides;
  }
  return {
    ...overrides,
    requestLogFields: {
      ...overrides.requestLogFields,
      attempt: `${String(attempt)}/${String(maxAttempts)}`,
    },
  };
}

function toolSignature(tools: readonly Tool[]) {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLLMRequesterService,
  AgentLLMRequesterService,
  InstantiationType.Delayed,
  'llmRequester',
);
