/**
 * `auth` domain (cross-cutting) — `IWebSearchProviderService` implementation.
 *
 * Holds the host-injected `WebSearchProvider` (a `MoonshotWebSearchProvider`
 * the host builds from the OAuth token) and exposes it to the `WebSearch` tool
 * through `IWebSearchProviderService`. Returns `undefined` when no provider is
 * bound so the `WebSearch` tool is skipped. Owns no tool registration — the
 * `WebSearch` tool self-registers via `registerTool(...)` and reads this
 * service from the Agent-scope accessor. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { WebSearchProvider } from './tools/web-search';
import { IWebSearchProviderService, type WebSearchProviderOptions } from './webSearch';

export class WebSearchProviderService implements IWebSearchProviderService {
  declare readonly _serviceBrand: undefined;
  private readonly provider: WebSearchProvider | undefined;

  constructor(options: WebSearchProviderOptions = {}) {
    this.provider = options.provider;
  }

  getWebSearchProvider(): WebSearchProvider | undefined {
    return this.provider;
  }
}

registerScopedService(
  LifecycleScope.App,
  IWebSearchProviderService,
  WebSearchProviderService,
  InstantiationType.Delayed,
  'auth',
);
