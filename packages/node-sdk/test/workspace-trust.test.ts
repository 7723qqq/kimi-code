import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SDKRpcClientNative } from '../src/index';
import { TEST_IDENTITY } from './test-identity';

const ENV = 'KIMI_CODE_TRUST_WORKSPACE';

describe('SDKRpcClientNative workspace trust', () => {
  const dirs: string[] = [];
  const clients: SDKRpcClientNative[] = [];

  afterEach(async () => {
    delete process.env[ENV];
    // Close first: the plugin registry holds `<homeDir>/sessions.db` open, and
    // Windows refuses to remove a directory with a locked file in it.
    while (clients.length > 0) await clients.pop()!.close();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function client(trusted: string[] = []): { rpc: SDKRpcClientNative; workDir: string } {
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-trust-'));
    dirs.push(homeDir);
    writeFileSync(join(homeDir, 'trusted-workspaces.json'), JSON.stringify(trusted));
    const workDir = mkdtempSync(join(tmpdir(), 'kimi-trust-ws-'));
    dirs.push(workDir);
    const rpc = new SDKRpcClientNative({ homeDir, identity: TEST_IDENTITY });
    clients.push(rpc);
    return { rpc, workDir };
  }

  it('fails closed for a workspace with no record and no env', async () => {
    const { rpc, workDir } = client();
    expect((await rpc.getWorkspaceTrustInfo(workDir)).trusted).toBe(false);
  });

  it('trusts a workspace the user has recorded', async () => {
    const { rpc, workDir } = client();
    await rpc.trustWorkspace(workDir);
    expect((await rpc.getWorkspaceTrustInfo(workDir)).trusted).toBe(true);
  });

  it('lets KIMI_CODE_TRUST_WORKSPACE outrank the recorded decision', async () => {
    // Upstream #4059: the env ORs over the persisted record, so untrusting has
    // no observable effect while it is set. That is the documented trade, and
    // the only way to opt out is to unset the variable.
    const { rpc, workDir } = client();
    process.env[ENV] = '1';
    expect((await rpc.getWorkspaceTrustInfo(workDir)).trusted).toBe(true);

    await rpc.trustWorkspace(workDir);
    expect((await rpc.getWorkspaceTrustInfo(workDir)).trusted).toBe(true);
  });

  it('accepts every truthy spelling and ignores the rest', async () => {
    for (const value of ['1', 'true', 'yes', 'on', 'ON', ' true ']) {
      const { rpc, workDir } = client();
      process.env[ENV] = value;
      expect((await rpc.getWorkspaceTrustInfo(workDir)).trusted, value).toBe(true);
      await rpc.close();
      clients.pop();
      rmSync(dirs.pop()!, { recursive: true, force: true });
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('does not trust on a falsy or unrecognised spelling', async () => {
    // A typo must leave the normal prompt in place rather than silently
    // trusting every workspace the agent ever opens.
    for (const value of ['0', 'false', 'no', 'off', 'maybe', '']) {
      const { rpc, workDir } = client();
      process.env[ENV] = value;
      expect((await rpc.getWorkspaceTrustInfo(workDir)).trusted, value).toBe(false);
      await rpc.close();
      clients.pop();
      rmSync(dirs.pop()!, { recursive: true, force: true });
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });
});
