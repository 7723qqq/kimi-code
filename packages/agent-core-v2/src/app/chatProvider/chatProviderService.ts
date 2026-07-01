/**
 * `chatProvider` domain (L1) — `IChatProviderFactory` implementation.
 *
 * Dispatches to the adapter registered for a provider `type`, falling back to
 * the built-in adapters from the `@moonshot-ai/kosong` package's
 * `createProvider`. Owns no configuration and no business dependencies. Bound
 * at App scope.
 */

import type { ChatProvider, ProviderConfig, ProviderType } from '@moonshot-ai/kosong';
import { createProvider } from '@moonshot-ai/kosong';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { type CreateChatProvider, IChatProviderFactory } from './chatProvider';

export class ChatProviderFactory implements IChatProviderFactory {
  declare readonly _serviceBrand: undefined;
  private readonly overrides = new Map<ProviderType, CreateChatProvider>();

  create(config: ProviderConfig): ChatProvider {
    const factory = this.overrides.get(config.type);
    return factory !== undefined ? factory(config) : createProvider(config);
  }

  register(type: ProviderType, factory: CreateChatProvider): void {
    this.overrides.set(type, factory);
  }
}

registerScopedService(
  LifecycleScope.App,
  IChatProviderFactory,
  ChatProviderFactory,
  InstantiationType.Delayed,
  'chatProvider',
);
