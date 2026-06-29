/**
 * `modelRuntime` domain (L3) — `IModelResolver` contract.
 *
 * Resolves a model alias into a runnable runtime provider configuration plus
 * optional OAuth request authorization, reading provider / model configuration
 * through `IConfigService` and OAuth tokens through `IOAuthService`. Registered
 * as a Session-scoped service; `IProfileService` / `ILLMRequester` consume it
 * through DI. Bound at Session scope.
 */

import type {
  ModelCapability,
  ProviderConfig as RuntimeProviderConfig,
  ProviderRequestAuth,
} from '@moonshot-ai/kosong';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IConfigService } from '#/config';
import type { OAuthRef } from '#/provider';

export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean }): Promise<string>;
}

export type OAuthTokenProviderResolver = (
  providerName: string,
  oauthRef?: OAuthRef,
) => BearerTokenProvider | undefined;

export interface ResolvedModel {
  readonly providerName: string;
  readonly provider: RuntimeProviderConfig;
  readonly modelCapabilities: ModelCapability;
  readonly alwaysThinking?: boolean;
  readonly maxOutputSize?: number;
}

export interface ModelResolverOptions {
  readonly config: IConfigService;
  readonly kimiRequestHeaders?: Record<string, string>;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver;
  readonly promptCacheKey?: string;
}

export interface RequestLogger {
  warn(message: string, payload?: unknown): void;
}

export type AuthorizedRequest = <T>(
  request: (auth: ProviderRequestAuth) => Promise<T>,
) => Promise<T>;

export interface IModelResolver {
  readonly _serviceBrand: undefined;
  readonly defaultModel?: string;
  resolve(model: string): ResolvedModel;
  resolveAuth?(
    model: string,
    options?: { readonly log?: RequestLogger },
  ): AuthorizedRequest | undefined;
}

export const IModelResolver: ServiceIdentifier<IModelResolver> =
  createDecorator<IModelResolver>('modelResolver');
