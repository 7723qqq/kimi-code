/**
 * `modelCatalog` domain (L3) — `IModelCatalogService` implementation.
 *
 * Projects the `provider` / `model` registries into protocol catalog items,
 * resolves credential state through `config` and `auth`, and persists the
 * global default-model selection through `config`. Bound at App scope. The
 * The managed OAuth-provider refresh lives in `auth` (`IOAuthService`), not here.
 */

import type {
  ModelCatalogItem,
  ProviderCatalogItem,
  SetDefaultModelResponse,
} from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/auth/auth';
import { IConfigService } from '#/config/config';
import { ErrorCodes, KimiError } from '#/errors';
import { IModelService, type ModelAlias } from '#/model/model';
import { IProviderService, type ProviderConfig } from '#/provider/provider';

import {
  type ProviderCredentialState,
  IModelCatalogService,
  modelIdsForProvider,
  toProtocolModel,
  toProtocolProvider,
} from './modelCatalog';

const DEFAULT_MODEL_SECTION = 'defaultModel';

export class ModelCatalogService implements IModelCatalogService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IModelService private readonly modelService: IModelService,
    @IProviderService private readonly providerService: IProviderService,
    @IConfigService private readonly config: IConfigService,
    @IOAuthService private readonly oauth: IOAuthService,
  ) {}

  async listModels(): Promise<readonly ModelCatalogItem[]> {
    const models = this.modelService.list();
    return Object.entries(models).map(([modelId, alias]) => toProtocolModel(modelId, alias));
  }

  async listProviders(): Promise<readonly ProviderCatalogItem[]> {
    const providers = this.providerService.list();
    const models = this.modelService.list();
    const globalDefaultModel = this.config.get<string>(DEFAULT_MODEL_SECTION);
    const out: ProviderCatalogItem[] = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      out.push(await this.toCatalogProvider(providerId, provider, models, globalDefaultModel));
    }
    return out;
  }

  async getProvider(providerId: string): Promise<ProviderCatalogItem> {
    const provider = this.providerService.get(providerId);
    if (provider === undefined) {
      throw new KimiError(ErrorCodes.PROVIDER_NOT_FOUND, `provider ${providerId} does not exist`);
    }
    const models = this.modelService.list();
    const globalDefaultModel = this.config.get<string>(DEFAULT_MODEL_SECTION);
    return this.toCatalogProvider(providerId, provider, models, globalDefaultModel);
  }

  async setDefaultModel(modelId: string): Promise<SetDefaultModelResponse> {
    const alias = this.modelService.get(modelId);
    if (alias === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_FOUND, `model ${modelId} does not exist`);
    }
    await this.config.set(DEFAULT_MODEL_SECTION, modelId);
    const updatedAlias = this.modelService.get(modelId) ?? alias;
    return {
      default_model: modelId,
      model: toProtocolModel(modelId, updatedAlias),
    };
  }

  private async toCatalogProvider(
    providerId: string,
    provider: ProviderConfig,
    models: Readonly<Record<string, ModelAlias>>,
    globalDefaultModel: string | undefined,
  ): Promise<ProviderCatalogItem> {
    const credential = await this.resolveCredential(providerId, provider);
    return toProtocolProvider(providerId, provider, models, globalDefaultModel, credential);
  }

  private async resolveCredential(
    providerId: string,
    provider: ProviderConfig,
  ): Promise<ProviderCredentialState> {
    return {
      hasApiKey: hasConfiguredApiKey(provider),
      hasOAuthToken: await this.hasCachedToken(providerId, provider),
    };
  }

  private async hasCachedToken(providerId: string, provider: ProviderConfig): Promise<boolean> {
    if (provider.oauth === undefined) return false;
    try {
      const token = await this.oauth.getCachedAccessToken(providerId, provider.oauth);
      return nonEmpty(token) !== undefined;
    } catch {
      return false;
    }
  }
}

function hasConfiguredApiKey(provider: ProviderConfig): boolean {
  if (nonEmpty(provider.apiKey) !== undefined) return true;
  switch (provider.type) {
    case 'anthropic':
      return nonEmpty(provider.env?.['ANTHROPIC_API_KEY']) !== undefined;
    case 'openai':
    case 'openai_responses':
      return nonEmpty(provider.env?.['OPENAI_API_KEY']) !== undefined;
    case 'kimi':
      return nonEmpty(provider.env?.['KIMI_API_KEY']) !== undefined;
    case 'google-genai':
      return nonEmpty(provider.env?.['GOOGLE_API_KEY']) !== undefined;
    case 'vertexai':
      return (
        nonEmpty(provider.env?.['VERTEXAI_API_KEY']) !== undefined ||
        nonEmpty(provider.env?.['GOOGLE_API_KEY']) !== undefined
      );
  }
  return false;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

registerScopedService(
  LifecycleScope.App,
  IModelCatalogService,
  ModelCatalogService,
  InstantiationType.Delayed,
  'modelCatalog',
);
