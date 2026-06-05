/**
 * `HarnessBridge` — the in-process RPC bridge owned by the services package.
 * Internally:
 *
 *   1. `createRPC<CoreAPI, SDKAPI>()` produces a `[coreRpc, sdkRpc]` pair of
 *      `RPCClient` functions (packages/agent-core/src/rpc/client.ts:31-103).
 *   2. `new KimiCore(coreRpc, options)` — the core is constructed with the
 *      core-side RPC client (it calls into the SDK side over `coreRpc`).
 *   3. `sdkRpc(new BridgeClientAPI({ ... }))` — the SDK side of the pair is
 *      satisfied by a `BridgeClientAPI` instance whose `SDKAPI` methods route
 *      to DI-resolved brokers. Returns `Promise<RPCMethods<CoreAPI>>` — the
 *      core RPC methods that future positive services (W4+/Phase 1) will use.
 *
 * The result is wrapped in a small `SDKRpcClient`-shaped facade so that
 * service impls (Chain 1+) get the same ergonomics as `@moonshot-ai/kimi-code-sdk`
 * (`SDKRpcClientBase` subclass). The facade is exposed as `rpc` for in-package
 * consumers; the public package barrel does NOT re-export `SDKRpcClientBase`,
 * so daemon-side code stays one abstraction layer away.
 *
 * Lifecycle:
 *   - `ready()` resolves when both the `KimiCore` plugin/config load AND the
 *     SDK-side RPC binding have settled. Construction is eager (Singleton
 *     pattern); awaiting `ready()` is the safe gate before issuing RPC calls.
 *   - `dispose()` is idempotent. It flips an internal flag so future `rpc`
 *     method dispatch throws before reaching `KimiCore`, then walks the
 *     `Disposable` child stack. `KimiCore` itself has no `dispose()` today —
 *     when it gets one (PLAN Stage 2), we wire it here.
 */

import {
  createDecorator,
  createRPC,
  Disposable,
  KimiCore,
  resolveConfigPath,
  resolveKimiHome,
  type CoreAPI,
  type CoreRPC,
  type KimiCoreOptions,
  type OAuthTokenProviderResolver,
  type SDKAPI,
} from '@moonshot-ai/agent-core';
import {
  createKimiDefaultHeaders,
  type KimiHostIdentity,
} from '@moonshot-ai/kimi-code-oauth';
import { KimiAuthFacade } from '@moonshot-ai/kimi-code-sdk';

import { BridgeClientAPI } from './bridge-client-api';
import { IApprovalBroker } from '../interfaces/approval-broker';
import { IEventBus } from '../interfaces/event-bus';
import { IQuestionBroker } from '../interfaces/question-broker';

export interface HarnessBridgeOptions extends KimiCoreOptions {
  /**
   * Host identity (product name + version). When set and
   * `kimiRequestHeaders` is omitted, the bridge default-wires
   * `createKimiDefaultHeaders({ homeDir, ...identity })` into KimiCore so
   * upstream sees `User-Agent: <product>/<version>` + `X-Msh-Platform: …`.
   * Without this, the managed Kimi-for-Coding endpoint rejects requests
   * with 40340 ("only available for Coding Agents") because the default
   * fetch User-Agent doesn't match any known coding-agent product.
   *
   * `identity.version` also feeds `appVersion` so session records carry
   * the host CLI version — same wiring `SDKRpcClient` does in node-sdk.
   *
   * Callers can still pass explicit `kimiRequestHeaders` (or `appVersion`)
   * to override; the explicit values win.
   */
  readonly identity?: KimiHostIdentity;
}

/**
 * Read-only view onto the core RPC that the bridge exposes to in-package
 * service impls. Members are dispatched eagerly through the RPC; calls before
 * `ready()` resolves queue inside `RPCClient`'s controlled-promise plumbing.
 */
export type HarnessRPC = CoreRPC;

export interface IHarnessBridge {
  /** The core RPC methods. Service impls call e.g. `bridge.rpc.createSession(...)`. */
  readonly rpc: HarnessRPC;

  /**
   * Resolves once `KimiCore` is fully constructed and the SDK side of the
   * in-process RPC has been bound. Repeated calls return the cached promise.
   */
  ready(): Promise<void>;

  /**
   * Tear down the bridge. After dispose, `rpc.<method>(...)` rejects with a
   * "bridge disposed" error before reaching `KimiCore`. Idempotent.
   */
  dispose(): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IHarnessBridge = createDecorator<IHarnessBridge>('IHarnessBridge');

export class HarnessBridge extends Disposable implements IHarnessBridge {
  /**
   * Service-facing RPC handle. This is a `Proxy` over the awaited
   * `RPCMethods<CoreAPI>` so callers don't have to await a promise themselves
   * — `bridge.rpc.createSession({...})` returns a `Promise<SessionSummary>`
   * directly. After dispose, the proxy rejects on every method invocation.
   */
  public readonly rpc: HarnessRPC;

  /**
   * The in-process `KimiCore` instance. Kept private so daemon-side code can't
   * grab it and bypass the broker indirection.
   */
  private readonly _core: KimiCore;

  /**
   * Promise that resolves to the resolved RPC methods. The bridge's `rpc`
   * proxy awaits this on every dispatch (cheap — controlled-promise resolves
   * synchronously on the second call).
   */
  private readonly _coreRpcPromise: Promise<CoreRPC>;

  /**
   * Cached readiness signal. We treat "SDK-side RPC bound" as the readiness
   * marker today; once `KimiCore.pluginsReady` is publicly exposed we can
   * combine them here.
   */
  private readonly _ready: Promise<void>;

  constructor(
    // P2.5: VSCode-style static-first / services-last ctor. `options`
    // moves to the prefix because it's a config bag, not a DI dep.
    // The brokers + event bus are auto-injected by the container; the
    // caller (daemon start.ts) passes `options` (or `{}`). The inline
    // default is dropped because TS forbids a required param after an
    // optional one — call sites already pass an explicit object.
    options: HarnessBridgeOptions,
    @IEventBus eventBus: IEventBus,
    @IApprovalBroker approvalBroker: IApprovalBroker,
    @IQuestionBroker questionBroker: IQuestionBroker,
  ) {
    super();

    // 1. Build the in-process RPC pair. Left/Right are typed; `coreRpc` is the
    //    function KimiCore receives, `sdkRpc` is the one the bridge satisfies.
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();

    // Default-wire the OAuth token resolver. Without this, KimiCore's
    // `ProviderManager.resolveAuth` sees `resolveOAuthTokenProvider ===
    // undefined` and synthesizes a closure that ALWAYS throws
    // `AUTH_LOGIN_REQUIRED` — even after a successful device-code login that
    // persisted a fresh token to disk. The daemon's `/auth` readiness probe
    // is a different code path (file existence on the credentials store) so
    // it stays green; the failure only surfaces inside the prompt turn, as
    // an `auth.login_required` error after `turn.step.started`. We bridge
    // the gap by default-constructing a `KimiAuthFacade` against the same
    // home + config paths KimiCore will use, and handing its
    // `resolveOAuthTokenProvider` into the core. Callers (e.g. node-sdk
    // tests) can still override via `options.resolveOAuthTokenProvider`.
    const resolveOAuthTokenProvider: OAuthTokenProviderResolver =
      options.resolveOAuthTokenProvider ??
      HarnessBridge._defaultOAuthTokenResolver(options);

    // Default-wire the Kimi request headers (User-Agent + X-Msh-* device
    // identity). Without this, KimiCore's outbound fetch carries the
    // default Node fetch User-Agent and the managed Kimi-for-Coding
    // endpoint rejects with 40340 ("only available for Coding Agents
    // such as Kimi CLI, Claude Code, …"). Mirrors what `SDKRpcClient`
    // does for the in-process TUI path (node-sdk's sdk-rpc-client.ts).
    // Caller-supplied `kimiRequestHeaders` always wins; absent that, we
    // synthesize from `options.identity`. Hosts that pass neither
    // (no identity, no headers) still construct — preserves the W3
    // contract — but their requests will trip the 40340 guard.
    const kimiRequestHeaders: Record<string, string> | undefined =
      options.kimiRequestHeaders ??
      HarnessBridge._defaultKimiRequestHeaders(options);

    // `appVersion` flows into Session records (`app_version`) and tool
    // call ctx. Prefer explicit > identity.version so callers can pin
    // a different value if they need to.
    const appVersion: string | undefined =
      options.appVersion ?? options.identity?.version;

    // 2. Construct the core. KimiCore's ctor wires itself into `coreRpc` and
    //    exposes `this.sdk: Promise<SDKRPC>` for the reverse direction.
    this._core = new KimiCore(coreRpc, {
      ...options,
      kimiRequestHeaders,
      appVersion,
      resolveOAuthTokenProvider,
    });

    // 3. Satisfy the SDK side with a BridgeClientAPI that routes to brokers.
    //    sdkRpc returns Promise<RPCMethods<CoreAPI>> — these are the methods
    //    in-package services will dispatch on.
    const clientApi = new BridgeClientAPI({
      eventBus,
      approvalBroker,
      questionBroker,
    });
    this._coreRpcPromise = sdkRpc(clientApi);

    // 4. Readiness is "the RPC pair is bound on both sides". Plugin load
    //    happens inside KimiCore's ctor and self-heals (the worker captures
    //    the error rather than surfacing it; see core-impl.ts:170-172).
    this._ready = this._coreRpcPromise.then(() => undefined);

    // 5. Build the dispatch proxy. Each method on the proxy awaits the resolved
    //    RPC methods then forwards. After dispose, dispatch rejects eagerly.
    this.rpc = this._buildRpcProxy();
  }

  async ready(): Promise<void> {
    return this._ready;
  }

  override dispose(): void {
    if (this._isDisposed) return;
    // KimiCore does not currently expose a dispose() — when it does (PLAN
    // Stage 2), we'll await/call it here BEFORE super.dispose(). For now,
    // disposing the bridge flips _disposed, which makes future rpc.*
    // invocations reject before they reach KimiCore.
    super.dispose();
  }

  private _buildRpcProxy(): HarnessRPC {
    const rpcPromise = this._coreRpcPromise;
    const isDisposedRef = () => this._isDisposed;

    // We don't know the concrete method set at compile time here (CoreAPI is
    // a structural interface; `RPCMethods<CoreAPI>` is a mapped type).
    // The Proxy lets us intercept every property access and return a function
    // that awaits the underlying RPC and forwards.
    return new Proxy({} as HarnessRPC, {
      get(_target, prop) {
        // Symbols / well-known properties (Symbol.toPrimitive, then-able
        // probe, etc.) should not be RPC-dispatched.
        if (typeof prop !== 'string') return undefined;
        // Returning a function keeps `typeof rpc.foo === 'function'` true,
        // which downstream code may probe.
        return (...args: unknown[]) => {
          if (isDisposedRef()) {
            return Promise.reject(new Error('HarnessBridge has been disposed'));
          }
          return rpcPromise.then((methods) => {
            const fn = (methods as unknown as Record<string, unknown>)[prop];
            if (typeof fn !== 'function') {
              return Promise.reject(
                new Error(`HarnessBridge.rpc.${prop} is not a function`),
              );
            }
            return (fn as (...args: unknown[]) => unknown)(...args);
          });
        };
      },
    });
  }

  /**
   * Build the default `resolveOAuthTokenProvider` from the same home + config
   * paths KimiCore resolves internally. Mirrors `SDKRpcClient`'s default in
   * `packages/node-sdk/src/sdk-rpc-client.ts` so the daemon and the SDK
   * runtimes share OAuth credentials when both run against the same
   * `~/.kimi-code`.
   *
   * Exposed as `static` so tests can assert the wiring without exercising the
   * full agent-core turn loop.
   */
  static _defaultOAuthTokenResolver(
    options: HarnessBridgeOptions,
  ): OAuthTokenProviderResolver {
    const homeDir = resolveKimiHome(options.homeDir);
    const configPath = resolveConfigPath({
      homeDir: options.homeDir,
      configPath: options.configPath,
    });
    const facade = new KimiAuthFacade({ homeDir, configPath });
    return facade.resolveOAuthTokenProvider;
  }

  /**
   * Build the default `kimiRequestHeaders` from `options.identity` so the
   * outbound `User-Agent` + device-identity headers identify this process
   * as a real Coding Agent host (e.g. `kimi-code-cli/<ver>`). Without
   * these, the managed Kimi-for-Coding endpoint rejects with 40340.
   *
   * Returns `undefined` when no identity is provided — preserves the
   * pre-fix W3 contract for hosts that pass headers explicitly via
   * `options.kimiRequestHeaders` (or for legacy callers / tests that
   * don't talk to the managed endpoint at all).
   *
   * `homeDir` resolution matches KimiCore's so the per-device id (minted
   * + cached at `<homeDir>/device_id` on first call) lives in the same
   * root as everything else KimiCore touches.
   *
   * Exposed as `static` so tests can assert the wiring without booting
   * the bridge.
   */
  static _defaultKimiRequestHeaders(
    options: HarnessBridgeOptions,
  ): Record<string, string> | undefined {
    if (options.identity === undefined) return undefined;
    const homeDir = resolveKimiHome(options.homeDir);
    return createKimiDefaultHeaders({
      homeDir,
      ...options.identity,
    });
  }
}
