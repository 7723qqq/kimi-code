import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SDKRpcClientNative } from '#/index';

import { TEST_IDENTITY } from './test-identity';

/**
 * Surfaces the native harness does not wire. It used to answer these from
 * hand-written stubs — `installPlugin` returned a fabricated `PluginSummary`
 * with a random id, so `/plugins install` reported success for a plugin that
 * was never installed. The overrides are gone, which routes the calls through
 * the base class into the `getRpc()` guard and produces a named
 * NOT_IMPLEMENTED instead.
 *
 * The plugin surface is no longer one of them: it is wired to the engine's
 * registry (`initPluginStore` plus the `plugin*` exports), so the assertions
 * below cover its real failure modes — an unknown catalog id, an id that is
 * not installed — rather than a missing transport.
 */
describe('SDKRpcClientNative unimplemented surfaces', () => {
  const dirs: string[] = [];
  const clients: SDKRpcClientNative[] = [];

  afterEach(async () => {
    // Close first: the plugin registry holds `<homeDir>/sessions.db` open, and
    // Windows refuses to remove a directory with a locked file in it.
    while (clients.length > 0) await clients.pop()!.close();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function client(): SDKRpcClientNative {
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-native-rpc-'));
    dirs.push(homeDir);
    const instance = new SDKRpcClientNative({ homeDir, identity: TEST_IDENTITY });
    clients.push(instance);
    return instance;
  }

  it('refuses an unknown plugin instead of fabricating an install', async () => {
    await expect(client().installPlugin('/tmp/example-plugin')).rejects.toThrow(
      /Unknown plugin/,
    );
  });

  it('lists no plugins before anything is installed', async () => {
    await expect(client().listPlugins()).resolves.toEqual([]);
  });

  it('refuses to describe a plugin that is not installed', async () => {
    await expect(client().getPluginInfo('plugin_example')).rejects.toThrow(
      /is not installed/,
    );
  });

  it('refuses to claim an MCP server is already authorized', async () => {
    await expect(client().beginMcpServerAuth({ serverName: 'example' })).rejects.toThrow(
      /has not wired RPC method "beginMcpServerAuth"/,
    );
  });
});
