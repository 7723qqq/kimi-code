/**
 * `web` domain (L4) — web tool registration contract and provider options.
 *
 * `IAgentWebService` is a marker: its implementation registers the built-in
 * `FetchURL` tool (always, falling back to `LocalFetchURLProvider`) and the
 * `WebSearch` tool (only when a `WebSearchProvider` is supplied) into the
 * agent `IAgentToolRegistryService` on construction. Bound at Agent scope.
 *
 * The actual fetch/search backends are host-injected through
 * `WebServiceOptions` so this domain stays independent of config and OAuth.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { UrlFetcher } from './tools/fetch-url';
import type { WebSearchProvider } from './tools/web-search';

export interface WebServiceOptions {
  /** URL fetch backend. Defaults to the built-in `LocalFetchURLProvider`. */
  readonly urlFetcher?: UrlFetcher;
  /** Web search backend. When omitted, `WebSearch` is not registered. */
  readonly webSearcher?: WebSearchProvider;
}

export interface IAgentWebService {
  readonly _serviceBrand: undefined;
}

export const IAgentWebService: ServiceIdentifier<IAgentWebService> =
  createDecorator<IAgentWebService>('agentWebService');
