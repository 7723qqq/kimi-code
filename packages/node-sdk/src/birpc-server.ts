import {
  ensureConfigFile,
  getRootLogger,
  KimiCore,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  type CoreAPI,
  type CoreRPCClient,
  type RPCMethods,
  type SDKAPI,
  type TelemetryClient,
} from '@moonshot-ai/agent-core';
import { assertKimiHostIdentity, createKimiDefaultHeaders } from '@moonshot-ai/kimi-code-oauth';
import { createBirpc, type BirpcOptions, type BirpcReturn } from 'birpc';

import { KimiAuthFacade } from '#/auth';
import type { KimiHostIdentity, OAuthRefreshOutcome } from '#/types';

export type KimiCoreBirpcServerChannelOptions = Omit<
  BirpcOptions<SDKAPI, CoreAPI>,
  'bind' | 'eventNames'
> & {
  readonly eventNames?: (keyof SDKAPI)[];
};

export interface KimiCoreBirpcServerOptions {
  readonly channel: KimiCoreBirpcServerChannelOptions;
  readonly identity?: KimiHostIdentity;
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: (outcome: OAuthRefreshOutcome) => void;
}

export class KimiCoreBirpcServer {
  readonly homeDir: string;
  readonly configPath: string;
  readonly auth: KimiAuthFacade;
  readonly core: KimiCore;
  readonly rpc: BirpcReturn<SDKAPI, CoreAPI>;

  private readonly identity: KimiHostIdentity | undefined;

  constructor(options: KimiCoreBirpcServerOptions) {
    this.identity =
      options.identity === undefined ? undefined : assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    void getRootLogger().configure(resolveLoggingConfig({ homeDir: this.homeDir }));

    this.auth = new KimiAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });

    let rpc: BirpcReturn<SDKAPI, CoreAPI> | undefined;
    const rpcClient: CoreRPCClient = async (coreApi) => {
      rpc = createBirpc<SDKAPI, CoreAPI>(bindRpcMethods(coreApi as unknown as CoreAPI), {
        ...options.channel,
        bind: 'functions',
        eventNames: options.channel.eventNames ?? ['emitEvent'],
      });
      return rpc as unknown as RPCMethods<SDKAPI>;
    };

    this.core = new KimiCore(rpcClient, {
      homeDir: this.homeDir,
      configPath: this.configPath,
      kimiRequestHeaders: this.createKimiRequestHeaders(),
      resolveOAuthTokenProvider: this.auth.resolveOAuthTokenProvider,
      skillDirs: options.skillDirs,
      telemetry: options.telemetry,
    });

    if (rpc === undefined) {
      throw new Error('Kimi Core birpc server was not initialized.');
    }
    this.rpc = rpc;
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.core.sessions.values(), (session) => session.close()));
    this.rpc.$close();
    try {
      await getRootLogger().flush();
    } catch {
      // Keep shutdown best-effort, matching local harness.
    }
  }

  private createKimiRequestHeaders(): Record<string, string> | undefined {
    if (this.identity === undefined) return undefined;
    return createKimiDefaultHeaders({
      homeDir: this.homeDir,
      userAgentProduct: this.identity.userAgentProduct,
      version: this.identity.version,
    });
  }
}

function bindRpcMethods<T extends object>(obj: T): T {
  const bound: Record<string, unknown> = {};
  let current: object | null = obj;

  while (current !== null && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === 'constructor' || Object.hasOwn(bound, key)) {
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (typeof descriptor?.value === 'function') {
        bound[key] = descriptor.value.bind(obj);
      }
    }

    current = Object.getPrototypeOf(current);
  }

  return bound as T;
}
