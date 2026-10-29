/**
 * Tests for the CLI telemetry bootstrap helpers, focusing on the
 * `kimi web` / `kimi server run` host wiring added in `cli/telemetry.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, jest, vi } from 'bun:test';
import { createRequire } from 'node:module';
import { setEnv, restoreEnvs } from '../helpers/stubs';
import { resetKimiRegionCache } from '#/utils/region';

const requireReal = createRequire(import.meta.url);

const mocks = (() => ({
  initializeTelemetry: jest.fn(),
  createKimiDeviceId: jest.fn(() => 'device-123'),
  resolveKimiHome: jest.fn(() => '/home/.kimi-code'),
  resolveConfigPath: jest.fn(() => '/home/.kimi-code/config.toml'),
  loadRuntimeConfigSafe: jest.fn(
    (): {
      config: { defaultModel?: string; telemetry?: boolean };
      fileError: Error | undefined;
    } => ({
      config: { defaultModel: 'kimi-k2', telemetry: true },
      fileError: undefined,
    }),
  ),
  getCachedAccessToken: jest.fn(async () => 'tok'),
}))();

jest.mock('@moonshot-ai/kimi-telemetry', () => ({
  initializeTelemetry: mocks.initializeTelemetry,
  setTelemetryContext: jest.fn(),
  track: jest.fn(),
  withTelemetryContext: jest.fn(),
}));

const realOAuth = requireReal('@moonshot-ai/kimi-code-oauth');
const realSdk = requireReal('@moonshot-ai/kimi-code-sdk');

jest.mock('@moonshot-ai/kimi-code-oauth', () => ({
  // Spread the real module: the SDK's v2 client pulls agent-core-v2 into the
  // import graph, which subclasses KimiOAuthToolkit from this package.
  ...realOAuth,
  createKimiDeviceId: mocks.createKimiDeviceId,
  KIMI_CODE_PROVIDER_NAME: 'managed:kimi-code',
}));

jest.mock('@moonshot-ai/kimi-code-sdk', () => ({
  ...realSdk,
  resolveKimiHome: mocks.resolveKimiHome,
  resolveConfigPath: mocks.resolveConfigPath,
  loadRuntimeConfigSafe: mocks.loadRuntimeConfigSafe,
  KimiAuthFacade: jest.fn(function () {
    return { getCachedAccessToken: mocks.getCachedAccessToken };
  }),
}));

describe('initializeServerTelemetry', () => {
  beforeEach(() => {
    setEnv('KIMI_CODE_OAUTH_HOST', 'https://auth.kimi.com');
    resetKimiRegionCache();
    mocks.initializeTelemetry.mockClear();
    mocks.loadRuntimeConfigSafe.mockClear();
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: { defaultModel: 'kimi-k2', telemetry: true },
      fileError: undefined,
    });
  });

  afterEach(() => {
    restoreEnvs();
    resetKimiRegionCache();
  });

  it('configures the sink with ui_mode="web" and the CLI product identity', async () => {
    const { initializeServerTelemetry } = await import('#/cli/telemetry');
    const client = initializeServerTelemetry({ version: '1.2.3' });
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: 'kimi-code-cli',
        version: '1.2.3',
        uiMode: 'web',
        model: 'kimi-k2',
        enabled: true,
        deviceId: 'device-123',
        homeDir: '/home/.kimi-code',
      }),
    );
    // The returned client wraps the module functions so core + the host share
    // the same underlying client.
    expect(client).toEqual(
      expect.objectContaining({
        track: expect.any(Function),
        withContext: expect.any(Function),
        setContext: expect.any(Function),
      }),
    );
    // The first dynamic import pulls in the whole SDK/oauth chain (~3s idle,
    // more under full-suite transform contention) — give it headroom past the
    // 5s default timeout.
  }, 20000);

  it('disables telemetry when config.toml sets telemetry = false', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: { defaultModel: 'kimi-k2', telemetry: false },
      fileError: undefined,
    });
    const { initializeServerTelemetry } = await import('#/cli/telemetry');
    initializeServerTelemetry({ version: '1.2.3' });

    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('degrades to enabled with no model when config is unreadable', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: {},
      fileError: new Error('bad toml'),
    });
    const { initializeServerTelemetry } = await import('#/cli/telemetry');
    initializeServerTelemetry({ version: '1.2.3' });

    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, model: undefined }),
    );
  });
});
