import { IInstantiationService } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  IAgentLLMRequesterService,
  type AgentLLMTurnRequestSnapshot,
} from '#/agent/llmRequester/llmRequester';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { inputTotal } from '#human/llm/usage';

import { IAgentCacheProbeService } from './cacheProbe';
import { type UsageRecordedContext } from './usage';

export class AgentCacheProbeService extends Service implements IAgentCacheProbeService {
  declare readonly _serviceBrand: undefined;

  private parentId: string | undefined;

  private parentRequest: AgentLLMTurnRequestSnapshot | undefined;

  constructor(
    @ISessionUsageService usage: ISessionUsageService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {
    super();
    if (scopeContext.forkedFrom === undefined) return;
    this.parentId = scopeContext.forkedFrom;
    this.parentRequest = agentLifecycle
      .handleOf(this.parentId)
      ?.accessor.get(IAgentLLMRequesterService)
      .lastTurnRequest();
    this._register(
      usage.onDidRecord((e) => {
        if (e.agent.agentId === scopeContext.agentId) this.probe(e);
      }),
    );
  }

  private probe(e: UsageRecordedContext): void {
    if (!e.firstRecord || e.source?.type !== 'turn') return;
    const own = this.ownSnapshot();
    const parent = this.parentSnapshot();
    const compared =
      own !== undefined &&
      parent !== undefined &&
      own.observation.modelAlias === parent.observation.modelAlias
        ? { own, parent }
        : undefined;
    const observation = own?.observation;
    this.telemetry.track2('prompt_cache_probe', {
      source: 'fork',
      turn_id: e.source.turnId,
      provider_type: observation?.providerType ?? observation?.protocol,
      protocol: observation?.protocol,
      input_tokens: inputTotal(e.usage),
      input_cache_read: e.usage.inputCacheRead,
      input_cache_creation: e.usage.inputCacheCreation,
      output_tokens: e.usage.output,
      message_count: observation?.messageCount,
      projection: observation?.projection,
      thinking_effort: observation?.thinkingEffort,
      tools_match:
        compared === undefined ? undefined : compared.own.toolsHash === compared.parent.toolsHash,
      system_prompt_match:
        compared === undefined
          ? undefined
          : compared.own.systemPromptHash === compared.parent.systemPromptHash,
      parent_message_count: compared?.parent.observation.messageCount,
      parent_input_tokens: compared?.parent.observation.inputTokens,
      parent_request_gap_ms:
        compared === undefined ? undefined : compared.own.startedAt - compared.parent.finishedAt,
    });
  }

  private ownSnapshot(): AgentLLMTurnRequestSnapshot | undefined {
    return this.instantiation
      .invokeFunction((accessor) => accessor.get(IAgentLLMRequesterService))
      .lastTurnRequest();
  }

  private parentSnapshot(): AgentLLMTurnRequestSnapshot | undefined {
    if (this.parentId === undefined || this.parentRequest === undefined) return undefined;
    const parentHandle = this.agentLifecycle.handleOf(this.parentId);
    const parentRevision = parentHandle?.accessor.get(IAgentContextMemoryService).prefixRevision();
    if (parentRevision !== this.parentRequest.contextRevision) return undefined;
    return this.parentRequest;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentCacheProbeService,
  AgentCacheProbeService,
  ScopeActivation.OnScopeCreated,
  'cacheProbe',
);
