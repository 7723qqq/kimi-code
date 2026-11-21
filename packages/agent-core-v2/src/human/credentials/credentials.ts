import { errorStatusCode } from '@moonshot-ai/core/llm/protocol/errors';
import type { LlmCredentialProvider } from '@moonshot-ai/core/llm/request';
import type { LlmModel } from '#human/llm/model';
import {
  mergeRequestHeaders,
  type LlmCredential,
} from '#human/llm/requester/requester';

export interface AccessTokenResolver {
  (options?: { readonly force?: boolean }): Promise<string | undefined>;
}

export function applyCredential(model: LlmModel, credential: LlmCredential | undefined): LlmModel {
  if (credential === undefined) {
    return model;
  }
  return {
    ...model,
    apiKey: credential.apiKey ?? model.apiKey,
    defaultHeaders: mergeRequestHeaders(model.defaultHeaders, credential.headers),
  };
}

export function createStaticCredentialProvider(apiKey?: string): LlmCredentialProvider {
  return {
    resolve: () =>
      apiKey === undefined || apiKey.trim().length === 0 ? undefined : { apiKey },
  };
}

export function createOAuthCredentialProvider(
  getToken: AccessTokenResolver,
): LlmCredentialProvider {
  let refreshed: Promise<string | undefined> | undefined;
  return {
    resolve: async () => {
      const pending = refreshed;
      refreshed = undefined;
      const apiKey = pending === undefined ? await getToken() : await pending;
      return apiKey === undefined ? undefined : { apiKey };
    },
    canRecover: (error) => errorStatusCode(error) === 401,
    invalidate: () => {
      refreshed ??= getToken({ force: true });
      refreshed.catch(() => {});
    },
  };
}
