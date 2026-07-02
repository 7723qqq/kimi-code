/**
 * `llmRequester` domain (L3) — `IAgentLLMRequesterService` implementation.
 *
 * Thin shell over the god-object `Model` (App scope). Assembles per-turn
 * `LLMRequestInput` from `profile` (system prompt), `contextMemory` +
 * `contextProjector` (history), and `toolRegistry` (tools), applies the
 * completion-token budget through `.withMaxCompletionTokens`, then drives
 * `model.request(input, signal)`. Emits `LLMEvent`s straight through while
 * intercepting `usage` for `IAgentUsageService` accounting and logging the
 * outbound request (config, deduplicated by content, plus per-request fields)
 * through `log`. Bound at Agent scope.
 */

import { createHash } from 'node:crypto';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  applyCompletionBudget,
  resolveCompletionBudget,
} from '#/app/model/completionBudget';
import type { Message, ThinkingEffort, Tool } from '#/app/llmProtocol';
import type { Protocol } from '#/app/protocol';
import { IConfigService } from '#/app/config';
import { type KimiModelOverrides } from '#/app/model';
import { ILogService } from '#/app/log';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentContextProjectorService } from '#/agent/contextProjector';
import { IAgentContextSizeService } from '#/agent/contextSize';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import type { LLMRequestLogFields } from '#/agent/loop';
import type { LLMEvent, LLMRequestOverrides } from './index';
import { IAgentUsageService } from '#/agent/usage';
import { IAgentLLMRequesterService } from './llmRequester';

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

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
    @ILogService private readonly log: ILogService,
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

    const resolvedCtx = this.profile.resolveModelContext();
    let model = this.profile.getProvider();
    model = applyCompletionBudget({
      model,
      budget: resolveCompletionBudget({
        maxOutputSize: overrides.maxOutputSize ?? resolvedCtx.maxOutputSize,
        reservedContextSize: resolvedCtx.reservedContextSize,
        maxCompletionTokensCap:
          this.config.get<KimiModelOverrides>('modelOverrides')?.maxCompletionTokens,
      }),
      capability: resolvedCtx.modelCapabilities,
      usedContextTokens: this.contextSize.getStatus().contextTokens,
    });

    const systemPrompt = overrides.systemPrompt ?? this.profile.getSystemPrompt();
    const tools = [...(overrides.tools ?? this.defaultTools())];
    const messages = [...(overrides.messages ?? this.projector.project(this.context.get()))];

    this.logRequest({
      protocol: model.protocol,
      modelName: model.name,
      modelAlias: resolvedCtx.modelAlias,
      thinkingEffort: model.thinkingEffort,
      systemPrompt,
      tools,
      messages,
      fields: overrides.requestLogFields,
    });

    const usageModel = resolvedCtx.modelAlias ?? model.name;
    for await (const event of model.request({ systemPrompt, tools, messages }, signal)) {
      if (event.type === 'usage') {
        this.usage.record(usageModel, event.usage, overrides.usageContext);
        yield { ...event, model: usageModel };
        continue;
      }
      yield event;
    }
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
