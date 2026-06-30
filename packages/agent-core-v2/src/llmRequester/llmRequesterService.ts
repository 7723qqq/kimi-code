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
  type ChatProvider,
  type GenerateCallbacks,
  type Message,
  type ProviderRequestAuth,
  type Tool as KosongTool,
} from '@moonshot-ai/kosong';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { ISessionModelResolver } from '#/modelRuntime';
import {
  applyCompletionBudget,
  resolveCompletionBudget,
} from "#/_base/utils/completion-budget";
import { IConfigService } from '#/config';
import type { KimiModelOverrides } from '#/chatProvider';
import { IAgentProfileService } from '#/profile';
import { IAgentContextMemoryService } from '#/contextMemory';
import { IAgentContextProjectorService } from '#/contextProjector';
import { IAgentToolRegistryService } from '#/toolRegistry';
import type { LLMEvent, LLMRequestOverrides } from '.';
import { IAgentLLMRequestLogService } from '#/llmRequestLog';
import { IAgentUsageService } from '#/usage';
import { AsyncEventQueue } from './asyncEventQueue';
import { IAgentLLMRequesterService } from './llmRequester';

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

export class AgentLLMRequesterService implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentLLMRequestLogService private readonly requestLog: IAgentLLMRequestLogService,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @ISessionModelResolver private readonly modelResolver: ISessionModelResolver,
    @IConfigService private readonly config: IConfigService,
  ) {}

  request(
    overrides: LLMRequestOverrides = {},
    signal?: AbortSignal,
  ): AsyncIterable<LLMEvent> {
    return this.requestStream(overrides, signal);
  }

  private async *requestStream(
    overrides: LLMRequestOverrides,
    signal: AbortSignal | undefined,
  ): AsyncIterable<LLMEvent> {
    signal?.throwIfAborted();
    const request = this.resolveRequest(overrides);
    const queue = new AsyncEventQueue<LLMEvent>();
    void this.runRequest(request, signal, queue).then(
      () => queue.end(),
      (error: unknown) => queue.fail(error),
    );
    yield* queue;
  }

  private async runRequest(
    request: ResolvedLLMRequest,
    signal: AbortSignal | undefined,
    queue: AsyncEventQueue<LLMEvent>,
  ): Promise<void> {
    let requestStartedAt = Date.now();
    let firstChunkAt: number | undefined;
    let streamEndedAt: number | undefined;
    let streamedAnyPart = false;
    const callbacks: GenerateCallbacks = {
      onMessagePart: (part) => {
        firstChunkAt ??= Date.now();
        streamedAnyPart = true;
        queue.push({ type: 'part', part });
      },
    };
    const run = async (auth: ProviderRequestAuth | undefined): Promise<void> => {
      requestStartedAt = Date.now();
      firstChunkAt = undefined;
      streamEndedAt = undefined;
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
          onStreamEnd: () => {
            streamEndedAt = Date.now();
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
          queue.push({ type: 'part', part });
        }
      }
      const usage = result.usage ?? emptyUsage();
      const usageModel = request.modelAlias ?? request.provider.modelName;
      queue.push({
        type: 'usage',
        usage,
        model: usageModel,
      });
      this.usage.record(usageModel, usage, request.usageContext);
      queue.push({
        type: 'finish',
        providerFinishReason: result.finishReason ?? undefined,
        rawFinishReason: result.rawFinishReason ?? undefined,
        id: result.id ?? undefined,
      });
      if (firstChunkAt !== undefined) {
        const outputEndedAt = streamEndedAt ?? Date.now();
        queue.push({
          type: 'timing',
          firstTokenLatencyMs: Math.max(0, firstChunkAt - requestStartedAt),
          streamDurationMs: Math.max(0, outputEndedAt - firstChunkAt),
        });
      }
    };
    const withAuth = this.resolveAuth(request.modelAlias);
    if (withAuth === undefined) {
      await run(undefined);
      return;
    }
    await withAuth((auth) => run(auth));
  }

  private resolveRequest(overrides: LLMRequestOverrides): ResolvedLLMRequest {
    const resolved = this.profile.resolveModelContext();
    const providerWithEnv = this.profile.getProvider();
    const provider = applyCompletionBudget({
      provider: providerWithEnv,
      budget: resolveCompletionBudget({
        maxOutputSize: resolved.maxOutputSize,
        reservedContextSize: resolved.reservedContextSize,
        maxCompletionTokensCap: this.config.get<KimiModelOverrides>('modelOverrides')?.maxCompletionTokens,
      }),
      capability: resolved.modelCapabilities,
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
