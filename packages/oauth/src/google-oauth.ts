import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import {
  GOOGLE_GEMINI_DEFAULT_MODEL_ID,
  GOOGLE_GEMINI_DEFAULT_MODELS,
  GOOGLE_GEMINI_PROVIDER_ID,
  type GoogleGeminiModelDef,
} from './google-models';
import type { ManagedKimiConfigShape, ManagedKimiModelAlias } from './managed-kimi-code';
import { FileTokenStorage, type TokenStorage } from './storage';
import type { TokenInfo } from './types';

export {
  GOOGLE_GEMINI_DEFAULT_MODEL_ID,
  GOOGLE_GEMINI_DEFAULT_MODELS,
  GOOGLE_GEMINI_PROVIDER_ID,
  type GoogleGeminiModelDef,
};

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// Default Google OAuth Client ID for native/desktop applications.
// Can be customized via GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.
export const GOOGLE_DEFAULT_CLIENT_ID =
  process.env['GOOGLE_CLIENT_ID'] ||
  '936475272427-0g70b74pf7e34q5g72r9r1m05a415a7i.apps.googleusercontent.com';
export const GOOGLE_DEFAULT_CLIENT_SECRET = process.env['GOOGLE_CLIENT_SECRET'] || '';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/generative-language',
  'https://www.googleapis.com/auth/cloud-platform',
  'openid',
  'email',
  'profile',
];

export interface GoogleOAuthOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scopes?: readonly string[];
  readonly storage?: TokenStorage;
  readonly credentialsDir?: string;
}

export interface GoogleDeviceAuthorization {
  readonly authUrl: string;
  readonly codeVerifier: string;
  readonly state: string;
  readonly port: number;
}

export interface GoogleLoginResult {
  readonly token: TokenInfo;
  readonly providerName: string;
  readonly email?: string;
}

export class GoogleOAuthManager {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly scopes: readonly string[];
  private readonly storage: TokenStorage;
  public readonly tokenName = GOOGLE_GEMINI_PROVIDER_ID;

  constructor(options: GoogleOAuthOptions = {}) {
    this.clientId = options.clientId ?? GOOGLE_DEFAULT_CLIENT_ID;
    this.clientSecret = options.clientSecret ?? GOOGLE_DEFAULT_CLIENT_SECRET;
    this.scopes = options.scopes ?? GOOGLE_SCOPES;
    if (options.storage !== undefined) {
      this.storage = options.storage;
    } else {
      const kimiHome =
        process.env['KIMI_CODE_HOME'] ||
        join(process.env['HOME'] || process.env['USERPROFILE'] || '.', '.kimi-code');
      const credentialsDir = options.credentialsDir ?? join(kimiHome, 'credentials');
      this.storage = new FileTokenStorage(credentialsDir);
    }
  }

  async loadToken(): Promise<TokenInfo | undefined> {
    return this.storage.load(this.tokenName);
  }

  async saveToken(token: TokenInfo): Promise<void> {
    await this.storage.save(this.tokenName, token);
  }

  async logout(): Promise<void> {
    await this.storage.remove(this.tokenName);
  }

  async hasToken(): Promise<boolean> {
    const token = await this.loadToken();
    return token !== undefined && token.accessToken.length > 0;
  }

  async getValidAccessToken(): Promise<string | undefined> {
    let token = await this.loadToken();
    if (!token) {
      token = await this.importAntigravityCredentials();
      if (!token) return undefined;
    }

    const now = Math.floor(Date.now() / 1000);
    // Refresh if within 5 minutes of expiration
    if (token.expiresAt > 0 && token.expiresAt - now < 300) {
      if (token.refreshToken.length > 0) {
        try {
          const refreshed = await this.refreshToken(token.refreshToken);
          await this.saveToken(refreshed);
          return refreshed.accessToken;
        } catch {
          // Refresh failed (e.g. imported client token). Try re-reading Antigravity credentials
          const synced = await this.importAntigravityCredentials();
          if (synced && synced.accessToken.length > 0) {
            return synced.accessToken;
          }
          if (token.accessToken.length > 0) return token.accessToken;
        }
      }
    }
    return token.accessToken.length > 0 ? token.accessToken : undefined;
  }

  async refreshToken(refreshToken: string): Promise<TokenInfo> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    if (this.clientSecret.length > 0) {
      params.set('client_secret', this.clientSecret);
    }

    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google token refresh failed (HTTP ${res.status}): ${text}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const accessToken = typeof data['access_token'] === 'string' ? data['access_token'] : '';
    const expiresIn = Number(data['expires_in'] ?? 3600);
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    const scope = typeof data['scope'] === 'string' ? data['scope'] : this.scopes.join(' ');
    const tokenType = typeof data['token_type'] === 'string' ? data['token_type'] : 'Bearer';

    return {
      accessToken,
      refreshToken: typeof data['refresh_token'] === 'string' ? data['refresh_token'] : refreshToken,
      expiresAt,
      scope,
      tokenType,
      expiresIn,
    };
  }

  async startLoginFlow(options: {
    readonly signal?: AbortSignal;
    readonly onAuthUrl?: (data: GoogleDeviceAuthorization) => void;
  } = {}): Promise<GoogleLoginResult> {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = randomBytes(16).toString('hex');

    return new Promise((resolve, reject) => {
      let server: Server | undefined;
      let cleanupDone = false;

      const cleanup = (): void => {
        if (cleanupDone) return;
        cleanupDone = true;
        if (server) {
          try {
            server.close();
          } catch {
            /* ignore */
          }
        }
      };

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          cleanup();
          reject(new Error('Google login aborted'));
        });
      }

      const handleCallback = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
          const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1`);
          if (reqUrl.pathname !== '/oauth2callback') {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }

          const error = reqUrl.searchParams.get('error');
          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<html><body><h2>Google 授权失败 / Authorization Failed</h2><p>${error}</p></body></html>`);
            cleanup();
            reject(new Error(`Google authorization returned error: ${error}`));
            return;
          }

          const returnedState = reqUrl.searchParams.get('state');
          if (returnedState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body><h2>CSRF State Mismatch</h2></body></html>');
            cleanup();
            reject(new Error('Google authorization state mismatch'));
            return;
          }

          const code = reqUrl.searchParams.get('code');
          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body><h2>Missing authorization code</h2></body></html>');
            cleanup();
            reject(new Error('No authorization code returned from Google'));
            return;
          }

          // Exchange code for token
          const redirectUri = `http://127.0.0.1:${(server?.address() as { port: number })?.port}/oauth2callback`;
          const tokenParams = new URLSearchParams({
            client_id: this.clientId,
            code,
            code_verifier: codeVerifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
          });
          if (this.clientSecret.length > 0) {
            tokenParams.set('client_secret', this.clientSecret);
          }

          const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenParams.toString(),
          });

          if (!tokenRes.ok) {
            const errBody = await tokenRes.text();
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<html><body><h2>Token exchange failed</h2><p>${errBody}</p></body></html>`);
            cleanup();
            reject(new Error(`Google token exchange failed (HTTP ${tokenRes.status}): ${errBody}`));
            return;
          }

          const tokenData = (await tokenRes.json()) as Record<string, unknown>;
          const accessToken =
            typeof tokenData['access_token'] === 'string' ? tokenData['access_token'] : '';
          const refreshToken =
            typeof tokenData['refresh_token'] === 'string' ? tokenData['refresh_token'] : '';
          const expiresIn = Number(tokenData['expires_in'] ?? 3600);
          const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
          const scope =
            typeof tokenData['scope'] === 'string' ? tokenData['scope'] : this.scopes.join(' ');
          const tokenType =
            typeof tokenData['token_type'] === 'string' ? tokenData['token_type'] : 'Bearer';

          const token: TokenInfo = {
            accessToken,
            refreshToken,
            expiresAt,
            scope,
            tokenType,
            expiresIn,
          };

          await this.saveToken(token);

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html lang="zh-CN">
            <head>
              <meta charset="utf-8">
              <title>Google 授权成功</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
                .card { background: #1e293b; padding: 40px 48px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; max-width: 420px; }
                h2 { color: #38bdf8; margin-top: 0; font-size: 24px; }
                p { color: #94a3b8; font-size: 15px; line-height: 1.6; }
                .btn { display: inline-block; margin-top: 16px; padding: 10px 20px; background: #38bdf8; color: #0f172a; border-radius: 8px; text-decoration: none; font-weight: 600; }
              </style>
            </head>
            <body>
              <div class="card">
                <h2>🎉 Google 授权成功！</h2>
                <p>Kimi Code 已成功绑定您的 Google 账号（Gemini Pro）。<br>您可以关闭此标签页并返回终端继续编程。</p>
              </div>
            </body>
            </html>
          `);

          cleanup();
          resolve({
            token,
            providerName: GOOGLE_GEMINI_PROVIDER_ID,
          });
        } catch (error) {
          cleanup();
          reject(error);
        }
      };

      server = createServer((req, res) => {
        void handleCallback(req, res);
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server?.address() as { port: number };
        const port = addr.port;
        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

        const authParams = new URLSearchParams({
          client_id: this.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: this.scopes.join(' '),
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent',
        });

        const authUrl = `${GOOGLE_AUTH_ENDPOINT}?${authParams.toString()}`;

        options.onAuthUrl?.({
          authUrl,
          codeVerifier,
          state,
          port,
        });
      });

      server.on('error', (err) => {
        cleanup();
        reject(err);
      });
    });
  }

  /**
   * Checks if Google Antigravity credentials exist locally (~/.gemini/oauth_creds.json).
   */
  static detectAntigravityCredentials(): {
    readonly available: boolean;
    readonly email?: string;
    readonly credsPath?: string;
  } {
    const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
    if (!home) return { available: false };
    const credsPath = join(home, '.gemini', 'oauth_creds.json');
    const accountsPath = join(home, '.gemini', 'google_accounts.json');
    if (!existsSync(credsPath)) return { available: false };

    let email: string | undefined;
    if (existsSync(accountsPath)) {
      try {
        const raw = readFileSync(accountsPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.active === 'string') {
          email = parsed.active;
        }
      } catch {}
    }

    return {
      available: true,
      email,
      credsPath,
    };
  }

  /**
   * Imports existing credentials from Google Antigravity (~/.gemini/oauth_creds.json)
   * into Kimi Code's credentials store.
   */
  async importAntigravityCredentials(): Promise<TokenInfo | undefined> {
    const detection = GoogleOAuthManager.detectAntigravityCredentials();
    if (!detection.available || !detection.credsPath) return undefined;

    try {
      const raw = readFileSync(detection.credsPath, 'utf8');
      const creds = JSON.parse(raw);
      if (!creds || typeof creds.access_token !== 'string') return undefined;

      const expiresAt = creds.expiry_date
        ? Math.floor(creds.expiry_date / 1000)
        : Math.floor(Date.now() / 1000) + 3600;
      const expiresIn = Math.max(expiresAt - Math.floor(Date.now() / 1000), 0);

      const tokenInfo: TokenInfo = {
        accessToken: creds.access_token,
        refreshToken: creds.refresh_token ?? '',
        tokenType: creds.token_type ?? 'Bearer',
        expiresAt,
        expiresIn,
        scope: creds.scope ?? '',
      };

      await this.saveToken(tokenInfo);
      return tokenInfo;
    } catch {
      return undefined;
    }
  }
}

export function applyGoogleGeminiConfig(
  config: ManagedKimiConfigShape,
  options: {
    readonly authType: 'oauth' | 'api_key';
    readonly apiKey?: string;
    readonly models?: readonly GoogleGeminiModelDef[];
    readonly selectedModel?: string;
    readonly thinking?: boolean;
    readonly effort?: string;
  },
): { readonly defaultModel: string; readonly defaultThinking: boolean } {
  const providerKey = GOOGLE_GEMINI_PROVIDER_ID;
  const models = options.models ?? GOOGLE_GEMINI_DEFAULT_MODELS;
  const selectedModelId = options.selectedModel ?? GOOGLE_GEMINI_DEFAULT_MODEL_ID;
  const defaultModelKey = `${providerKey}/${selectedModelId}`;

  config.providers[providerKey] = {
    type: 'google-genai',
    ...(options.authType === 'oauth'
      ? {
          oauth: {
            storage: 'file',
            key: providerKey,
          },
        }
      : {}),
    ...(options.apiKey !== undefined && options.apiKey.length > 0 ? { apiKey: options.apiKey } : {}),
  };

  const existingModels = config.models ?? {};
  for (const model of models) {
    const aliasKey = `${providerKey}/${model.id}`;
    const caps: string[] = ['image_in', 'video_in', 'tool_use'];
    if (model.supportsReasoning) {
      caps.push('thinking');
    }
    const alias: ManagedKimiModelAlias = {
      provider: providerKey,
      model: model.id,
      maxContextSize: model.contextLength,
      capabilities: caps,
      displayName: model.displayName,
      ...(model.supportEfforts !== undefined ? { supportEfforts: [...model.supportEfforts] } : {}),
      ...(model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {}),
    };
    existingModels[aliasKey] = alias;
  }

  config.models = existingModels;
  config.defaultModel = defaultModelKey;
  config.thinking = {
    ...config.thinking,
    enabled: options.thinking ?? true,
    ...(options.effort !== undefined ? { effort: options.effort } : { effort: 'high' }),
  };

  return { defaultModel: defaultModelKey, defaultThinking: options.thinking ?? true };
}
