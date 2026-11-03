import {
  createKimiHarness,
  type KimiHarness,
  type KimiHarnessOptions,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import {
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';

import { CLI_SHUTDOWN_TIMEOUT_MS, CLI_UI_MODE } from '#/constant/app';

import { resolvePluginNodeRunner } from './plugin-node-runner';
import {
  createCliTelemetryBootstrap,
  initializeCliTelemetry,
  type CliTelemetryBootstrap,
} from './telemetry';
import { createKimiCodeHostIdentity, getVersion } from './version';

type CliHarnessOptions = Omit<KimiHarnessOptions, 'identity' | 'pluginNodeRunner'> & {
  readonly version?: string;
};

type TelemetryHarnessOptions = Omit<CliHarnessOptions, 'homeDir' | 'telemetry'>;

interface TelemetryHarness {
  readonly harness: KimiHarness;
  readonly telemetryBootstrap: CliTelemetryBootstrap;
}

export function createCliHarness({ version, ...options }: CliHarnessOptions = {}): KimiHarness {
  return createKimiHarness({
    ...options,
    identity: createKimiCodeHostIdentity(version),
    pluginNodeRunner: resolvePluginNodeRunner(),
  });
}

export function createTelemetryHarness(options: TelemetryHarnessOptions = {}): TelemetryHarness {
  const telemetryBootstrap = createCliTelemetryBootstrap();
  const telemetry: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  const harness = createCliHarness({
    ...options,
    homeDir: telemetryBootstrap.homeDir,
    telemetry,
  });
  return { harness, telemetryBootstrap };
}

export class CliHarnessRuntime {
  readonly version: string;
  private runtime: TelemetryHarness | undefined;
  private telemetryInitialized = false;
  private telemetryShutdown = false;

  constructor(options: { readonly version?: string } = {}) {
    this.version = options.version ?? getVersion();
  }

  getHarness(): KimiHarness {
    return this.getRuntime().harness;
  }

  async initializeTelemetry(): Promise<void> {
    if (this.telemetryInitialized) return;
    const { harness, telemetryBootstrap } = this.getRuntime();
    await harness.ensureConfigFile();
    const config = await harness.getConfig();
    initializeCliTelemetry({
      harness,
      bootstrap: telemetryBootstrap,
      config,
      version: this.version,
      uiMode: CLI_UI_MODE,
    });
    this.telemetryInitialized = true;
  }

  async shutdownTelemetry(): Promise<void> {
    if (!this.telemetryInitialized || this.telemetryShutdown) return;
    this.telemetryShutdown = true;
    await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
  }

  async close(): Promise<void> {
    await this.runtime?.harness.close();
  }

  private getRuntime(): TelemetryHarness {
    this.runtime ??= createTelemetryHarness({ version: this.version });
    return this.runtime;
  }
}
