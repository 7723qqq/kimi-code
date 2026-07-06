/**
 * `model` domain (L2) — `IModelResolver` implementation.
 *
 * Reads Model / Provider / Platform config, resolves the auth closure
 * (Platform.auth or Model-inline override), materializes a runnable
 * `Model` god-object via `ModelImpl`. Bound at App scope.
 *
 * Two config-driven paths:
 *   - **Structured** — `Model.providerId` points at a `[providers.*]` entry,
 *     which may point at a `[platforms.*]` entry. Auth comes from the
 *     Platform unless the Model carries an override (`apiKey` / `oauth`).
 *   - **Flat** — `Model.baseUrl` is inline; the resolver synthesizes a
 *     Provider record keyed by the URL's origin so multiple Models on the
 *     same host converge on the same Provider metadata. Auth comes from
 *     the Model itself; no Platform is required.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth';
import { IConfigService } from '#/app/config';
import { ErrorCodes, KimiError } from '#/errors';
import {
  type ModelCapability,
  type ProviderRequestAuth,
  type ThinkingEffort,
} from '#/app/llmProtocol';
import { getModelCapability } from '#/app/llmProtocol/providers';
import { IPlatformService, UNKNOWN_PLATFORM_KEY } from '#/app/platform';
import type { OAuthRef, ProviderConfig } from '#/app/provider';
import { IProviderService } from '#/app/provider';
import { IProtocolAdapterRegistry, type Protocol } from '#/app/protocol';
import { type ProtocolAdapterRegistry } from '#/app/protocol/protocolAdapterRegistry';

import type { ModelConfig } from './model';
import { IModelService } from './model';
import type { AuthProvider, Model } from './modelInstance';
import { IModelResolver } from './modelResolver';
import { ModelImpl, StaticAuthProvider } from './modelImpl';

/**
 * Default thinking effort applied when the user has not disabled thinking
 * (matches `profile`'s `DEFAULT_THINKING_EFFORT`). Read here rather than
 * imported so `model` (L2) does not depend on `profile` (L4); the source of
 * truth for the value is the `thinking` / `defaultThinking` config sections,
 * which are shared via `IConfigService`.
 */
const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'high';
const THINKING_EFFORTS: readonly ThinkingEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Shape of the `thinking` config section (owned by `profile`); only the
 *  fields the resolver needs to mirror the production default are read here. */
interface ThinkingSection {
  readonly mode?: string;
  readonly effort?: string;
}

interface ResolvedAuthMaterial {
  readonly apiKey?: string;
  readonly oauth?: OAuthRef;
  readonly oauthProviderKey?: string;
}

export class ModelResolverService extends Disposable implements IModelResolver {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IProviderService private readonly providers: IProviderService,
    @IPlatformService private readonly platforms: IPlatformService,
    @IModelService private readonly models: IModelService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IProtocolAdapterRegistry
    private readonly protocolRegistry: IProtocolAdapterRegistry,
  ) {
    super();
  }

  resolve(id: string): Model {
    const model = this.models.get(id);
    if (model === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" is not configured in config.toml.`,
      );
    }

    const { providerConfig, providerName, resolvedBaseUrl: rawBaseUrl } = this.resolveProviderContext(id, model);
    const auth = this.resolveAuth(model, providerConfig);
    const authProvider = this.buildAuthProvider(providerName, auth);

    const protocol = this.resolveProtocol(id, model, providerConfig);
    // The Anthropic SDK appends `/v1/messages` to the baseUrl, so a provider
    // whose baseUrl already ends in `/v1` (e.g. the managed Kimi endpoint) would
    // otherwise produce a double `/v1/v1/messages` → 404. Match production v1
    // (`provider-manager` strips a trailing `/v1` for the anthropic transport).
    const resolvedBaseUrl = protocol === 'anthropic' ? stripTrailingV1(rawBaseUrl) : rawBaseUrl;
    const wireName = model.name ?? model.model;
    if (wireName === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" must define a wire-facing name in config.toml.`,
      );
    }
    if (model.maxContextSize === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" must define a positive max_context_size in config.toml.`,
      );
    }

    const capabilities = resolveModelCapabilities(
      model.capabilities,
      protocol,
      wireName,
      model.maxContextSize,
    );
    const declared = new Set((model.capabilities ?? []).map((c) => c.trim().toLowerCase()));
    const alwaysThinking = declared.has('always_thinking');

    const impl = new ModelImpl({
      id,
      name: wireName,
      aliases: model.aliases ?? [],
      protocol,
      baseUrl: resolvedBaseUrl,
      headers: providerConfig?.customHeaders ?? {},
      capabilities,
      maxContextSize: model.maxContextSize,
      maxOutputSize: model.maxOutputSize,
      displayName: model.displayName,
      reasoningKey: model.reasoningKey,
      alwaysThinking,
      providerName,
      authProvider,
      protocolRegistry: this.protocolRegistry as ProtocolAdapterRegistry,
      extras: buildProviderExtras(model),
    });

    // Apply the production default thinking effort so a plain `model.request()`
    // behaves like the agent path (which routes through `profile` and reads the
    // same `thinking` / `defaultThinking` config). Required for models whose
    // endpoint rejects a request that omits thinking (e.g. kimi-k2.7 over the
    // Anthropic protocol returns 400 unless `thinking.type === 'enabled'`).
    const effort = this.resolveDefaultThinking(alwaysThinking);
    return effort === 'off' ? impl : impl.withThinking(effort);
  }

  /**
   * Mirror `profile`'s `resolveThinkingLevel` / `resolveThinkingEffort` so the
   * god-object's default matches the production agent path:
   *   - an explicit `defaultThinking === false` or `thinking.mode === 'off'`
   *     turns thinking off;
   *   - otherwise the configured `thinking.effort` (default 'high') is used;
   *   - an `always_thinking` model clamps an explicit "off" back to on.
   */
  private resolveDefaultThinking(alwaysThinking: boolean): ThinkingEffort {
    const defaultThinking = this.config.get<boolean | undefined>('defaultThinking');
    const thinking = this.config.get<ThinkingSection | undefined>('thinking');
    const turnedOff = defaultThinking === false || thinking?.mode === 'off';
    const configured = parseThinkingEffort(thinking?.effort) ?? DEFAULT_THINKING_EFFORT;
    if (turnedOff && !alwaysThinking) {
      return 'off';
    }
    return configured;
  }

  findByName(name: string): readonly string[] {
    const out: string[] = [];
    for (const [id, m] of Object.entries(this.models.list())) {
      const alias =
        m.name === name ||
        m.model === name ||
        (m.aliases ?? []).includes(name);
      if (alias) out.push(id);
    }
    return out;
  }

  /**
   * Return the ProviderConfig this Model resolves against, plus the URL to
   * hit at runtime. Structured path reads `[providers.<providerId>]`; flat
   * path synthesizes a Provider record from the Model's inline baseUrl.
   */
  private resolveProviderContext(
    id: string,
    model: ModelConfig,
  ): {
    readonly providerConfig: ProviderConfig | undefined;
    readonly providerName: string;
    readonly resolvedBaseUrl: string;
  } {
    // Structured path — Model references a Provider (which may reference a
    // Platform). Legacy configs still use `provider` in place of `providerId`.
    const providerId = model.providerId ?? model.provider;
    if (providerId !== undefined) {
      const providerConfig = this.providers.get(providerId);
      if (providerConfig === undefined) {
        throw new KimiError(
          ErrorCodes.CONFIG_INVALID,
          `Provider "${providerId}" referenced by model "${id}" is not configured.`,
        );
      }
      const baseUrl = model.baseUrl ?? providerConfig.baseUrl;
      if (baseUrl === undefined || baseUrl.length === 0) {
        throw new KimiError(
          ErrorCodes.CONFIG_INVALID,
          `Model "${id}" (via provider "${providerId}") is missing a base URL.`,
        );
      }
      return { providerConfig, providerName: providerId, resolvedBaseUrl: baseUrl };
    }

    // Flat path — Model carries its own baseUrl. Synthesize a Provider id
    // from the URL's origin so two flat Models on the same host converge.
    if (model.baseUrl === undefined || model.baseUrl.length === 0) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" must set either providerId or baseUrl in config.toml.`,
      );
    }
    const originName = deriveProviderId(model.baseUrl);
    return {
      providerConfig: undefined,
      providerName: originName,
      resolvedBaseUrl: model.baseUrl,
    };
  }

  private resolveProtocol(
    id: string,
    model: ModelConfig,
    provider: ProviderConfig | undefined,
  ): Protocol {
    const explicit = model.protocol ?? (provider?.type as Protocol | undefined);
    if (explicit === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" must declare a wire protocol (config: models.<id>.protocol).`,
      );
    }
    return explicit;
  }

  /**
   * Resolve raw auth material for the Model. Precedence:
   *   1. Model-inline `apiKey` / `oauth` (flat-case override).
   *   2. Provider.platformId → Platform.auth (structured shared auth).
   *   3. Provider-legacy `apiKey` / `oauth` (pre-migration configs).
   *
   * An empty / whitespace `apiKey` is treated as absent (matching production's
   * `nonEmptyString`), so a provider that carries both `api_key = ""` and an
   * `oauth` block correctly falls through to OAuth instead of producing an
   * empty bearer token.
   */
  private resolveAuth(
    model: ModelConfig,
    provider: ProviderConfig | undefined,
  ): ResolvedAuthMaterial {
    const modelApiKey = nonEmpty(model.apiKey);
    if (modelApiKey !== undefined) return { apiKey: modelApiKey };
    if (model.oauth !== undefined) {
      return { oauth: model.oauth, oauthProviderKey: model.providerId ?? model.provider };
    }

    const platformId = provider?.platformId;
    if (platformId !== undefined && platformId !== UNKNOWN_PLATFORM_KEY) {
      const platform = this.platforms.get(platformId);
      const platformApiKey = nonEmpty(platform?.auth?.apiKey);
      if (platformApiKey !== undefined) return { apiKey: platformApiKey };
      if (platform?.auth?.oauth !== undefined) {
        return {
          oauth: platform.auth.oauth,
          oauthProviderKey: platformId,
        };
      }
    }

    // Legacy: provider carried auth directly (pre-Phase 4 migration).
    const providerApiKey = nonEmpty(provider?.apiKey);
    if (providerApiKey !== undefined) return { apiKey: providerApiKey };
    if (provider?.oauth !== undefined) {
      return { oauth: provider.oauth, oauthProviderKey: model.providerId ?? model.provider };
    }
    return {};
  }

  private buildAuthProvider(providerName: string, auth: ResolvedAuthMaterial): AuthProvider {
    if (auth.apiKey !== undefined) {
      return new StaticAuthProvider(auth.apiKey);
    }
    if (auth.oauth !== undefined) {
      const oauthRef = auth.oauth;
      const providerKey = auth.oauthProviderKey ?? providerName;
      const oauthService = this.oauth;
      return {
        async getAuth(options): Promise<ProviderRequestAuth | undefined> {
          const tokenProvider = oauthService.resolveTokenProvider(providerKey, oauthRef);
          if (tokenProvider === undefined) return undefined;
          const apiKey = await tokenProvider.getAccessToken({ force: options?.force ?? false });
          if (apiKey.trim().length === 0) return undefined;
          return { apiKey };
        },
      };
    }
    return new StaticAuthProvider(undefined);
  }
}

function parseThinkingEffort(value: string | undefined): ThinkingEffort | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && (THINKING_EFFORTS as readonly string[]).includes(normalized)
    ? (normalized as ThinkingEffort)
    : undefined;
}

function resolveModelCapabilities(
  declaredCapabilities: readonly string[] | undefined,
  protocol: Protocol,
  wireName: string,
  maxContextSize: number,
): ModelCapability {
  const declared = new Set((declaredCapabilities ?? []).map((c) => c.trim().toLowerCase()));
  const detected = getModelCapability(protocol, wireName);
  return {
    image_in: declared.has('image_in') || detected.image_in,
    video_in: declared.has('video_in') || detected.video_in,
    audio_in: declared.has('audio_in') || detected.audio_in,
    thinking: declared.has('thinking') || declared.has('always_thinking') || detected.thinking,
    tool_use: declared.has('tool_use') || detected.tool_use,
    max_context_tokens: maxContextSize,
  };
}

/** Treat an empty / whitespace string as absent (matches production's
 *  `nonEmptyString` used by the session resolver). */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** Strip a trailing `/v1` (with optional trailing slash) from a baseUrl, matching
 *  production v1's anthropic-transport normalization so the Anthropic SDK's
 *  `/v1/messages` suffix does not produce a double `/v1/v1/messages`. */
function stripTrailingV1(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

/** Provider knobs the wire adapter needs that aren't first-class ModelImpl
 *  fields. `adaptiveThinking` changes how the Anthropic adapter encodes the
 *  thinking param, so it must reach the provider for the default-thinking
 *  transform to produce the right shape on adaptive models. */
function buildProviderExtras(model: ModelConfig): Readonly<Record<string, unknown>> | undefined {
  const extras: Record<string, unknown> = {};
  if (model.adaptiveThinking !== undefined) {
    extras['adaptiveThinking'] = model.adaptiveThinking;
  }
  const betaApi = (model as Record<string, unknown>)['betaApi'];
  if (betaApi !== undefined) {
    extras['betaApi'] = betaApi;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

/**
 * Derive a synthetic Provider id from a Model's flat baseUrl. Uses only the
 * origin (host, optionally port) per Phase 2 decision "a=origin only" — two
 * flat Models hitting the same host converge on one Provider identity.
 */
function deriveProviderId(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.host;
  } catch {
    // Fall back to the raw string; malformed URLs will fail downstream at
    // request time with a clearer error.
    return baseUrl;
  }
}

registerScopedService(
  LifecycleScope.App,
  IModelResolver,
  ModelResolverService,
  InstantiationType.Delayed,
  'modelResolver',
);
