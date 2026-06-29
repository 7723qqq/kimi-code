import type { IConfigService } from '#/config';
import { ModelProvider, type IModelProvider } from '#/modelProvider';
import type { ProviderConfig } from '#/provider';

export type TestOAuthAccessTokenProvider = (
  options?: { readonly force?: boolean },
) => Promise<string>;

export function stubConfig(sections: Record<string, unknown>): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: () => ({ dispose: () => {} }),
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

export function oauthAgentOptions(
  getAccessToken: TestOAuthAccessTokenProvider,
  capabilities: readonly string[] = ['image_in', 'video_in', 'tool_use'],
): { readonly modelProvider: IModelProvider } {
  return {
    modelProvider: new ModelProvider({
      config: stubConfig({
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
      resolveOAuthTokenProvider: () => ({ getAccessToken }),
    }),
  };
}
