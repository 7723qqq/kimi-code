import { describe, expect, it } from 'vitest';

import { ImageLimits, KimiHarness, SDKRpcClientBase } from '#/index';

import { recordingTelemetry } from './telemetry';

/**
 * The recursive RPC surface KimiHarness touches for the tests below: kept
 * minimal like the StubRpc in create-session-transport.test.ts. The base
 * class is abstract, so the stub implements only the members each test uses
 * and is cast when handed to the harness.
 */
class StubRpc {
  asRpc(): SDKRpcClientBase {
    return this as unknown as SDKRpcClientBase;
  }
}

function makeHarnessWithRpc(rpc: SDKRpcClientBase): KimiHarness {
  return new KimiHarness(rpc, {
    homeDir: '/tmp/home',
    configPath: '/tmp/config.toml',
    auth: { status: async () => ({ providers: [] }) } as never,
    telemetry: recordingTelemetry([]),
    ensureConfigFile: async () => {},
    onClose: () => {},
  });
}

describe('KimiHarness capability facade', () => {
  const ready = {
    id: 'kimi-webbridge',
    displayName: 'Kimi WebBridge',
    description: 'd',
    supported: true,
    state: 'ready',
    steps: [],
    install: { running: false },
  } as const;

  it('routes capability calls through the global channel with no session', async () => {
    const calls: string[] = [];
    class CapabilityRpc extends StubRpc {
      async listCapabilities() {
        calls.push('list');
        return [ready];
      }
      async getCapability(id: string) {
        calls.push(`get:${id}`);
        return ready;
      }
      async installCapability(id: string) {
        calls.push(`install:${id}`);
        return ready;
      }
    }
    const harness = makeHarnessWithRpc(new CapabilityRpc().asRpc());

    expect(await harness.listCapabilities()).toEqual([ready]);
    expect((await harness.getCapability('kimi-webbridge')).state).toBe('ready');
    await harness.installCapability('kimi-webbridge');
    expect(calls).toEqual(['list', 'get:kimi-webbridge', 'install:kimi-webbridge']);
  });

  it('reports the capability surface as unavailable on v1', async () => {
    // The v1 rpc has no capability methods, exactly like the real v1 client.
    const harness = makeHarnessWithRpc(new StubRpc().asRpc());
    await expect(harness.listCapabilities()).rejects.toThrow(/requires v2/);
    await expect(harness.installCapability('kimi-cu')).rejects.toThrow(/requires v2/);
  });
});

describe('KimiHarness imageLimits', () => {
  it('a hand-built harness returns the injected ImageLimits as-is', () => {
    const limits = new ImageLimits(process.env, { maxEdgePx: 900 });
    const harness = new KimiHarness(new StubRpc().asRpc(), {
      homeDir: '/tmp/home',
      configPath: '/tmp/config.toml',
      auth: { status: async () => ({ providers: [] }) } as never,
      telemetry: recordingTelemetry([]),
      ensureConfigFile: async () => {},
      onClose: () => {},
      imageLimits: limits,
    });

    expect(harness.imageLimits).toBe(limits);
    expect(harness.imageLimits?.maxEdgePx()).toBe(900);
  });
});
