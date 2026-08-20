import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import { ErrorCodes, Error2, isError2 } from '#/errors';

import { startCallbackServer, type CallbackServer } from './callback-server';
import type { McpOAuthCredentialsCoordinator } from './coordinator';
import { McpOAuthClientProvider, type StoredMcpOAuthTokens } from './provider';
import {
  canonicalMcpOAuthResource,
  mcpOAuthStoreKey,
  META_SUFFIX,
  type McpOAuthStore,
  type McpOAuthStoreMeta,
} from './store';

export interface McpOAuthServiceOptions {
  readonly store: McpOAuthStore;
  readonly clientLabel?: string;
  readonly resolveClientName?: () => string | undefined;
  /** Optional cross-service notification seam; receives credential changes. */
  readonly coordinator?: McpOAuthCredentialsCoordinator;
}

export interface BeginAuthorizationOptions {
  readonly clientLabel?: string;
}

export interface BeginAuthorizationResult {
  readonly authorizationUrl: URL;
  /**
   * Awaits the OAuth callback, validates `state`, exchanges the code for
   * tokens, and persists them via the provider. Resolves on success;
   * rejects on abort, timeout, or auth-server error.
   *
   * Handles sharing one underlying flow (concurrent `beginAuthorization`
   * calls for the same credential) run the wait and the exchange exactly
   * once: the first `complete()` call's `signal`/`timeoutMs` apply and the
   * rest await the same outcome.
   */
  complete(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  /**
   * Tears down the callback listener without finishing the flow. Only the
   * initiating handle cancels the shared flow; on a joined handle this just
   * detaches that caller. Safe to call repeatedly; called automatically by
   * `complete()`.
   */
  cancel(): Promise<void>;
}

/**
 * The single underlying interactive flow shared by every handle that
 * `beginAuthorization` hands out for the same credential store key.
 */
interface SharedAuthorizationFlow {
  readonly authorizationUrl: URL;
  /** Starts the wait-for-callback + code exchange on first call; later calls share the outcome. */
  readonly startCompletion: BeginAuthorizationResult['complete'];
  /** Tears down the callback listener and flow state; invoked by the initiating handle only. */
  readonly cancelUnderlying: () => Promise<void>;
}

export type McpOAuthEvent =
  | {
      readonly type: 'tokens-saved';
      readonly serverName: string;
      readonly serverUrl: string;
    }
  | {
      readonly type: 'tokens-invalidated';
      readonly serverName: string;
      readonly serverUrl: string;
      readonly scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery';
    }
  | {
      readonly type: 'refresh-failed';
      readonly serverName: string;
      readonly serverUrl: string;
      readonly error: string;
    };

export type McpOAuthEventListener = (event: McpOAuthEvent) => void;

export interface McpOAuthTokenState {
  readonly hasTokens: boolean;
  readonly hasRefreshToken: boolean;
  /** Absolute expiry in epoch ms, when the stored grant carries enough data. */
  readonly expiresAt?: number;
  readonly expired: boolean;
}

/** Refresh this far ahead of the absolute expiry. */
const REFRESH_AHEAD_MS = 120_000;
/** `setTimeout` cannot schedule beyond 2^31-1 ms; later saves/sweeps re-arm. */
const MAX_TIMER_DELAY_MS = 0x7fffffff;

export class McpOAuthService {
  private readonly store: McpOAuthStore;
  private readonly clientLabel: string | undefined;
  private readonly resolveClientName: (() => string | undefined) | undefined;
  private readonly coordinator: McpOAuthCredentialsCoordinator | undefined;
  private readonly providers = new Map<string, McpOAuthClientProvider>();
  private readonly listeners = new Set<McpOAuthEventListener>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  /** In-flight timer-triggered proactive refreshes, awaited by {@link shutdown}. */
  private readonly pendingProactiveRefreshes = new Set<Promise<void>>();
  private shutdownStarted = false;
  /** In-flight interactive flows by credential store key; values resolve to the shared flow. */
  private readonly activeAuthorizations = new Map<string, Promise<SharedAuthorizationFlow>>();

  constructor(options: McpOAuthServiceOptions) {
    this.store = options.store;
    this.clientLabel = options.clientLabel;
    this.resolveClientName = options.resolveClientName;
    this.coordinator = options.coordinator;
  }

  getProvider(serverName: string, serverUrl: string | URL): McpOAuthClientProvider {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    let provider = this.providers.get(storeKey);
    if (provider === undefined) {
      provider = this.createProvider(serverName, serverUrl);
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
    const tokens = (await this.getProvider(serverName, serverUrl).tokens()) as
      | StoredMcpOAuthTokens
      | undefined;
    if (tokens === undefined) {
      return { hasTokens: false, hasRefreshToken: false, expired: false };
    }
    const expiresAt =
      typeof tokens.obtained_at === 'number' && typeof tokens.expires_in === 'number'
        ? tokens.obtained_at + tokens.expires_in * 1000
        : undefined;
    return {
      hasTokens: true,
      hasRefreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0,
      expiresAt,
      expired: expiresAt !== undefined && Date.now() >= expiresAt,
    };
  }

  onEvent(listener: McpOAuthEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Single-flight token refresh per credential: concurrent callers share one
   * in-flight SDK `auth()` run, so two sessions expiring together cannot race
   * a rotating refresh token. Resolves when the grant is usable again;
   * rejects when the refresh token was rejected (or never existed) and an
   * interactive login is required.
   */
  async refresh(serverName: string, serverUrl: string | URL): Promise<void> {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    const existing = this.refreshes.get(storeKey);
    if (existing !== undefined) return existing;
    const task = this.refreshNow(serverName, serverUrl).finally(() => {
      this.refreshes.delete(storeKey);
    });
    this.refreshes.set(storeKey, task);
    return task;
  }

  /**
   * Arm the proactive refresh timer for every stored credential that carries
   * enough data to expire. Called once when the owning service initializes;
   * subsequent token writes re-arm through the provider save hook. A
   * malformed meta sidecar (or any per-credential failure) is skipped rather
   * than aborting the whole sweep.
   */
  async sweepProactiveRefresh(): Promise<void> {
    for (const file of await this.store.list(META_SUFFIX)) {
      const meta = await readStoreMeta(this.store, file);
      if (meta === undefined) continue;
      try {
        const state = await this.tokenState(meta.serverName, meta.serverUrl);
        if (!state.hasTokens || !state.hasRefreshToken || state.expiresAt === undefined) continue;
        this.scheduleRefresh(meta.serverName, meta.serverUrl, state.expiresAt);
      } catch {
        // A per-credential failure must not abort the startup sweep.
      }
    }
  }

  /** Clear every pending proactive-refresh timer (engine shutdown, tests). */
  stopProactiveRefresh(): void {
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
  }

  /**
   * Release everything the service owns: pending proactive-refresh timers,
   * in-flight proactive refreshes (awaited so their token writes and events
   * land before listeners are dropped), in-flight interactive flows (closing
   * their callback listeners), event listeners, and cached providers.
   * Idempotent.
   */
  async shutdown(): Promise<void> {
    this.shutdownStarted = true;
    this.stopProactiveRefresh();
    await Promise.all(this.pendingProactiveRefreshes);
    const inFlight = [...this.activeAuthorizations.values()];
    this.activeAuthorizations.clear();
    await Promise.all(
      inFlight.map(async (started) => {
        const flow = await started.catch(() => undefined);
        await flow?.cancelUnderlying();
      }),
    );
    this.listeners.clear();
    this.providers.clear();
  }

  /**
   * Drive the SDK `auth()` orchestrator far enough to surface an
   * authorization URL. The caller is responsible for displaying the URL
   * (typically via the synthetic authenticate tool) and then awaiting
   * `complete()` to finish the code exchange.
   *
   * Interactive flows are serialized per credential: while one flow for a
   * store key is in flight, further calls join it — same URL, shared
   * `complete()`, and a `cancel()` that only detaches the caller — instead
   * of resetting the shared provider's PKCE/state mid-flow.
   */
  async beginAuthorization(
    serverName: string,
    serverUrl: string | URL,
    options: BeginAuthorizationOptions = {},
  ): Promise<BeginAuthorizationResult> {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    const inFlight = this.activeAuthorizations.get(storeKey);
    if (inFlight !== undefined) {
      // A begin-phase failure (e.g. AlreadyAuthorizedError) propagates here.
      const flow = await inFlight;
      let detached = false;
      return {
        authorizationUrl: flow.authorizationUrl,
        complete: (opts = {}) => {
          if (detached) {
            return Promise.reject(
              new Error2(ErrorCodes.MCP_OAUTH_FAILED, 'OAuth flow already completed or cancelled'),
            );
          }
          return flow.startCompletion(opts);
        },
        cancel: () => {
          detached = true;
          return Promise.resolve();
        },
      };
    }

    // Reserve the slot before the first await, so a concurrent call for the
    // same credential (a `clientLabel` variant included — the key is the
    // same store key) joins this flow instead of racing a second one.
    const started = this.startAuthorizationFlow(serverName, serverUrl, options);
    this.activeAuthorizations.set(storeKey, started);
    let flow: SharedAuthorizationFlow;
    try {
      flow = await started;
    } catch (error) {
      // Begin-phase failures leave no active flow behind.
      this.activeAuthorizations.delete(storeKey);
      throw error;
    }
    return {
      authorizationUrl: flow.authorizationUrl,
      complete: (opts = {}) => flow.startCompletion(opts),
      cancel: () => flow.cancelUnderlying(),
    };
  }

  /**
   * The initiating side of an interactive flow: start the callback listener,
   * point the provider at it, and run `auth()` until it surfaces an
   * authorization URL. The returned flow owns the single wait-for-callback +
   * code exchange shared by every handle for this credential.
   */
  private async startAuthorizationFlow(
    serverName: string,
    serverUrl: string | URL,
    options: BeginAuthorizationOptions,
  ): Promise<SharedAuthorizationFlow> {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    const provider =
      options.clientLabel === undefined
        ? this.getProvider(serverName, serverUrl)
        : this.createProvider(serverName, serverUrl, options.clientLabel);
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
    // See invalidateStaleRegistration: a reused registration whose redirect
    // URIs no longer cover this flow's random-port callback would be rejected
    // at the authorization endpoint with an error only the browser ever sees.
    await provider.invalidateStaleRegistration(callbackServer.redirectUri);

    let authorizationUrl: URL | undefined;
    try {
      const result = await auth(provider as OAuthClientProvider, {
        serverUrl,
        fetchFn: provider.createOAuthFetch(),
      });
      if (result !== 'REDIRECT') {
        // Tokens already valid (e.g. unexpired refresh, or a grant written
        // by another process). Tell needs-auth sessions to pick them up.
        await callbackServer.close();
        this.emit({
          type: 'tokens-saved',
          serverName,
          serverUrl: canonicalMcpOAuthResource(serverUrl),
        });
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
    let completion: Promise<void> | undefined;
    const flowController = new AbortController();
    const settle = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      this.activeAuthorizations.delete(storeKey);
      // Release the provider's flow state before the first await: as soon as
      // the map entry is gone a new flow may begin on the same provider, and
      // a late resetFlow would clobber its redirect URL / PKCE state.
      provider.resetFlow();
      flowController.abort();
      await callbackServer.close().catch(() => {});
    };

    return {
      authorizationUrl,
      startCompletion: (opts = {}) => {
        if (completion !== undefined) return completion;
        if (settled) {
          return Promise.reject(
            new Error2(ErrorCodes.MCP_OAUTH_FAILED, 'OAuth flow already completed or cancelled'),
          );
        }
        completion = (async () => {
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
              fetchFn: provider.createOAuthFetch(),
            });
            if (finalResult !== 'AUTHORIZED') {
              throw new Error2(
                ErrorCodes.MCP_OAUTH_FAILED,
                `OAuth code exchange returned "${finalResult}" instead of AUTHORIZED`,
                { details: { result: finalResult } },
              );
            }
          } catch (error) {
            await settle();
            throw wrapAuthError(`OAuth flow for "${serverName}" failed`, error);
          }
          await settle();
        })();
        return completion;
      },
      cancelUnderlying: settle,
    };
  }

  /**
   * Clear stored credentials for a server. Use `'all'` after the user
   * explicitly signs out; use `'tokens'` to force a re-auth while keeping
   * the registered DCR client.
   */
  invalidate(
    serverName: string,
    serverUrl: string | URL,
    scope: 'all' | 'client' | 'tokens' | 'discovery' = 'all',
  ): Promise<void> {
    return this.getProvider(serverName, serverUrl).clearCredentials(scope);
  }

  /**
   * Drop the cached provider for a credential. After an invalidation this
   * guarantees the next `beginAuthorization` starts from a clean in-memory
   * flow state (files are always re-read, so this is defensive).
   */
  forgetProvider(serverName: string, serverUrl: string | URL): void {
    this.providers.delete(mcpOAuthStoreKey(serverName, serverUrl));
  }

  private createProvider(
    serverName: string,
    serverUrl: string | URL,
    clientLabel?: string,
  ): McpOAuthClientProvider {
    const canonicalUrl = canonicalMcpOAuthResource(serverUrl);
    return new McpOAuthClientProvider({
      serverName,
      serverUrl,
      store: this.store,
      clientLabel: clientLabel ?? this.clientLabel,
      clientName: this.resolveClientName?.(),
      onTokensSaved: (tokens) => {
        this.emit({ type: 'tokens-saved', serverName, serverUrl: canonicalUrl });
        if (typeof tokens.obtained_at === 'number' && typeof tokens.expires_in === 'number') {
          this.scheduleRefresh(serverName, canonicalUrl, tokens.obtained_at + tokens.expires_in * 1000);
        }
      },
      onCredentialsInvalidated: (scope) => {
        if (scope === 'tokens' || scope === 'all') {
          this.cancelScheduledRefresh(serverName, canonicalUrl);
        }
        this.emit({ type: 'tokens-invalidated', serverName, serverUrl: canonicalUrl, scope });
      },
    });
  }

  private async refreshNow(serverName: string, serverUrl: string | URL): Promise<void> {
    // An interactive authorization for this credential owns the shared
    // provider's PKCE/redirect state right now; resetting it here would break
    // the user's in-flight browser flow. The flow produces fresh tokens on
    // completion, and the transport 401 path remains the backstop if it
    // fails — so skip rather than race it.
    if (this.activeAuthorizations.has(mcpOAuthStoreKey(serverName, serverUrl))) return;
    const state = await this.tokenState(serverName, serverUrl);
    if (!state.hasTokens || !state.hasRefreshToken) {
      throw new Error2(
        ErrorCodes.MCP_OAUTH_FAILED,
        `MCP server "${serverName}" has no refreshable OAuth grant`,
      );
    }
    const provider = this.getProvider(serverName, serverUrl);
    provider.resetFlow();
    try {
      // The SDK refreshes whenever a refresh token exists, without checking
      // the access-token expiry — exactly what a proactive refresh wants. A
      // rejected refresh token falls through to the interactive branch and
      // comes back as REDIRECT, which this non-interactive path treats as
      // failure. The token request must ride the provider's fetch wrapper:
      // OAuthTokenTransaction serializes grants per credential, so without it
      // a slower response carrying an older rotating refresh token could be
      // persisted over a newer grant written by a concurrent 401 refresh.
      const result = await auth(provider as OAuthClientProvider, {
        serverUrl,
        fetchFn: provider.createOAuthFetch(),
      });
      if (result !== 'AUTHORIZED') {
        throw new Error2(
          ErrorCodes.MCP_OAUTH_FAILED,
          'the stored OAuth grant requires an interactive login',
        );
      }
    } finally {
      provider.resetFlow();
    }
  }

  private scheduleRefresh(serverName: string, serverUrl: string | URL, expiresAt: number): void {
    if (this.shutdownStarted) return;
    const canonicalUrl = canonicalMcpOAuthResource(serverUrl);
    const storeKey = mcpOAuthStoreKey(serverName, canonicalUrl);
    this.cancelScheduledRefresh(serverName, canonicalUrl);
    const now = Date.now();
    // Already-expired grants are never refreshed proactively: the grant may
    // belong to a server nobody connects to anymore, so firing a network
    // refresh on boot/save would be wasted work. The connect path (the
    // transport's 401-driven refresh) remains the backstop for live servers.
    if (expiresAt <= now) return;
    const delay = expiresAt - now - REFRESH_AHEAD_MS;
    let timer: NodeJS.Timeout;
    if (delay > MAX_TIMER_DELAY_MS) {
      // setTimeout cannot schedule beyond 2^31-1 ms. Arm the maximum and
      // recompute on firing, so far-future grants are rescheduled instead of
      // never being refreshed proactively.
      timer = setTimeout(() => {
        this.refreshTimers.delete(storeKey);
        this.scheduleRefresh(serverName, canonicalUrl, expiresAt);
      }, MAX_TIMER_DELAY_MS);
    } else {
      // delay <= 0 means the grant is already inside the ahead-of-expiry
      // window but still valid — refresh immediately. Refresh is
      // single-flight per credential, so duplicate triggers are safe.
      timer = setTimeout(
        () => {
          this.refreshTimers.delete(storeKey);
          const pending = this.refresh(serverName, canonicalUrl).catch((error: unknown) => {
            this.emit({
              type: 'refresh-failed',
              serverName,
              serverUrl: canonicalUrl,
              error: error instanceof Error ? error.message : String(error),
            });
          });
          this.pendingProactiveRefreshes.add(pending);
          void pending.finally(() => {
            this.pendingProactiveRefreshes.delete(pending);
          });
        },
        Math.max(delay, 0),
      );
    }
    timer.unref();
    this.refreshTimers.set(storeKey, timer);
  }

  private cancelScheduledRefresh(serverName: string, serverUrl: string | URL): void {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    const timer = this.refreshTimers.get(storeKey);
    if (timer !== undefined) clearTimeout(timer);
    this.refreshTimers.delete(storeKey);
  }

  private emit(event: McpOAuthEvent): void {
    if (
      event.type === 'tokens-saved' ||
      (event.type === 'tokens-invalidated' && (event.scope === 'tokens' || event.scope === 'all'))
    ) {
      const url = event.serverUrl;
      if (event.type === 'tokens-saved') {
        this.coordinator?.notifyCredentialsChanged(event.serverName, url);
      } else {
        this.coordinator?.notifyCredentialsInvalidated(event.serverName, url);
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener faults must not break credential persistence.
      }
    }
  }
}

/** Thrown by `beginAuthorization` when stored tokens already satisfy the server. */
export class AlreadyAuthorizedError extends Error2 {
  constructor(serverName: string) {
    super(
      ErrorCodes.MCP_OAUTH_FAILED,
      `"${serverName}" is already authorized; no browser flow needed`,
    );
    this.name = 'AlreadyAuthorizedError';
  }
}

/**
 * Read and validate one `<key>-meta.json` sidecar. `McpOAuthStore.read` only
 * guarantees parseable JSON, so the shape is checked field by field; a
 * malformed sidecar is skipped instead of aborting the startup sweep.
 */
async function readStoreMeta(
  store: McpOAuthStore,
  file: string,
): Promise<McpOAuthStoreMeta | undefined> {
  const raw: unknown = await store.read(file);
  // undefined: the file vanished between list and read, or held corrupt JSON.
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { serverName, serverUrl } = raw as Record<string, unknown>;
  if (typeof serverName !== 'string' || serverName.length === 0 || typeof serverUrl !== 'string') {
    return undefined;
  }
  if (URL.parse(serverUrl) === null) return undefined;
  return { serverName, serverUrl };
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