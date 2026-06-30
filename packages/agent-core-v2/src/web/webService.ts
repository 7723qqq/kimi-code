/**
 * `web` domain (L4) — `IWebService` implementation.
 *
 * Registers the built-in web tools into the agent `IToolRegistry` on
 * construction: `FetchURL` is always registered (using the injected
 * `UrlFetcher` or the built-in `LocalFetchURLProvider` fallback); `WebSearch`
 * is registered only when a `WebSearchProvider` is supplied via options, since
 * there is no local search backend. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IToolRegistry } from '#/toolRegistry';

import { LocalFetchURLProvider } from './providers/local-fetch-url';
import { FetchURLTool } from './tools/fetch-url';
import { WebSearchTool } from './tools/web-search';
import { IWebService, type WebServiceOptions } from './web';

export class WebService implements IWebService {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly options: WebServiceOptions = {},
    @IToolRegistry toolRegistry: IToolRegistry,
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
  IWebService,
  WebService,
  InstantiationType.Delayed,
  'web',
);
