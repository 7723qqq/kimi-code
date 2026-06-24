import type { CoreRPC, SDKAPI } from '../../rpc';

export interface ServicesCoreAdapterOptions {
  readonly coreRpc: CoreRPC;
  readonly sdk: SDKAPI;
  readonly homeDir: string;
  readonly configPath: string;
}

export interface ServicesCoreAdapter {
  readonly rpc: CoreRPC;
  ready(): Promise<void>;
  dispose(): void;
}
