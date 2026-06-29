/**
 * `modelCatalog` domain (L3) — `IModelCatalogService` implementation.
 *
 * Projects the `provider` / `model` registries into protocol catalog items,
 * resolves credential state through `config` and `auth`, persists the global
 * default-model selection through `config`, and drives the Kimi Code OAuth
 * model refresh against the user-layer config sections. Bound at Core scope.
 */

import {
  KIMI_CODE_PLATFORM_ID,
  KIMI_CODE_PROVIDER_NAME,
  applyManagedKimiCodeConfig,
  fetchManagedKimiCodeModels,
  resolveKimiCodeRuntimeAuth,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
import type {
  ModelCatalogItem,
  ProviderCatalogItem,
  RefreshOAuthProviderModelsResponse,
  SetDefaultModelResponse,
} from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/auth/auth';
import { IConfigService } from '#/config/config';
import { ErrorCodes, KimiError } from '#/errors';
import { IModelService, type ModelAlias } from '#/model/model';
import { IProviderService, type OAuthRef, type ProviderConfig } from '#/provider/provider';

import {
  type ProviderCredentialState,
  IModelCatalogService,
  modelIdsForProvider,
  toProtocolModel,
  toProtocolProvider,
} from './modelCatalog';

const DEFAULT_MODEL_SECTION = 'defaultModel';
const DEFAULT_THINKING_SECTION = 'defaultThinking';
const MODELS_SECTION = 'models';
const PROVIDERS_SECTION = 'providers';

/** Structural view of a managed-config model alias (the fields the refresh reads/writes). */
interface ManagedModel {
  readonly provider: string;
  readonly model: string;
  readonly maxContextSize: number;
  readonly capabilities?: readonly string[];
  readonly displayName?: string;
}

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

  async refreshOAuthProviderModels(): Promise<RefreshOAuthProviderModelsResponse> {
    const changed: RefreshOAuthProviderModelsResponse['changed'] = [];
    const unchanged: string[] = [];
    const failed: RefreshOAuthProviderModelsResponse['failed'] = [];

    await this.config.reload();
    const current = this.readUserConfigShape();
    const provider = current.providers[KIMI_CODE_PROVIDER_NAME];
    if (!isKimiOAuthProvider(provider)) {
      return { changed, unchanged, failed };
    }

    try {
      const auth = resolveKimiCodeRuntimeAuth({
        configuredBaseUrl: provider.baseUrl,
        configuredOAuthRef: provider.oauth,
      });
      const tokenProvider = this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, auth.oauthRef);
      if (tokenProvider === undefined) {
        throw new Error('OAuth token provider is not configured.');
      }
      const token = await tokenProvider.getAccessToken();
      const models = await fetchManagedKimiCodeModels({
        accessToken: token,
        baseUrl: auth.baseUrl,
      });
      if (models.length === 0) {
        return { changed, unchanged, failed };
      }

      const next = structuredClone(current);
      applyManagedKimiCodeConfig(next, {
        models,
        baseUrl: auth.baseUrl,
        oauthKey: auth.oauthRef.key,
        oauthHost: auth.oauthRef.oauthHost,
        preserveDefaultModel: true,
      });
      const refreshedAliasKeys = providerRefreshAliasKeys(
        current,
        next,
        KIMI_CODE_PROVIDER_NAME,
        `${KIMI_CODE_PLATFORM_ID}/`,
      );
      restoreProviderAliases(
        next,
        preserveUserProviderAliases(current, KIMI_CODE_PROVIDER_NAME, refreshedAliasKeys),
      );
      restoreDefaultSelection(next, current.defaultModel, current.defaultThinking);
      clampDanglingDefault(next);

      if (providerModelsEqual(current, next, KIMI_CODE_PROVIDER_NAME, refreshedAliasKeys)) {
        unchanged.push(KIMI_CODE_PROVIDER_NAME);
      } else {
        const { added, removed } = computeChanges(
          collectModelIdsForAliases(current, refreshedAliasKeys),
          collectModelIdsForAliases(next, refreshedAliasKeys),
        );
        await this.config.replace(PROVIDERS_SECTION, next.providers);
        await this.config.replace(MODELS_SECTION, next.models ?? {});
        await this.config.set(DEFAULT_MODEL_SECTION, next.defaultModel);
        await this.config.set(DEFAULT_THINKING_SECTION, next.defaultThinking);
        changed.push({
          provider_id: KIMI_CODE_PROVIDER_NAME,
          provider_name: 'Kimi Code',
          added,
          removed,
        });
      }
    } catch (err) {
      failed.push({
        provider: KIMI_CODE_PROVIDER_NAME,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    return { changed, unchanged, failed };
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

  /** Assemble a v1-style flat config shape from the user-layer config sections. */
  private readUserConfigShape(): ManagedKimiConfigShape {
    const providers =
      this.config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const models =
      this.config.inspect<Record<string, ModelAlias>>(MODELS_SECTION).userValue ?? {};
    const defaultModel = this.config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
    const defaultThinking = this.config.inspect<boolean>(DEFAULT_THINKING_SECTION).userValue;
    return {
      providers: { ...providers } as ManagedKimiConfigShape['providers'],
      models: { ...models } as ManagedKimiConfigShape['models'],
      defaultModel,
      defaultThinking,
    };
  }
}

function isKimiOAuthProvider(
  provider: ProviderConfig | Record<string, unknown> | undefined,
): provider is ProviderConfig & { oauth: OAuthRef } {
  return (
    provider !== undefined &&
    (provider as ProviderConfig).type === 'kimi' &&
    (provider as ProviderConfig).oauth !== undefined
  );
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

function collectModelIdsForAliases(
  config: ManagedKimiConfigShape,
  aliasKeys: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const aliasKey of aliasKeys) {
    const alias = managedModel(config, aliasKey);
    if (alias !== undefined && alias.model.length > 0) ids.add(alias.model);
  }
  return ids;
}

function providerAliasKeys(config: ManagedKimiConfigShape, providerId: string): Set<string> {
  const keys = new Set<string>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if ((model as ManagedModel).provider === providerId) keys.add(alias);
  }
  return keys;
}

function generatedProviderAliasKeys(
  config: ManagedKimiConfigShape,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = new Set<string>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if ((model as ManagedModel).provider === providerId && alias.startsWith(aliasPrefix)) {
      keys.add(alias);
    }
  }
  return keys;
}

function computeChanges(
  oldIds: Set<string>,
  newIds: Set<string>,
): { added: number; removed: number } {
  let added = 0;
  for (const id of newIds) {
    if (!oldIds.has(id)) added++;
  }
  let removed = 0;
  for (const id of oldIds) {
    if (!newIds.has(id)) removed++;
  }
  return { added, removed };
}

function providerModelsEqual(
  config: ManagedKimiConfigShape,
  nextConfig: ManagedKimiConfigShape,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): boolean {
  return (
    providerModelSnapshot(config, providerId, aliasKeys) ===
    providerModelSnapshot(nextConfig, providerId, aliasKeys)
  );
}

function providerModelSnapshot(
  config: ManagedKimiConfigShape,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): string {
  const snapshots: Array<{ alias: string; model: ManagedModel }> = [];
  for (const alias of aliasKeys) {
    const model = managedModel(config, alias);
    if (model === undefined || model.provider !== providerId) continue;
    snapshots.push({
      alias,
      model: {
        ...model,
        capabilities:
          model.capabilities === undefined ? undefined : [...model.capabilities].sort(),
      },
    });
  }
  snapshots.sort((a, b) => a.alias.localeCompare(b.alias));
  return JSON.stringify(snapshots);
}

function providerRefreshAliasKeys(
  config: ManagedKimiConfigShape,
  nextConfig: ManagedKimiConfigShape,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = generatedProviderAliasKeys(config, providerId, aliasPrefix);
  for (const key of providerAliasKeys(nextConfig, providerId)) keys.add(key);
  return keys;
}

function preserveUserProviderAliases(
  config: ManagedKimiConfigShape,
  providerId: string,
  refreshedAliasKeys: ReadonlySet<string>,
): Record<string, ManagedModel> {
  const preserved: Record<string, ManagedModel> = {};
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    const entry = model as ManagedModel;
    if (entry.provider !== providerId || refreshedAliasKeys.has(alias)) continue;
    preserved[alias] = structuredClone(entry);
  }
  return preserved;
}

function restoreProviderAliases(
  config: ManagedKimiConfigShape,
  aliases: Record<string, ManagedModel>,
): void {
  if (Object.keys(aliases).length === 0) return;
  config.models = {
    ...config.models,
    ...aliases,
  } as ManagedKimiConfigShape['models'];
}

function restoreDefaultSelection(
  config: ManagedKimiConfigShape,
  defaultModel: string | undefined,
  defaultThinking: boolean | undefined,
): void {
  if (defaultModel === undefined || config.models?.[defaultModel] === undefined) return;
  config.defaultModel = defaultModel;
  const capabilities = managedModel(config, defaultModel)?.capabilities ?? [];
  config.defaultThinking = capabilities.includes('always_thinking') ? true : defaultThinking;
}

function clampDanglingDefault(config: ManagedKimiConfigShape): void {
  if (config.defaultModel !== undefined && config.models?.[config.defaultModel] === undefined) {
    config.defaultModel = undefined;
    config.defaultThinking = undefined;
  }
}

function managedModel(
  config: ManagedKimiConfigShape,
  alias: string,
): ManagedModel | undefined {
  return config.models?.[alias] as ManagedModel | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

registerScopedService(
  LifecycleScope.Core,
  IModelCatalogService,
  ModelCatalogService,
  InstantiationType.Delayed,
  'modelCatalog',
);
