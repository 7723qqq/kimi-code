/**
 * `llmRequester` domain (L3) — `IAgentLLMRequesterService` implementation.
 *
 * Assembles one LLM request from `profile` (provider / system prompt),
 * `contextMemory` + `contextProjector` (history), and `toolRegistry` (tools),
 * resolves request authorization through `modelRuntime` `ISessionModelResolver`, drives
 * `@moonshot-ai/kosong` `generate()`, and logs each request through
 * `llmRequestLog`. Bound at Agent scope.
 */

import {
  emptyUsage,
  generate,
  isRetryableGenerateError,
  type ChatProvider,
  type GenerateCallbacks,
  type Message,
  type ProviderRequestAuth,
  type StreamDecodeStats,
  type Tool as KosongTool,
} from '@moonshot-ai/kosong';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { ISessionModelResolver } from '#/session/modelRuntime';
import {
  applyCompletionBudget,
  resolveCompletionBudget,
} from '#/_base/utils/completion-budget';
import { IConfigService } from '#/app/config';
import type { KimiModelOverrides } from '#/app/chatProvider';
import { ILogService } from '#/app/log';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentContextProjectorService } from '#/agent/contextProjector';
import { IAgentContextSizeService } from '#/agent/contextSize';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import type { LLMRequestFinish, LLMRequestOverrides, LLMRequestPartHandler } from './index';
import { IAgentLLMRequestLogService } from '#/agent/llmRequestLog';
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

export class AgentLLMRequesterService implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentLLMRequestLogService private readonly requestLog: IAgentLLMRequestLogService,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @ISessionModelResolver private readonly modelResolver: ISessionModelResolver,
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
    let requestStartedAt = Date.now();
    let requestSentAt: number | undefined;
    let firstChunkAt: number | undefined;
    let streamEndedAt: number | undefined;
    let decodeStats: StreamDecodeStats | undefined;
    let streamedAnyPart = false;
    const callbacks: GenerateCallbacks = {
      onMessagePart: async (part) => {
        firstChunkAt ??= Date.now();
        streamedAnyPart = true;
        await onPart(part);
      },
    };
    const run = async (auth: ProviderRequestAuth | undefined): Promise<LLMRequestFinish> => {
      requestStartedAt = Date.now();
      requestSentAt = undefined;
      firstChunkAt = undefined;
      streamEndedAt = undefined;
      decodeStats = undefined;
      streamedAnyPart = false;
      this.requestLog.logRequest({
        provider: request.provider,
        modelAlias: request.modelAlias,
        systemPrompt: request.systemPrompt,
        tools: request.tools,
        messages: request.messages,
        fields: request.requestLogFields,
      });
      const result = await request.generate(
        request.provider,
        request.systemPrompt,
        [...request.tools],
        request.messages,
        callbacks,
        {
          signal,
          auth,
          onRequestStart: () => {
            requestStartedAt = Date.now();
          },
          onRequestSent: () => {
            requestSentAt = Date.now();
          },
          onStreamEnd: (stats) => {
            streamEndedAt = Date.now();
            decodeStats = stats;
          },
        },
      );
      // Providers that resolve the whole response at once (rather than
      // streaming through `onMessagePart`) still carry their content on
      // `result.message`. Surface it as parts so downstream consumers (e.g.
      // compaction summary collection) observe the content, matching the
      // legacy path that read `response.message.content` directly.
      if (!streamedAnyPart) {
        for (const part of result.message.content) {
          firstChunkAt ??= Date.now();
          await onPart(part);
        }
        for (const toolCall of result.message.toolCalls) {
          firstChunkAt ??= Date.now();
          await onPart(toolCall);
        }
      }
      const usage = result.usage ?? emptyUsage();
      const usageModel = request.modelAlias ?? request.provider.modelName;
      this.usage.record(usageModel, usage, request.usageContext);
      return {
        message: result.message,
        usage,
        model: usageModel,
        providerFinishReason: result.finishReason ?? undefined,
        rawFinishReason: result.rawFinishReason ?? undefined,
        providerMessageId: result.id ?? undefined,
        timing:
          firstChunkAt === undefined
            ? undefined
            : buildStreamTiming(
                requestStartedAt,
                requestSentAt,
                firstChunkAt,
                streamEndedAt,
                decodeStats,
              ),
      };
    };
    const withAuth = this.resolveAuth(request.modelAlias);
    if (withAuth === undefined) {
      return await run(undefined);
    }
    return await withAuth((auth) => run(auth));
  }

  private resolveRequest(overrides: LLMRequestOverrides): ResolvedLLMRequest {
    const resolved = this.profile.resolveModelContext();
    const providerWithEnv = this.profile.getProvider();
    const provider = applyCompletionBudget({
      provider: providerWithEnv,
      budget: resolveCompletionBudget({
        maxOutputSize: overrides.maxOutputSize ?? resolved.maxOutputSize,
        reservedContextSize: resolved.reservedContextSize,
        maxCompletionTokensCap: this.config.get<KimiModelOverrides>('modelOverrides')?.maxCompletionTokens,
      }),
      capability: resolved.modelCapabilities,
      usedContextTokens: this.contextSize.getStatus().contextTokens,
    });

    return {
      provider,
      modelAlias: resolved.modelAlias,
      systemPrompt: overrides.systemPrompt ?? this.profile.getSystemPrompt(),
      tools: [...(overrides.tools ?? this.defaultTools())],
      messages: [...(overrides.messages ?? this.projector.project(this.context.get()))],
      requestLogFields: overrides.requestLogFields,
      usageContext: overrides.usageContext,
      generate,
    };
  }

  private resolveAuth(modelAlias: string) {
    return this.modelResolver.resolveAuth?.(modelAlias);
  }

  private defaultTools(): readonly KosongTool[] {
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

export function buildStreamTiming(
  requestStartedAt: number,
  requestSentAt: number | undefined,
  firstChunkAt: number,
  streamEndedAt: number | undefined,
  decodeStats: StreamDecodeStats | undefined,
): {
  firstTokenLatencyMs: number;
  streamDurationMs: number;
  requestBuildMs?: number;
  serverFirstTokenMs?: number;
  serverDecodeMs?: number;
  clientConsumeMs?: number;
} {
  const outputEndedAt = streamEndedAt ?? Date.now();
  const timing: {
    firstTokenLatencyMs: number;
    streamDurationMs: number;
    requestBuildMs?: number;
    serverFirstTokenMs?: number;
    serverDecodeMs?: number;
    clientConsumeMs?: number;
  } = {
    firstTokenLatencyMs: Math.max(0, firstChunkAt - requestStartedAt),
    streamDurationMs: Math.max(0, outputEndedAt - firstChunkAt),
  };
  if (requestSentAt !== undefined) {
    const sentAt = Math.min(Math.max(requestSentAt, requestStartedAt), firstChunkAt);
    timing.requestBuildMs = sentAt - requestStartedAt;
    timing.serverFirstTokenMs = firstChunkAt - sentAt;
  }
  if (decodeStats !== undefined) {
    timing.serverDecodeMs = Math.max(0, decodeStats.serverDecodeMs);
    timing.clientConsumeMs = Math.max(0, decodeStats.clientConsumeMs);
  }
  return timing;
}

interface ResolvedLLMRequest {
  readonly provider: ChatProvider;
  readonly modelAlias: string;
  readonly systemPrompt: string;
  readonly tools: readonly KosongTool[];
  readonly messages: Message[];
  readonly requestLogFields: LLMRequestOverrides['requestLogFields'];
  readonly usageContext: LLMRequestOverrides['usageContext'];
  readonly generate: typeof generate;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLLMRequesterService,
  AgentLLMRequesterService,
  InstantiationType.Delayed,
  'llmRequester',
);
