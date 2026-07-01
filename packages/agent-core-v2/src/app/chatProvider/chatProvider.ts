/**
 * `chatProvider` domain (L1) — `IChatProviderFactory` contract.
 *
 * Builds the protocol adapter (`ChatProvider`) that speaks a given provider
 * `type`. A provider is a configured endpoint (baseUrl / apiKey / model); the
 * factory is the adapter that speaks its wire protocol — different providers
 * may share one adapter. Bound at App scope.
 */

import type { ChatProvider, ProviderConfig, ProviderType } from '@moonshot-ai/kosong';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type CreateChatProvider = (config: ProviderConfig) => ChatProvider;

export interface IChatProviderFactory {
  readonly _serviceBrand: undefined;
  create(config: ProviderConfig): ChatProvider;
  register(type: ProviderType, factory: CreateChatProvider): void;
}

export const IChatProviderFactory: ServiceIdentifier<IChatProviderFactory> =
  createDecorator<IChatProviderFactory>('chatProviderFactory');
