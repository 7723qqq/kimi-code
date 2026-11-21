import type { BearerTokenProvider } from '@moonshot-ai/kimi-code-oauth';

import { createOAuthCredentialProvider } from '#human/credentials/credentials';
import type { LlmCredentialProvider } from '#human/llm/requester/requester';

export function createKimiOAuthCredentialProvider(
  tokens: BearerTokenProvider,
): LlmCredentialProvider {
  return createOAuthCredentialProvider((options) => tokens.getAccessToken(options));
}
