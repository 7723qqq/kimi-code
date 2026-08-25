import {
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeBaseUrl,
  type BearerTokenProvider,
} from '@moonshot-ai/kimi-code-oauth';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IProviderService, type ProviderConfig } from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';

import { SERVICES_SECTION, type ServicesConfig } from '../configSection';
import { LocalWebSearchProvider } from './providers/local-web-search';
import { MoonshotWebSearchProvider } from './providers/moonshot-web-search';
import type { WebSearchProvider } from '#/agent/tools/web-search/web-search';
import { IWebSearchProviderService } from './webSearch';

export class WebSearchProviderService implements IWebSearchProviderService {
  declare readonly _serviceBrand: undefined;

  private local: LocalWebSearchProvider | undefined;

  constructor(
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
  ) {}

  getWebSearchProvider(): WebSearchProvider | undefined {
    const factories: ReadonlyArray<() => WebSearchProvider | undefined> = [
      () => this.fromServicesConfig(),
      () => {
        try {
          return this.fromManagedOAuth();
        } catch {
          return undefined;
        }
      },
      () => this.localProvider(),
    ];
    // Construct the highest-priority defined candidate eagerly so its side
    // effects (token resolution, identity freeze checks) surface at
    // acquisition time; lower tiers stay lazy until a cascade reaches them.
    // Factory errors propagate here by design — each tier decides its own
    // fall-through (the managed factory catches internally).
    const pending = [...factories];
    let first: WebSearchProvider | undefined;
    while (first === undefined && pending.length > 0) {
      const candidate = pending.shift()?.();
      if (candidate !== undefined) first = candidate;
    }
    return createFailoverWebSearchProvider([
      ...(first !== undefined ? [first] : []),
      ...pending,
    ]);
  }

  hasWebSearchProvider(): boolean {
    return true;
  }

  private localProvider(): WebSearchProvider {
    this.local ??= new LocalWebSearchProvider();
    return this.local;
  }

  private configuredSearch(): (ServicesConfig['moonshotSearch'] & { baseUrl: string }) | undefined {
    const search = this.config.get<ServicesConfig>(SERVICES_SECTION)?.moonshotSearch;
    if (search?.baseUrl === undefined) return undefined;
    return search as ServicesConfig['moonshotSearch'] & { baseUrl: string };
  }

  private managedTokenProvider():
    | { provider: ProviderConfig; tokenProvider: BearerTokenProvider }
    | undefined {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (provider === undefined || !isOAuthCatalogVendor(provider.type) || provider.oauth === undefined) {
      return undefined;
    }
    const tokenProvider = this.oauth.resolveTokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      provider.oauth,
    );
    if (tokenProvider === undefined) return undefined;
    return { provider, tokenProvider };
  }

  private fromServicesConfig(): WebSearchProvider | undefined {
    const search = this.configuredSearch();
    if (search === undefined) return undefined;
    const tokenProvider =
      search.oauth === undefined
        ? undefined
        : this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, search.oauth);
    return new MoonshotWebSearchProvider({
      baseUrl: search.baseUrl,
      tokenProvider,
      apiKey: nonEmptyString(search.apiKey),
      defaultHeaders: { ...this.identity.current().requestHeaders },
      customHeaders: search.customHeaders,
    });
  }

  private fromManagedOAuth(): WebSearchProvider | undefined {
    const managed = this.managedTokenProvider();
    if (managed === undefined) return undefined;
    const { provider, tokenProvider } = managed;
    const baseUrl = `${(provider.baseUrl ?? kimiCodeBaseUrl()).replace(/\/+$/, '')}/search`;
    return new MoonshotWebSearchProvider({
      baseUrl,
      tokenProvider,
      defaultHeaders: { ...this.bootstrap.args.requestHeaders },
      customHeaders: provider.customHeaders,
    });
  }
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Try each candidate in order; an auth failure (missing/expired managed
 * token) falls through to the next candidate instead of surfacing a
 * dead-end, while caller aborts propagate immediately. Empty result sets
 * also cascade — engines can legitimately miss a query. Entries may be
 * ready providers or lazy factories; factories run only when the cascade
 * reaches them.
 */
export function createFailoverWebSearchProvider(
  candidates: ReadonlyArray<WebSearchProvider | (() => WebSearchProvider | undefined)>,
): WebSearchProvider {
  return {
    async search(query, options) {
      let lastError: unknown = new Error('no search provider configured');
      for (const entry of candidates) {
        let candidate: WebSearchProvider | undefined;
        try {
          candidate = typeof entry === 'function' ? entry() : entry;
        } catch (error) {
          if (options?.signal?.aborted) throw error;
          lastError = error;
          continue;
        }
        if (candidate === undefined) continue;
        try {
          const results = await candidate.search(query, options);
          if (results.length > 0 || candidates.length === 1) return results;
          lastError = new Error('no search results');
        } catch (error) {
          if (options?.signal?.aborted) throw error;
          lastError = error;
        }
      }
      throw lastError;
    },
  };
}

registerScopedService(
  LifecycleScope.App,
  IWebSearchProviderService,
  WebSearchProviderService,
  ScopeActivation.OnScopeCreated,
  'auth',
);
