import { createServerLogger, startServer, type RunningServer } from '@moonshot-ai/kap-server';
import type { KimiConfig } from '@moonshot-ai/testkit/fixtures';
import type { FakeModelOptions, FakeProviderType } from '@moonshot-ai/testkit/model';
import {
  kapFixtures,
  kapTest,
  type KapFixtureDefinitions,
  type KapFixtures,
} from '@moonshot-ai/testkit/bun';

export type ScenarioFixtures = KapFixtures<RunningServer>;

export interface ScenarioOptions {
  readonly serverVersion?: string;
  readonly provider?: FakeProviderType;
  readonly config?: KimiConfig;
  readonly modelOptions?: FakeModelOptions;
}

export function scenarioFixtures(
  options: ScenarioOptions = {},
): KapFixtureDefinitions<RunningServer> {
  return kapFixtures({
    startServer,
    createServerLogger,
    modelOptions: options.modelOptions,
    serverOptions: { serverVersion: options.serverVersion },
    provider: { type: options.provider },
    config: { defaultPermissionMode: 'yolo', ...options.config },
  });
}

export function scenarioTest(
  options: ScenarioOptions = {},
  timeoutMs = 10_000,
): (name: string, fn: (fixtures: ScenarioFixtures) => void | Promise<void>) => void {
  return kapTest(scenarioFixtures(options), timeoutMs);
}
