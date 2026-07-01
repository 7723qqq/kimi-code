import type { IOAuthService } from '#/app/auth';
import type { IConfigService } from '#/app/config';
import { SessionModelResolver, type ISessionModelResolver } from '#/session/modelRuntime';
import type { ProviderConfig } from '#/app/provider';

export type TestOAuthAccessTokenProvider = (
  options?: { readonly force?: boolean },
) => Promise<string>;

export function stubConfig(sections: Record<string, unknown>): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    get: <T>(domain: string) => sections[domain] as T,
    inspect: () => ({
      value: undefined,
      defaultValue: undefined,
      userValue: undefined,
      memoryValue: undefined,
    }),
    getAll: () => ({ ...sections }),
    set: () => Promise.resolve(),
    replace: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    diagnostics: () => [],
  } as unknown as IConfigService;
}

export function stubOAuth(getAccessToken?: TestOAuthAccessTokenProvider): IOAuthService {
  return {
    _serviceBrand: undefined,
    startLogin: () => Promise.reject(new Error('not implemented')),
    getFlow: () => undefined,
    cancelLogin: () => Promise.reject(new Error('not implemented')),
    logout: () => Promise.reject(new Error('not implemented')),
    status: () => Promise.resolve({ loggedIn: false }),
    resolveTokenProvider: () =>
      getAccessToken === undefined ? undefined : { getAccessToken },
    getCachedAccessToken: () => Promise.resolve(undefined),
  } as unknown as IOAuthService;
}

export function oauthAgentOptions(
  getAccessToken: TestOAuthAccessTokenProvider,
  capabilities: readonly string[] = ['image_in', 'video_in', 'tool_use'],
): { readonly modelResolver: ISessionModelResolver } {
  return {
    modelResolver: new SessionModelResolver(
      stubConfig({
        defaultModel: 'kimi-code',
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          } satisfies ProviderConfig,
        },
        models: {
          'kimi-code': {
            provider: 'managed:kimi-code',
            model: 'kimi-for-coding',
            maxContextSize: 1_000_000,
            capabilities: [...capabilities],
          },
        },
      }),
      stubOAuth(getAccessToken),
    ),
  };
}
