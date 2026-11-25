import {
  agentContextOf,
  ErrorCodes,
  IAgentProfileService,
  isError2,
  ISessionTokenCountingService,
  ISessionUsageService,
  IModelCatalog,
  IModelService,
  ProfileErrors,
  type IAgentScopeHandle,
  type UsageStatus,
} from '@moonshot-ai/agent-core-v2';

export interface LegacyStatusSnapshot {
  readonly usage?: UsageStatus;
  readonly contextTokens: number;
  readonly maxContextTokens?: number;
  readonly model: string;
}

export function readLegacyStatus(agent: IAgentScopeHandle): LegacyStatusSnapshot | undefined {
  const profile = agent.accessor.get(IAgentProfileService) as IAgentProfileService | undefined;
  const usageService = agent.accessor.get(ISessionUsageService) as ISessionUsageService | undefined;
  const tokenCounting = agent.accessor.get(ISessionTokenCountingService) as
    | ISessionTokenCountingService
    | undefined;
  if (profile === undefined || usageService === undefined || tokenCounting === undefined) {
    return undefined;
  }
  const context = agentContextOf(agent);
  const usage = usageService.status(context);
  const contextTokens = tokenCounting.statusSize(context);
  const capabilities = profile.getModelCapabilities();
  let maxContextTokens = capabilities.max_input_tokens ?? capabilities.max_context_tokens;
  if (maxContextTokens === 0 && profile.getModel() === '') {
    maxContextTokens = defaultModelContextTokens(agent) ?? 0;
  }
  const model = profile.getModel();
  return {
    usage,
    contextTokens,
    maxContextTokens: maxContextTokens > 0 ? maxContextTokens : undefined,
    model,
  };
}

export function isMissingConfiguredModel(error: unknown, model: string): boolean {
  return (
    isError2(error) &&
    (error.code === ErrorCodes.CONFIG_INVALID ||
      error.code === ProfileErrors.codes.MODEL_CONFIG_INVALID) &&
    error.details?.['model'] === model &&
    error.message === `Model "${model}" is not configured in config.toml.`
  );
}

export function missingConfiguredModelAlias(agent: IAgentScopeHandle): string | undefined {
  const profile = agent.accessor.get(IAgentProfileService);
  const previous = profile.getModel();
  if (previous === '' || typeof profile.resolveModelContext !== 'function') return undefined;
  try {
    profile.resolveModelContext();
    return undefined;
  } catch (error) {
    if (!isMissingConfiguredModel(error, previous)) throw error;
    return previous;
  }
}

function defaultModelContextTokens(agent: IAgentScopeHandle): number | undefined {
  const models = agent.accessor.get(IModelService) as IModelService | undefined;
  const catalog = agent.accessor.get(IModelCatalog) as IModelCatalog | undefined;
  const defaultModel = models?.getDefaultModel();
  if (defaultModel === undefined || defaultModel.length === 0 || catalog === undefined) {
    return undefined;
  }
  try {
    const capabilities = catalog.get(defaultModel).capabilities;
    return capabilities.max_input_tokens ?? capabilities.max_context_tokens;
  } catch {
    return undefined;
  }
}
