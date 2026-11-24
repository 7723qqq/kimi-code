import { BugIndicatingError } from '#/_base/errors/errors';
import { classifyKimiQuotaError } from '#human/llm-kimi/errors';
import { resolveEndpointDeclaration } from '@moonshot-ai/core/llm/endpoint';
import {
  kimiAnthropicTrait,
  kimiConnection,
  kimiOpenAITrait,
  kimiResponsesTrait,
  KIMI_DEFAULT_BASE_URL,
} from '#human/llm-kimi/trait';
import type { ModelCapability as HumanModelCapability } from '#human/llm/capability';
import { resolveModelFamily } from '#human/llm/modelFamily';
import type { ProtocolEndpoint, ProviderConnection } from '#human/llm/protocol/connection';
import { bedrockAnthropicBase } from '#human/llm/provider/bedrock/anthropic';
import { bedrockModelCapability } from '#human/llm/provider/bedrock/routing';
import type { ProtocolBase } from '#human/llm/protocol/base';
import type { ProtocolTraitFor } from '#human/llm/provider/definition';
import type { LlmErrorClassifier } from '#human/llm/requester/requester';

import type { Protocol } from '../protocol/protocol';
import type { ModelSource } from './provider';

export const openAIConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' }),
};

export const anthropicConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' }),
};

export const geminiEndpoint: ProtocolEndpoint = {
  apiKeyEnv: 'GOOGLE_API_KEY',
  baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL',
};

export const vertexEndpoint: ProtocolEndpoint = {
  apiKeyEnv: 'VERTEXAI_API_KEY',
  baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL',
};

export const geminiConnection: ProviderConnection = {
  endpoint: () => geminiEndpoint,
};

export const vertexConnection: ProviderConnection = {
  endpoint: () => vertexEndpoint,
};

export const kimiEndpoint: ProtocolEndpoint = {
  apiKeyEnv: 'KIMI_API_KEY',
  baseUrlEnv: 'KIMI_BASE_URL',
  defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
};

export interface ProviderDefinition<N extends Protocol = Protocol> {
  readonly id: string;
  readonly baseProtocol: N;
  readonly base?: ProtocolBase<ProtocolTraitFor<N>>;
  readonly trait?: ProtocolTraitFor<N>;
  readonly connection?: ProviderConnection;
  readonly classifyError?: LlmErrorClassifier;
  readonly capability?: (modelName: string) => HumanModelCapability | undefined;
  readonly endpoint?: ProtocolEndpoint;
  readonly endpoints?: readonly ProtocolEndpoint[];
  readonly hostHeaders?: 'full' | 'user-agent';
  readonly requestMetadata?: boolean;
  readonly modelSource?: ModelSource;
}

const providerDefinitions = new Map<string, Map<Protocol, ProviderDefinition>>();

export function registerProviderDefinition<N extends Protocol>(
  definition: ProviderDefinition<N>,
): void {
  let byProtocol = providerDefinitions.get(definition.id);
  if (byProtocol === undefined) {
    byProtocol = new Map();
    providerDefinitions.set(definition.id, byProtocol);
  }
  if (byProtocol.has(definition.baseProtocol)) {
    throw new BugIndicatingError(
      `provider definition '${definition.id}' is already registered for protocol '${definition.baseProtocol}'`,
    );
  }
  byProtocol.set(definition.baseProtocol, definition);
}

export function getProviderDefinition(
  id: string,
  protocol?: Protocol,
): ProviderDefinition | undefined {
  const byProtocol = providerDefinitions.get(id);
  if (byProtocol === undefined) return undefined;
  if (protocol !== undefined) return byProtocol.get(protocol);
  return byProtocol.values().next().value;
}

export function getProviderDefinitions(id: string): readonly ProviderDefinition[] {
  const byProtocol = providerDefinitions.get(id);
  return byProtocol === undefined ? [] : [...byProtocol.values()];
}

export function hasProviderDefinition(id: string): boolean {
  return providerDefinitions.has(id);
}

export function resolveProviderDefinition(
  providerType: string | undefined,
  providerId?: string,
  protocol?: Protocol,
): ProviderDefinition | undefined {
  const byId =
    providerId === undefined || providerId === providerType
      ? undefined
      : getProviderDefinition(providerId, protocol);
  if (byId !== undefined) return byId;
  return providerType === undefined ? undefined : getProviderDefinition(providerType, protocol);
}

export function registerProviderDefinitionIfAbsent<N extends Protocol>(
  definition: ProviderDefinition<N>,
): void {
  if (getProviderDefinition(definition.id, definition.baseProtocol) !== undefined) return;
  registerProviderDefinition(definition);
}

export function isOAuthCatalogVendor(id: string | undefined): boolean {
  if (id === undefined) return false;
  return getProviderDefinitions(id).some(
    (definition) => definition.modelSource === 'oauth-catalog',
  );
}

export function listProviderDefinitions(): readonly ProviderDefinition[] {
  return [...providerDefinitions.values()].flatMap((byProtocol) => [...byProtocol.values()]);
}

export interface ResolvedProviderEndpoint {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface ExplainedProviderEndpoint {
  readonly apiKey?: string;
  readonly apiKeyEnvName?: string;
  readonly baseUrl?: string;
  readonly baseUrlEnvName?: string;
  readonly baseUrlIsDefault?: boolean;
}

export function explainProviderEndpoint(
  providerType: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  providerId?: string,
): ExplainedProviderEndpoint {
  const definition = resolveProviderDefinition(providerType, providerId);
  if (definition === undefined) return {};
  return resolveEndpointDeclaration(definition.endpoint ?? definition.endpoints, env);
}

export function resolveProviderEndpoint(
  providerType: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  providerId?: string,
): ResolvedProviderEndpoint {
  const { apiKey, baseUrl } = explainProviderEndpoint(providerType, env, providerId);
  return {
    ...(apiKey !== undefined ? { apiKey } : undefined),
    ...(baseUrl !== undefined ? { baseUrl } : undefined),
  };
}

registerProviderDefinition({
  id: 'anthropic',
  baseProtocol: 'anthropic',
  endpoint: { apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' },
});

registerProviderDefinition({
  id: 'openai',
  baseProtocol: 'openai',
  endpoint: { apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
});

registerProviderDefinition({
  id: 'openai_responses',
  baseProtocol: 'openai_responses',
  endpoint: { apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
});

registerProviderDefinition({
  id: 'vertexai',
  baseProtocol: 'google-genai',
  endpoints: [vertexEndpoint],
});

registerProviderDefinition({
  id: 'google-genai',
  baseProtocol: 'google-genai',
  endpoints: [vertexEndpoint, geminiEndpoint],
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'openai',
  trait: kimiOpenAITrait,
  connection: kimiConnection,
  classifyError: classifyKimiQuotaError,
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  requestMetadata: true,
  modelSource: 'oauth-catalog',
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'anthropic',
  trait: kimiAnthropicTrait,
  connection: kimiConnection,
  classifyError: classifyKimiQuotaError,
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  requestMetadata: true,
  modelSource: 'oauth-catalog',
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'openai_responses',
  trait: kimiResponsesTrait,
  connection: kimiConnection,
  classifyError: classifyKimiQuotaError,
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  requestMetadata: true,
  modelSource: 'oauth-catalog',
});

export const bedrockEndpoint: ProtocolEndpoint = {
  apiKeyEnv: 'AWS_BEARER_TOKEN_BEDROCK',
  baseUrlEnv: 'AWS_BEDROCK_BASE_URL',
};

registerProviderDefinition({
  id: 'bedrock',
  baseProtocol: 'openai',
  endpoint: bedrockEndpoint,
  capability: bedrockModelCapability,
});

registerProviderDefinition({
  id: 'bedrock',
  baseProtocol: 'openai_responses',
  endpoint: bedrockEndpoint,
  capability: bedrockModelCapability,
});

registerProviderDefinition({
  id: 'bedrock',
  baseProtocol: 'anthropic',
  base: bedrockAnthropicBase,
  endpoint: bedrockEndpoint,
  capability: bedrockModelCapability,
});

export const deepseekEndpoint: ProtocolEndpoint = {
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseUrlEnv: 'DEEPSEEK_BASE_URL',
  defaultBaseUrl: 'https://api.deepseek.com',
};

export const deepseekConnection: ProviderConnection = {
  endpoint: () => deepseekEndpoint,
};

function deepseekCapability(modelName: string): HumanModelCapability | undefined {
  if (resolveModelFamily(modelName)?.id !== 'deepseek') return undefined;
  return {
    image_in: true,
    video_in: false,
    audio_in: false,
    thinking: true,
    tool_use: true,
    pdf_in: false,
  };
}

registerProviderDefinitionIfAbsent({
  id: 'deepseek',
  baseProtocol: 'openai',
  connection: deepseekConnection,
  endpoint: deepseekEndpoint,
  capability: deepseekCapability,
});
