import { createBirpc, type BirpcOptions, type BirpcReturn } from 'birpc';
import { noopTelemetryClient } from '@moonshot-ai/agent-core/telemetry';
import type { CoreAPI, RPCMethods, SDKAPI } from '@moonshot-ai/agent-core';

import type { KimiAuthFacade } from '#/auth';
import { KimiHarness } from '#/kimi-harness';
import { ClientAPI, SDKRpcClientBase } from '#/rpc';
import type { KimiHostIdentity } from '#/types';

export type BirpcSDKRpcClientChannelOptions = Omit<
  BirpcOptions<CoreAPI, SDKAPI>,
  'bind' | 'eventNames'
> & {
  readonly eventNames?: (keyof CoreAPI)[];
};

export interface BirpcSDKRpcClientOptions {
  readonly channel: BirpcSDKRpcClientChannelOptions;
}

export interface BirpcKimiHarnessOptions extends BirpcSDKRpcClientOptions {
  readonly identity?: KimiHostIdentity;
  readonly uiMode?: string;
}

export class BirpcSDKRpcClient extends SDKRpcClientBase {
  private readonly rpc: BirpcReturn<CoreAPI, SDKAPI>;

  constructor(options: BirpcSDKRpcClientOptions) {
    super();
    this.rpc = createBirpc<CoreAPI, SDKAPI>(bindRpcMethods(new ClientAPI(this)), {
      ...options.channel,
      bind: 'functions',
      eventNames: options.channel.eventNames ?? [],
    });
  }

  close(): void {
    this.rpc.$close();
  }

  protected async getRpc(): Promise<RPCMethods<CoreAPI>> {
    return this.rpc as unknown as RPCMethods<CoreAPI>;
  }
}

export function createBirpcKimiHarness(options: BirpcKimiHarnessOptions): KimiHarness {
  const rpc = new BirpcSDKRpcClient(options);
  return new KimiHarness(rpc, {
    identity: options.identity,
    uiMode: options.uiMode,
    homeDir: '',
    configPath: '',
    auth: unavailableBrowserAuth,
    telemetry: noopTelemetryClient,
    ensureConfigFile: async () => {},
    onClose: () => rpc.close(),
  });
}

const unavailableBrowserAuth = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`Kimi browser harness does not expose auth.${String(property)}.`);
    },
  },
) as KimiAuthFacade;

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
