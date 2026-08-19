import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import { ErrorCodes, Error2, isError2 } from '#/errors';

import { startCallbackServer, type CallbackServer } from './callback-server';
import { McpOAuthClientProvider, type StoredMcpOAuthTokens } from './provider';
import { mcpOAuthStoreKey, type McpOAuthStore } from './store';

export interface McpOAuthServiceOptions {
  readonly store: McpOAuthStore;
  readonly clientLabel?: string;
  readonly resolveClientName?: () => string | undefined;
}

export interface BeginAuthorizationOptions {
  readonly clientLabel?: string;
}

export interface BeginAuthorizationResult {
  readonly authorizationUrl: URL;
  complete(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  cancel(): Promise<void>;
}

export interface McpOAuthTokenState {
  readonly hasTokens: boolean;
  readonly expired: boolean;
  readonly hasRefreshToken: boolean;
}

export class McpOAuthService {
  private readonly store: McpOAuthStore;
  private readonly clientLabel: string | undefined;
  private readonly resolveClientName: (() => string | undefined) | undefined;
  private readonly providers = new Map<string, McpOAuthClientProvider>();

  constructor(options: McpOAuthServiceOptions) {
    this.store = options.store;
    this.clientLabel = options.clientLabel;
    this.resolveClientName = options.resolveClientName;
  }

  getProvider(serverName: string, serverUrl: string | URL): McpOAuthClientProvider {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    let provider = this.providers.get(storeKey);
    if (provider === undefined) {
      provider = new McpOAuthClientProvider({
        serverName,
        serverUrl,
        store: this.store,
        clientLabel: this.clientLabel,
        clientName: this.resolveClientName?.(),
      });
      this.providers.set(provider.storeKey, provider);
    }
    return provider;
  }

  async hasTokens(serverName: string, serverUrl: string | URL): Promise<boolean> {
    return (await this.getProvider(serverName, serverUrl).tokens()) !== undefined;
  }

  /**
   * Token state for auth-status classification: whether a grant exists, and
   * whether it is expired without a usable refresh token. `expired` is only
   * determinable when the stored grant carries `expires_in` plus the
   * `obtained_at` stamp written by `saveTokens`.
   */
  async tokenState(serverName: string, serverUrl: string | URL): Promise<McpOAuthTokenState> {
    const tokens = await this.getProvider(serverName, serverUrl).tokens();
    if (tokens === undefined) {
      return { hasTokens: false, expired: false, hasRefreshToken: false };
    }
    const stamped = tokens as StoredMcpOAuthTokens;
    const expired =
      stamped.expires_in !== undefined &&
      stamped.obtained_at !== undefined &&
      Date.now() > stamped.obtained_at + stamped.expires_in * 1000;
    return {
      hasTokens: true,
      expired,
      hasRefreshToken: stamped.refresh_token !== undefined,
    };
  }

  async beginAuthorization(
    serverName: string,
    serverUrl: string | URL,
    options: BeginAuthorizationOptions = {},
  ): Promise<BeginAuthorizationResult> {
    const provider = options.clientLabel === undefined
      ? this.getProvider(serverName, serverUrl)
      : new McpOAuthClientProvider({
          serverName,
          serverUrl,
          store: this.store,
          clientLabel: options.clientLabel,
          clientName: this.resolveClientName?.(),
        });
    if (options.clientLabel !== undefined) {
      this.providers.set(provider.storeKey, provider);
    }

    provider.resetFlow();

    let callbackServer: CallbackServer;
    try {
      callbackServer = await startCallbackServer();
    } catch (error) {
      throw wrapAuthError('failed to start OAuth callback listener', error);
    }

    provider.setRedirectUrl(new URL(callbackServer.redirectUri));
    await provider.ready;
    await provider.invalidateStaleRegistration(callbackServer.redirectUri);

    let authorizationUrl: URL | undefined;
    try {
      const result = await auth(provider as OAuthClientProvider, { serverUrl });
      if (result !== 'REDIRECT') {
        await callbackServer.close();
        throw new AlreadyAuthorizedError(serverName);
      }
      authorizationUrl = provider.takeAuthorizationUrl();
      if (authorizationUrl === undefined) {
        throw new Error2(
          ErrorCodes.MCP_OAUTH_FAILED,
          'OAuth provider did not capture an authorization URL',
        );
      }
    } catch (error) {
      await callbackServer.close().catch(() => {});
      provider.resetFlow();
      if (error instanceof AlreadyAuthorizedError) throw error;
      throw wrapAuthError(`failed to start OAuth flow for "${serverName}"`, error);
    }

    let settled = false;
    const flowController = new AbortController();
    const cancel = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      flowController.abort();
      await callbackServer.close().catch(() => {});
      provider.resetFlow();
    };

    const complete: BeginAuthorizationResult['complete'] = async (opts = {}) => {
      if (settled) {
        throw new Error2(ErrorCodes.MCP_OAUTH_FAILED, 'OAuth flow already completed or cancelled');
      }
      try {
        const signals = [flowController.signal, opts.signal].filter(
          (signal): signal is AbortSignal => signal !== undefined,
        );
        const signal =
          signals.length === 0
            ? undefined
            : signals.length === 1
              ? signals[0]
              : AbortSignal.any(signals);
        const { code, state } = await callbackServer.waitForCode({
          signal,
          timeoutMs: opts.timeoutMs,
        });
        const expectedState = provider.expectedState();
        if (expectedState !== undefined && state !== expectedState) {
          throw new Error2(
            ErrorCodes.MCP_OAUTH_FAILED,
            'OAuth state mismatch — possible CSRF; refusing token exchange',
          );
        }
        const finalResult = await auth(provider as OAuthClientProvider, {
          serverUrl,
          authorizationCode: code,
        });
        if (finalResult !== 'AUTHORIZED') {
          throw new Error2(
            ErrorCodes.MCP_OAUTH_FAILED,
            `OAuth code exchange returned "${finalResult}" instead of AUTHORIZED`,
            { details: { result: finalResult } },
          );
        }
      } catch (error) {
        await cancel();
        throw wrapAuthError(`OAuth flow for "${serverName}" failed`, error);
      }
      settled = true;
      await callbackServer.close().catch(() => {});
      provider.resetFlow();
    };

    return { authorizationUrl, complete, cancel };
  }

  invalidate(
    serverName: string,
    serverUrl: string | URL,
    scope: 'all' | 'client' | 'tokens' | 'discovery' = 'all',
  ): Promise<void> {
    return this.getProvider(serverName, serverUrl).invalidateCredentials(scope);
  }
}

export class AlreadyAuthorizedError extends Error2 {
  constructor(serverName: string) {
    super(
      ErrorCodes.MCP_OAUTH_FAILED,
      `"${serverName}" is already authorized; no browser flow needed`,
    );
    this.name = 'AlreadyAuthorizedError';
  }
}

function wrapAuthError(prefix: string, error: unknown): Error2 {
  if (isError2(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new Error2(ErrorCodes.MCP_OAUTH_FAILED, `${prefix}: ${error.message}`, {
      cause: error,
    });
  }
  return new Error2(ErrorCodes.MCP_OAUTH_FAILED, `${prefix}: ${String(error)}`, { cause: error });
}
