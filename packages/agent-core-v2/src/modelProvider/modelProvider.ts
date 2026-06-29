/**
 * `modelProvider` domain (L1) — seeded runtime model provider contract.
 *
 * Defines `IModelProvider`, the session-scoped service that resolves a model
 * alias into a runtime kosong provider configuration and optional request
 * authorization. Host code installs an implementation into Session scope via
 * `modelProviderSeed`.
 */

import type {
  ModelCapability,
  ProviderConfig as KosongProviderConfig,
  ProviderRequestAuth,
} from '@moonshot-ai/kosong';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { IConfigService } from '#/config';
import type { OAuthRef } from '#/provider';

export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean }): Promise<string>;
}

export type OAuthTokenProviderResolver = (
  providerName: string,
  oauthRef?: OAuthRef,
) => BearerTokenProvider | undefined;

export interface ResolvedRuntimeProvider {
  readonly providerName: string;
  readonly provider: KosongProviderConfig;
  readonly modelCapabilities: ModelCapability;
  readonly alwaysThinking?: boolean;
  readonly maxOutputSize?: number;
}

export interface ModelProviderOptions {
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

export interface IModelProvider {
  readonly _serviceBrand: undefined;
  readonly defaultModel?: string;
  resolveProviderConfig(model: string): ResolvedRuntimeProvider;
  resolveAuth?(model: string, options?: { readonly log?: RequestLogger }): AuthorizedRequest | undefined;
}

export const IModelProvider: ServiceIdentifier<IModelProvider> =
  createDecorator<IModelProvider>('modelProvider');

export function modelProviderSeed(modelProvider: IModelProvider): ScopeSeed {
  return [[IModelProvider as ServiceIdentifier<unknown>, modelProvider]];
}
