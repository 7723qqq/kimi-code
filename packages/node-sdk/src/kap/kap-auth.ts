import type { AuthStatus } from '@moonshot-ai/kimi-code-oauth';
import type { AuthSummary, OAuthFlowSnapshot, OAuthFlowStart, OAuthLogoutResponse } from '@moonshot-ai/protocol';

import { KimiAuthFacade, type KimiAuthLoginResult, type KimiAuthLogoutResult } from '#/auth';

import type { KapHttpClient } from './http-client';

export class KapAuthFacade extends KimiAuthFacade {
  private readonly http: KapHttpClient;

  constructor(options: ConstructorParameters<typeof KimiAuthFacade>[0] & { http: KapHttpClient }) {
    super(options);
    this.http = options.http;
  }

  override async status(providerName?: string): Promise<AuthStatus> {
    void providerName;
    const summary = await this.http.get<AuthSummary>('/auth');
    const providers = [];
    if (summary.managed_provider !== null) {
      providers.push({
        providerName: summary.managed_provider.name,
        hasToken: summary.managed_provider.status === 'authenticated',
      });
    }
    return { providers } as AuthStatus;
  }

  override async login(providerName?: string, options: { signal?: AbortSignal; onDeviceCode?: (code: { userCode: string; verificationUri: string }) => void } = {}): Promise<KimiAuthLoginResult> {
    const start = await this.http.post<OAuthFlowStart>('/oauth/login', {
      ...(providerName !== undefined ? { provider: providerName } : {}),
    });
    options.onDeviceCode?.({
      userCode: start.user_code,
      verificationUri: start.verification_uri,
    });
    // Poll until the device-code flow completes or the signal aborts.
    while (true) {
      if (options.signal?.aborted) {
        await this.http.delete('/oauth/login', { ...(providerName !== undefined ? { provider: providerName } : {}) });
        throw new Error('login aborted');
      }
      const snapshot = await this.http.get<OAuthFlowSnapshot | null>('/oauth/login', {
        ...(providerName !== undefined ? { provider: providerName } : {}),
      });
      if (snapshot !== null && snapshot.status === 'authenticated') {
        return { providerName: snapshot.provider, ok: true, defaultModel: '', defaultThinking: false };
      }
      if (snapshot === null || snapshot.status === 'denied' || snapshot.status === 'expired' || snapshot.status === 'cancelled') {
        throw new Error(`OAuth login ${snapshot?.status ?? 'cancelled'}`);
      }
      await sleep((start.interval ?? 5) * 1000);
    }
  }

  override async logout(providerName?: string): Promise<KimiAuthLogoutResult> {
    const result = await this.http.post<OAuthLogoutResponse>('/oauth/logout', {
      ...(providerName !== undefined ? { provider: providerName } : {}),
    });
    return { providerName: result.provider, ok: true };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
