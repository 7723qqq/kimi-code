import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SDKRpcClientNative } from '#/index';

import { TEST_IDENTITY } from './test-identity';

/**
 * The native harness has no plugin or MCP-management RPC surface. It used to
 * answer these from hand-written stubs — `installPlugin` returned a fabricated
 * `PluginSummary` with a random id, so `/plugins install` reported success for
 * a plugin that was never installed. The overrides are gone, which routes the
 * calls through the base class into the `getRpc()` guard and produces a named
 * NOT_IMPLEMENTED instead.
 */
describe('SDKRpcClientNative unimplemented surfaces', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function client(): SDKRpcClientNative {
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-native-rpc-'));
    dirs.push(homeDir);
    return new SDKRpcClientNative({ homeDir, identity: TEST_IDENTITY });
  }

  it('refuses a plugin install instead of fabricating one', async () => {
    await expect(client().installPlugin('/tmp/example-plugin')).rejects.toThrow(
      /has not wired RPC method "installPlugin"/,
    );
  });

  it('refuses to list plugins instead of reporting none', async () => {
    await expect(client().listPlugins()).rejects.toThrow(
      /has not wired RPC method "listPlugins"/,
    );
  });

  it('refuses to describe a plugin instead of inventing one', async () => {
    await expect(client().getPluginInfo('plugin_example')).rejects.toThrow(
      /has not wired RPC method "getPluginInfo"/,
    );
  });

  it('refuses to claim an MCP server is already authorized', async () => {
    await expect(client().beginMcpServerAuth({ serverName: 'example' })).rejects.toThrow(
      /has not wired RPC method "beginMcpServerAuth"/,
    );
  });
});
