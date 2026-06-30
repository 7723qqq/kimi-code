/**
 * `web` domain (L4) — `IAgentWebService` implementation.
 *
 * Registers the built-in web tools into the agent `IAgentToolRegistryService` on
 * construction: `FetchURL` is always registered (using the injected
 * `UrlFetcher` or the built-in `LocalFetchURLProvider` fallback); `WebSearch`
 * is registered only when a `WebSearchProvider` is supplied via options, since
 * there is no local search backend. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentToolRegistryService } from '#/toolRegistry';

import { LocalFetchURLProvider } from './providers/local-fetch-url';
import { FetchURLTool } from './tools/fetch-url';
import { WebSearchTool } from './tools/web-search';
import { IAgentWebService, type WebServiceOptions } from './web';

export class AgentWebService implements IAgentWebService {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly options: WebServiceOptions = {},
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    const fetcher = options.urlFetcher ?? new LocalFetchURLProvider();
    toolRegistry.register(new FetchURLTool(fetcher));
    if (options.webSearcher !== undefined) {
      toolRegistry.register(new WebSearchTool(options.webSearcher));
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentWebService,
  AgentWebService,
  InstantiationType.Delayed,
  'web',
);
