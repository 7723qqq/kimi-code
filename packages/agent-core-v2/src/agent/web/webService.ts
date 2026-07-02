/**
 * `web` domain (L4) — `IAgentWebService` implementation.
 *
 * Eager Agent-scope registration service for the built-in web tools: `FetchURL`
 * is always registered (using the host-injected `UrlFetcher` or the built-in
 * `LocalFetchURLProvider` fallback); `WebSearch` is registered only when a
 * `WebSearchProvider` is supplied via options. Each tool is created via
 * `IInstantiationService.createInstance` (the provider is passed as a leading
 * static argument) and registered into the agent `IAgentToolRegistryService`.
 * Eager so the tools are registered when the Agent scope is created.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';

import { LocalFetchURLProvider } from '#/agent/web/providers/local-fetch-url';
import { FetchURLTool } from '#/agent/web/tools/fetch-url';
import { WebSearchTool } from '#/agent/web/tools/web-search';
import { IAgentWebService, type WebServiceOptions } from './web';

export class AgentWebService extends Disposable implements IAgentWebService {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly options: WebServiceOptions = {},
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    super();
    const fetcher = options.urlFetcher ?? new LocalFetchURLProvider();
    this._register(
      toolRegistry.register(instantiationService.createInstance(FetchURLTool, fetcher)),
    );
    if (options.webSearcher !== undefined) {
      this._register(
        toolRegistry.register(
          instantiationService.createInstance(WebSearchTool, options.webSearcher),
        ),
      );
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentWebService,
  AgentWebService,
  InstantiationType.Eager,
  'web',
);
