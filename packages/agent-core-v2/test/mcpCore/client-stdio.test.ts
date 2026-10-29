import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { deserializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { join } from 'pathe';

import {
  BoundedTail,
  mergeStdioEnv,
  StdioFrameBuffer,
  StdioMcpClient,
  type StdioMcpClientOptions,
} from '#/mcpCore/client-stdio';
import { type McpServerStdioConfig } from '#/mcpCore/config-schema';
import { HostProcessService } from '#/os/backends/host/hostProcessService';
import { FakeRuntime } from '#/runtime/fakeRuntime';

import {
  crashAfterConnectFixture,
  cwdStdioFixture,
  stderrThenExitFixture,
  stdioFixture,
} from './stubs';

function createClient(
  config: McpServerStdioConfig,
  options: Partial<StdioMcpClientOptions> = {},
): StdioMcpClient {
  const runtime = Object.assign(
    new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
      {
        capabilities: ['process'],
        pathClass: process.platform === 'win32' ? 'win32' : 'posix',
      },
    ),
    { process: new HostProcessService() },
  );
  return new StdioMcpClient(config, {
    runtimeResolver: {
      _serviceBrand: undefined,
      inspect: () => runtime,
      acquire: () => ({
        runtime,
        track: (resource) => resource,
        dispose: () => {},
      }),
    },
    workspaceId: 'workspace',
    runtimeId: 'local',
    defaultCwd: process.cwd(),
    ...options,
  });
}

function isPostCloseTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Not connected') ||
    message.includes('Connection closed') ||
    message.includes('transport is not running')
  );
}

describe('StdioMcpClient', () => {
  it('uses defaultCwd when config.cwd is omitted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-default-cwd-'));
    const client = createClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdStdioFixture],
      },
      { defaultCwd: cwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(cwd));
    } finally {
      await client.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15000);

  it('prefers explicit config.cwd over defaultCwd', async () => {
    const defaultCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-default-cwd-'));
    const configuredCwd = join(defaultCwd, 'configured');
    mkdirSync(configuredCwd);
    const client = createClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdStdioFixture],
        cwd: configuredCwd,
      },
      { defaultCwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(configuredCwd));
    } finally {
      await client.close();
      await rm(defaultCwd, { recursive: true, force: true });
      await rm(configuredCwd, { recursive: true, force: true });
    }
  }, 15000);

  it('resolves relative config.cwd from defaultCwd', async () => {
    const defaultCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-relative-cwd-'));
    const configuredCwd = join(defaultCwd, 'tools', 'mcp');
    mkdirSync(configuredCwd, { recursive: true });
    const client = createClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdStdioFixture],
        cwd: 'tools/mcp',
      },
      { defaultCwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(configuredCwd));
    } finally {
      await client.close();
      await rm(defaultCwd, { recursive: true, force: true });
    }
  }, 15000);

  it('allows explicit config.cwd outside defaultCwd', async () => {
    const defaultCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-default-cwd-'));
    const outsideCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-outside-cwd-'));
    const client = createClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdStdioFixture],
        cwd: outsideCwd,
      },
      { defaultCwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(outsideCwd));
    } finally {
      await client.close();
      await rm(defaultCwd, { recursive: true, force: true });
      await rm(outsideCwd, { recursive: true, force: true });
    }
  }, 15000);

  it('connects, lists tools, and round-trips a text result', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name).toSorted()).toEqual(['boom', 'echo', 'read_env', 'whoami']);
      const echo = tools.find((t) => t.name === 'echo');
      expect(echo?.description).toBe('Echoes input text');
      expect(echo?.inputSchema).toMatchObject({ type: 'object' });

      const result = await client.callTool('echo', { text: 'hello mcp' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'hello mcp' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('propagates server-reported isError', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    try {
      await client.connect();
      const result = await client.callTool('boom', {});
      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual({ type: 'text', text: 'boom!' });
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards configured env to the spawned server', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
      env: { KIMI_TEST_ENV: 'forwarded-value' },
    });
    try {
      await client.connect();
      const result = await client.callTool('read_env', { name: 'KIMI_TEST_ENV' });
      expect(result.content).toEqual([{ type: 'text', text: 'forwarded-value' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('inherits parent process env so PATH/HOME survive; config.env overrides on conflict', async () => {
    const parentOnly = `KIMI_TEST_PARENT_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const shared = `KIMI_TEST_SHARED_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    process.env[parentOnly] = 'from-parent';
    process.env[shared] = 'from-parent';
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
      env: { [shared]: 'from-config' },
    });
    try {
      await client.connect();
      const inherited = await client.callTool('read_env', { name: parentOnly });
      expect(inherited.content).toEqual([{ type: 'text', text: 'from-parent' }]);
      const overridden = await client.callTool('read_env', { name: shared });
      expect(overridden.content).toEqual([{ type: 'text', text: 'from-config' }]);
    } finally {
      delete process.env[parentOnly];
      delete process.env[shared];
      await client.close();
    }
  }, 15000);

  it('captures recent stderr into a snapshot the manager can attach to errors', async () => {
    const banner = `kimi-test-stderr-${Date.now()}`;
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stderrThenExitFixture],
      env: { KIMI_TEST_MCP_STDERR: banner },
    });
    try {
      await expect(client.connect()).rejects.toThrow();
      expect(client.stderrSnapshot()).toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('keeps the stderr buffer bounded so noisy servers cannot exhaust memory', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    try {
      await client.connect();
      expect(StdioMcpClient.stderrBufferCapacity).toBeLessThanOrEqual(16 * 1024);
      expect(StdioMcpClient.stderrBufferCapacity).toBeGreaterThanOrEqual(1024);
    } finally {
      await client.close();
    }
  }, 15000);

  it('notifies an unexpected-close listener when the child exits after connect', async () => {
    const banner = `kimi-test-crash-${Date.now()}`;
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { KIMI_TEST_MCP_EXIT_AFTER_MS: '50', KIMI_TEST_MCP_STDERR: banner },
    });
    const closes: Array<{ stderr?: string; error?: string }> = [];
    client.onSessionEvidence((evidence) => {
      closes.push({ stderr: evidence.reason.stderr, error: evidence.reason.error?.message });
    });
    try {
      await client.connect();
      for (let i = 0; i < 100; i++) {
        if (closes.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(closes).toHaveLength(1);
      expect(closes[0]?.stderr ?? '').toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('buffers an early close and replays it on listener registration', async () => {
    const banner = `kimi-test-early-${Date.now()}`;
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { KIMI_TEST_MCP_STDERR: banner, KIMI_TEST_MCP_EXIT_CODE: '0' },
    });
    try {
      await client.connect();
      const reply = await client.callTool('exit_after_reply', {});
      expect(reply.isError).toBe(false);
      const exitDeadline = Date.now() + 5000;
      while (Date.now() < exitDeadline && !client.stderrSnapshot().includes(banner)) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(client.stderrSnapshot()).toContain(banner);

      const drainDeadline = Date.now() + 5000;
      let transportConfirmedDead = false;
      while (Date.now() < drainDeadline) {
        try {
          await client.callTool('echo', { text: 'probe' });
        } catch (error) {
          if (isPostCloseTransportError(error)) {
            transportConfirmedDead = true;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(transportConfirmedDead).toBe(true);

      let received: { stderr?: string } | undefined;
      let syncedOnRegister = false;
      client.onSessionEvidence((evidence) => {
        syncedOnRegister = true;
        received = { stderr: evidence.reason.stderr };
      });
      expect(syncedOnRegister).toBe(true);
      expect(received).toBeDefined();
    } finally {
      await client.close();
    }
  }, 15000);

  it('does not fire unexpected-close when the caller closes the client itself', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    const closes: number[] = [];
    client.onSessionEvidence(() => closes.push(Date.now()));
    await client.connect();
    await client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(closes).toEqual([]);
  }, 15000);
});

describe('mergeStdioEnv', () => {
  it('enables NODE_USE_ENV_PROXY for a proxy set only in the server config.env', () => {
    const merged = mergeStdioEnv({ HTTP_PROXY: 'http://corp:3128' }, { PATH: '/usr/bin' });
    expect(merged['HTTP_PROXY']).toBe('http://corp:3128');
    expect(merged['NODE_USE_ENV_PROXY']).toBe('1');
    expect(merged['NO_PROXY']).toBe('localhost,127.0.0.1,::1,[::1]');
    expect(merged['PATH']).toBe('/usr/bin');
  });

  it('does not inject NODE_USE_ENV_PROXY when no proxy is configured', () => {
    const merged = mergeStdioEnv(undefined, { PATH: '/usr/bin' });
    expect(merged['NODE_USE_ENV_PROXY']).toBeUndefined();
    expect(merged['PATH']).toBe('/usr/bin');
  });

  it('lets config.env override the parent env', () => {
    const merged = mergeStdioEnv({ FOO: 'override' }, { FOO: 'parent', PATH: '/x' });
    expect(merged['FOO']).toBe('override');
  });

  it('does not depend on a filesystem cwd fixture for env merging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-mcp-env-'));
    await rm(dir, { recursive: true, force: true });
    expect(mergeStdioEnv(undefined, { PATH: dir })['PATH']).toBe(dir);
  });
});

describe('StdioFrameBuffer', () => {
  const frameOf = (payload: unknown): Buffer => Buffer.from(`${JSON.stringify(payload)}\n`);

  function splitInto(buffer: Buffer, chunkCount: number): Buffer[] {
    const size = Math.ceil(buffer.length / chunkCount);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < buffer.length; offset += size) {
      chunks.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
    }
    return chunks;
  }

  it('parses one large frame split across many small chunks', () => {
    const payload = { jsonrpc: '2.0' as const, id: 1, result: { text: 'x'.repeat(1024 * 1024) } };
    const frame = frameOf(payload);
    const split = splitInto(frame, 4096);
    const lines: string[] = [];
    const buffer = new StdioFrameBuffer();
    for (const chunk of split) {
      buffer.append(chunk);
      const line = buffer.readLine();
      if (line !== null) lines.push(line);
    }
    expect(lines).toHaveLength(1);
    expect(deserializeMessage(lines[0]!)).toEqual(payload);
  });

  it('parses two frames delivered in a single chunk', () => {
    const first = { jsonrpc: '2.0', id: 1, result: {} };
    const second = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } };
    const buffer = new StdioFrameBuffer();
    buffer.append(Buffer.concat([frameOf(first), frameOf(second)]));
    expect(buffer.readLine()).toBe(JSON.stringify(first));
    expect(buffer.readLine()).toBe(JSON.stringify(second));
    expect(buffer.readLine()).toBeNull();
  });

  it('keeps a frame that arrived in the same chunk as its predecessor', () => {
    const buffer = new StdioFrameBuffer();
    buffer.append(
      Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":'),
    );
    expect(buffer.readLine()).toBe('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(buffer.readLine()).toBeNull();
    buffer.append(Buffer.from('"2.0","id":7,"result":{"ok":true}}\n'));
    expect(JSON.parse(buffer.readLine()!)).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    expect(buffer.readLine()).toBeNull();
  });

  it('strips a CRLF terminator like the SDK read buffer', () => {
    const buffer = new StdioFrameBuffer();
    buffer.append(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\r\n'));
    expect(buffer.readLine()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
  });
});

describe('BoundedTail', () => {
  it('keeps small chunks untouched until the capacity is exceeded', () => {
    const tail = new BoundedTail(1024);
    tail.push('hello');
    expect(tail.snapshot()).toBe('hello');
  });

  it('keeps the last capacity bytes of a single overflowing chunk', () => {
    const tail = new BoundedTail(1024);
    tail.push('a'.repeat(2048));
    expect(tail.snapshot()).toBe('a'.repeat(1024));
  });

  it('keeps the tail across multiple pushes that overflow together', () => {
    const tail = new BoundedTail(1024);
    tail.push('x'.repeat(600));
    tail.push('y'.repeat(600));
    const snapshot = tail.snapshot();
    expect(snapshot.endsWith('y'.repeat(600))).toBe(true);
    expect(Buffer.byteLength(snapshot)).toBeLessThanOrEqual(1024);
  });

  it('does not split a surrogate pair at the cut boundary', () => {
    const tail = new BoundedTail(1024);
    tail.push('a'.repeat(1023) + '😀');
    const snapshot = tail.snapshot();
    expect(snapshot.endsWith('😀')).toBe(true);
    expect(Buffer.byteLength(snapshot)).toBeLessThanOrEqual(1024 + 4);
  });
});
