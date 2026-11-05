import { describe, expect, it, mock, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { type AddressInfo as HttpAddress } from 'node:net';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { type OAuthClientInformationFull, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { join } from 'pathe';
import { z } from 'zod';

import { Error2 } from '#/errors';
import { KIMI_MCP_CLIENT_NAME } from '#/mcpCore/client-shared';
import {
  AUTO_DEFER_TOOL_THRESHOLD,
  McpConnectionManager,
  type McpServerEntry,
} from '#/mcpCore/connection-manager';
import { type StoredMcpOAuthTokens } from '#/mcpCore/oauth/provider';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { HostProcessService } from '#/os/backends/host/hostProcessService';
import type { EnvironmentBinding } from '#/environment/environment';
import { HostProcessError, HostProcessErrorCode } from '#/os/interface/hostProcess';
import { RuntimeError } from '#/environment/environmentRegistry';

const testEnvironmentBinding: EnvironmentBinding = { environmentId: 'local' };
const testProcess = new HostProcessService();
const testEnvironment = Object.assign(
  new FakeEnvironment({ ...testEnvironmentBinding, generation: 'test-generation' }, {
    capabilities: ['process'],
  }),
  { process: testProcess },
);
const testEnvironmentResolver = {
  _serviceBrand: undefined,
  inspect: () => testEnvironment,
  acquire: () => ({
    environment: testEnvironment,
    track: <T extends { dispose(): void | Promise<void> }>(resource: T): T => resource,
    dispose: () => {},
  }),
  acquireWhenReady: async () => ({
    environment: testEnvironment,
    track: <T extends { dispose(): void | Promise<void> }>(resource: T): T => resource,
    dispose: () => {},
  }),
};

function createManager(options: McpConnectionManagerOptions = {}): McpConnectionManager {
  return new McpConnectionManager({
    environmentResolver: testEnvironmentResolver,
    environmentId: testEnvironmentBinding.environmentId,
    stdioCwd: process.cwd(),
    ...options,
  });
}

import { recordingTelemetry, type TelemetryRecord } from '../app/telemetry/stubs';
import {
  closeServer,
  crashAfterConnectFixture,
  createMemoryMcpOAuthStore,
  cwdStdioFixture,
  hangingListStdioFixture,
  slowStdioFixture,
  slowToolStdioFixture,
  startAnonymousDiscoveryHttpMcpServer,
  stderrThenExitFixture,
  stdioFixture,
} from './stubs';

function parameter(
  tool: { readonly parameters?: Record<string, unknown> } | undefined,
  name: string,
): Record<string, unknown> | undefined {
  const properties = tool?.parameters?.['properties'];
  if (typeof properties !== 'object' || properties === null) return undefined;
  const value = (properties as Record<string, unknown>)[name];
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stdioConfig(args: string[] = [stdioFixture]) {
  return {
    transport: 'stdio' as const,
    command: process.execPath,
    args,
  };
}

function createPerSessionMcpHandler(name: string) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  return (req: IncomingMessage, res: ServerResponse): void => {
    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (existing !== undefined) {
      void existing.handleRequest(req, res);
      return;
    }
    const mcpServer = new McpServer({ name, version: '0.0.1' });
    mcpServer.registerTool(
      'echo',
      { description: 'Echoes text', inputSchema: { text: z.string() } },
      ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    void mcpServer.connect(transport).then(() => transport.handleRequest(req, res));
  };
}

function createManager(
  options: ConstructorParameters<typeof McpConnectionManager>[0] = {},
): McpConnectionManager {
  const runtime = Object.assign(
    new FakeEnvironment(
      { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
      {
        capabilities: ['process'],
        pathClass: process.platform === 'win32' ? 'win32' : 'posix',
      },
    ),
    { process: new HostProcessService() },
  );
  return new McpConnectionManager({
    stdioCwd: process.cwd(),
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
    ...options,
  });
}

async function waitForStatus(
  cm: McpConnectionManager,
  name: string,
  status: McpServerEntry['status'],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cm.get(name)?.status === status) return;
    await delay(50);
  }
  throw new Error(
    `timed out waiting for "${name}" to reach ${status}; now ${cm.get(name)?.status}`,
  );
}

describe('McpConnectionManager', () => {
  it('connects servers in parallel and exposes connected entries with their tool count', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({ alpha: stdioConfig(), beta: stdioConfig() });
      const entries = cm.list();
      expect(entries.map((e) => e.name).toSorted()).toEqual(['alpha', 'beta']);
      for (const entry of entries) {
        expect(entry.status).toBe('connected');
        expect(entry.toolCount).toBe(4);
        expect(entry.transport).toBe('stdio');
      }
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('isolates permanent startup and discovery failures without retry or blocking the rest', async () => {
    const statuses: string[] = [];
    const cm = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
    });
    cm.onStatusChange((entry) => statuses.push(`${entry.name}:${entry.status}`));
    try {
      await cm.connectAll({
        good: stdioConfig(),
        bad: { transport: 'stdio', command: '/this/path/does/not/exist/anywhere' },
      });
      expect(cm.get('good')?.status).toBe('connected');
      expect(cm.get('bad')?.status).toBe('failed');
      expect(cm.get('bad')?.error).toBeDefined();
      await delay(300);
      expect(cm.get('bad')?.status).toBe('failed');
      expect(statuses.filter((s) => s.startsWith('bad:'))).toEqual(['bad:pending', 'bad:failed']);
    } finally {
      await cm.shutdown();
    }

    const connectSpy = spyOn(Client.prototype, 'connect').mockResolvedValue();
    const listTools = spyOn(Client.prototype, 'listTools');
    const discovery = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
    });
    try {
      listTools.mockRejectedValue(
        new McpError(ErrorCode.MethodNotFound, 'tools/list is unavailable'),
      );
      await discovery.connectAll({
        method: { transport: 'http', url: 'https://example.test/mcp' },
      });
      expect(discovery.get('method')).toMatchObject({ status: 'failed', nextRetryAt: undefined });

      for (const statusCode of [401, 403]) {
        listTools.mockRejectedValue(new StreamableHTTPError(statusCode, 'Forbidden'));
        await discovery.connect(`auth${statusCode}`, {
          transport: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer static-key' },
        });
        expect(discovery.get(`auth${statusCode}`)).toMatchObject({
          status: 'failed',
          nextRetryAt: undefined,
        });
      }

      listTools.mockResolvedValue({
        tools: [{ name: 'invalid', inputSchema: null }],
      } as never);
      await discovery.connect('schema', { transport: 'http', url: 'https://example.test/mcp' });
      expect(discovery.get('schema')).toMatchObject({ status: 'failed', nextRetryAt: undefined });
      await delay(250);
      expect(listTools).toHaveBeenCalledTimes(4);
    } finally {
      await discovery.shutdown();
      connectSpy.mockRestore();
      listTools.mockRestore();
    }
  }, 20000);

  it('auto-defers servers with many enabled tools unless deferred is pinned', async () => {
    const cm = createManager();
    const wideEnv = { KIMI_TEST_MCP_EXTRA_TOOLS: String(AUTO_DEFER_TOOL_THRESHOLD) };
    try {
      await cm.connectAll({
        wide: { ...stdioConfig(), env: wideEnv },
        pinned: { ...stdioConfig(), env: wideEnv, deferred: false },
      });

      expect(cm.deferredOf('wide')).toBe(true);
      expect(cm.resolved('wide')?.deferred).toBe(true);
      expect(cm.deferredOf('pinned')).toBe(false);
      expect(cm.resolved('pinned')?.deferred).toBe(false);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('compacts MCP parameter descriptions when enabled', async () => {
    const env = { KIMI_TEST_MCP_VERBOSE_TOOL: '1' };
    const telemetryRecords: TelemetryRecord[] = [];
    const compact = createManager({
      resolveDefaults: () => ({ compactToolSchemas: true }),
      telemetry: recordingTelemetry(telemetryRecords),
    });
    const full = createManager();
    try {
      await compact.connectAll({ verbose: { ...stdioConfig(), env } });
      await full.connectAll({ verbose: { ...stdioConfig(), env } });

      const compactTool = compact
        .resolved('verbose')
        ?.tools.find((tool) => tool.name === 'verbose');
      const fullTool = full.resolved('verbose')?.tools.find((tool) => tool.name === 'verbose');

      expect(fullTool?.description).toBe('First sentence. Second sentence with extra detail.');
      expect(compactTool?.description).toBe(fullTool?.description);
      expect(parameter(fullTool, 'query')?.['description']).toBe(
        'Query the thing. Extra parameter detail.',
      );
      expect(parameter(compactTool, 'query')?.['description']).toBe('Query the thing.');
      expect(parameter(compactTool, 'query')?.['type']).toBe('string');
      expect(parameter(compactTool, 'mode')?.['enum']).toEqual(['fast', 'slow']);
      expect(telemetryRecords).toContainEqual({
        event: 'mcp_schema_compacted',
        properties: expect.objectContaining({
          tool_count: 5,
          original_chars: expect.any(Number),
          compacted_chars: expect.any(Number),
        }),
      });
      const compacted = telemetryRecords.find((record) => record.event === 'mcp_schema_compacted');
      expect(Number(compacted?.properties?.['compacted_chars'])).toBeLessThan(
        Number(compacted?.properties?.['original_chars']),
      );
    } finally {
      await compact.shutdown();
      await full.shutdown();
    }
  }, 20000);

  it('honors the configured auto-defer threshold and allows disabling it', async () => {
    const highThreshold = createManager({
      resolveDefaults: () => ({ autoDeferToolThreshold: 100 }),
    });
    const disabled = createManager({
      resolveDefaults: () => ({ autoDeferToolThreshold: 0 }),
    });
    const env = { KIMI_TEST_MCP_EXTRA_TOOLS: String(AUTO_DEFER_TOOL_THRESHOLD) };
    try {
      await highThreshold.connectAll({ wide: { ...stdioConfig(), env } });
      await disabled.connectAll({ wide: { ...stdioConfig(), env } });

      expect(highThreshold.deferredOf('wide')).toBe(false);
      expect(disabled.deferredOf('wide')).toBe(false);
    } finally {
      await highThreshold.shutdown();
      await disabled.shutdown();
    }
  }, 30000);

  it('marks a missing stdio runtime as failed without scheduling retries', async () => {
    const missing = (): never => {
      throw new RuntimeError('runtime.not_found', 'runtime local does not exist in workspace');
    };
    const cm = createManager({
      reconnectRetryEnabled: true,
      runtimeResolver: {
        _serviceBrand: undefined,
        inspect: missing,
        acquire: missing,
      },
    });
    try {
      await cm.connectAll({ missing: stdioConfig() });

      const entry = cm.get('missing');
      expect(entry?.status).toBe('failed');
      expect(entry?.nextRetryAt).toBeUndefined();
      expect(entry?.error).toContain('runtime local does not exist in workspace');
    } finally {
      await cm.shutdown();
    }
  });

  it('markRemoved tombstones the entry: client closed, entry kept, reconnect rejected, in-flight connects invalidated, re-connect revives', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      expect(cm.get('alpha')?.status).toBe('connected');

      const statuses: string[] = [];
      cm.onStatusChange((entry) => statuses.push(`${entry.name}:${entry.status}`));

      expect(await cm.markRemoved('alpha')).toBe(true);
      const entry = cm.get('alpha');
      expect(entry?.status).toBe('removed');
      expect(entry?.toolCount).toBe(0);
      expect(cm.resolved('alpha')).toBeUndefined();
      expect(cm.list().map((e) => e.name)).toEqual(['alpha']);
      expect(statuses).toContain('alpha:removed');
      await expect(cm.reconnect('alpha')).rejects.toThrow('Unknown MCP server: alpha');

      expect(await cm.markRemoved('missing')).toBe(false);

      await cm.connect('alpha', stdioConfig());
      expect(cm.get('alpha')?.status).toBe('connected');
      expect(cm.resolved('alpha')).toBeDefined();

      const delayedMockServer = `setTimeout(() => import(${JSON.stringify(
        pathToFileURL(stdioFixture).href,
      )}), 400)`;
      const connecting = cm.connect('slow', {
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', delayedMockServer],
        startupTimeoutMs: 5_000,
      });
      await delay(50);
      expect(await cm.markRemoved('slow')).toBe(true);
      await connecting;
      await delay(600);
      expect(cm.get('slow')?.status).toBe('removed');
      expect(cm.resolved('slow')).toBeUndefined();
      expect(statuses.filter((s) => s.startsWith('slow:'))).toEqual([
        'slow:pending',
        'slow:removed',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('connect with the identical config is a no-op for a live entry', async () => {
    const cm = createManager();
    const statuses: string[] = [];
    cm.onStatusChange((entry) => statuses.push(`${entry.name}:${entry.status}`));
    try {
      await cm.connect('alpha', stdioConfig());
      expect(cm.get('alpha')?.status).toBe('connected');
      statuses.length = 0;

      await cm.connect('alpha', stdioConfig());
      expect(cm.get('alpha')?.status).toBe('connected');
      expect(statuses).toEqual([]);

      await cm.connect('alpha', { ...stdioConfig(), startupTimeoutMs: 5_000 });
      expect(cm.get('alpha')?.status).toBe('connected');
      expect(statuses).toEqual(['alpha:pending', 'alpha:connected']);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('marks remote servers failed without retry when the configured bearer token env var is missing', async () => {
    const cases = [
      { transport: 'http' as const, url: 'https://example.invalid/mcp', envVar: 'REMOTE_MCP_TOKEN' },
      { transport: 'sse' as const, url: 'https://example.invalid/sse', envVar: 'LEGACY_MCP_TOKEN' },
    ];
    for (const { transport, url, envVar } of cases) {
      const statuses: string[] = [];
      const cm = createManager({
        envLookup: () => undefined,
        reconnectRetryEnabled: true,
        resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
      });
      cm.onStatusChange((entry) => statuses.push(`${entry.name}:${entry.status}`));
      try {
        await cm.connectAll({
          remote: { transport, url, bearerTokenEnvVar: envVar },
        });
        const entry = cm.get('remote');
        expect(entry?.transport).toBe(transport);
        expect(entry?.status).toBe('failed');
        expect(entry?.error).toContain(`"${envVar}" is not set or is empty`);
        await delay(250);
        expect(cm.get('remote')?.status).toBe('failed');
        expect(statuses).toEqual(['remote:pending', 'remote:failed']);
      } finally {
        await cm.shutdown();
      }
    }
  });

  it('marks disabled servers without attempting a connection', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        off: { ...stdioConfig(), enabled: false },
      });
      const entry = cm.get('off');
      expect(entry?.status).toBe('disabled');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
    }
  });

  it('applies enabledTools / disabledTools filters to the resolved tool set', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        filtered: { ...stdioConfig(), enabledTools: ['echo'], disabledTools: ['boom'] },
      });
      const resolved = cm.resolved('filtered');
      expect([...(resolved?.enabledNames ?? [])]).toEqual(['echo']);
      expect(cm.get('filtered')?.toolCount).toBe(1);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('reflects the per-server deferred field and the resolved default in the resolved view', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        plain: stdioConfig(),
        pinned: { ...stdioConfig(), deferred: true },
      });
      expect(cm.resolved('plain')?.deferred).toBe(false);
      expect(cm.resolved('pinned')?.deferred).toBe(true);
    } finally {
      await cm.shutdown();
    }

    const defaulted = createManager({
      resolveDefaults: () => ({ defaultDeferred: true }),
    });
    try {
      await defaulted.connectAll({
        plain: stdioConfig(),
        optedOut: { ...stdioConfig(), deferred: false },
      });
      expect(defaulted.resolved('plain')?.deferred).toBe(true);
      expect(defaulted.resolved('optedOut')?.deferred).toBe(false);
      expect(defaulted.deferredOf('plain')).toBe(true);
      expect(defaulted.deferredOf('optedOut')).toBe(false);
    } finally {
      await defaulted.shutdown();
    }

    let liveDefault = true;
    const captured = createManager({
      resolveDefaults: () => ({ defaultDeferred: liveDefault }),
    });
    try {
      await captured.connectAll({ plain: stdioConfig() });
      expect(captured.resolved('plain')?.deferred).toBe(true);
      liveDefault = false;
      expect(captured.resolved('plain')?.deferred).toBe(true);
      await captured.reconnect('plain');
      expect(captured.resolved('plain')?.deferred).toBe(false);
    } finally {
      await captured.shutdown();
    }
  }, 15000);

  it('starts stdio servers in stdioCwd when config.cwd is omitted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-manager-cwd-'));
    const cm = createManager({ stdioCwd: cwd });
    try {
      await cm.connectAll({
        cwd: stdioConfig([cwdStdioFixture]),
      });
      const resolved = cm.resolved('cwd');
      if (resolved === undefined) throw new Error('Expected cwd MCP server to connect');
      const result = await resolved.client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(cwd));
    } finally {
      await cm.shutdown();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15000);


  it('announces the resolved custom identity as the MCP client name', async () => {
    const cm = createManager({ resolveClientName: () => 'acme-dev' });
    try {
      await cm.connectAll({ mock: stdioConfig() });
      const resolved = cm.resolved('mock');
      if (resolved === undefined) throw new Error('Expected mock MCP server to connect');
      const result = await resolved.client.callTool('whoami', {});
      expect((result.content[0] as { type: 'text'; text: string }).text).toBe('acme-dev');
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('keeps the builtin MCP client name when no identity is configured', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({ mock: stdioConfig() });
      const resolved = cm.resolved('mock');
      if (resolved === undefined) throw new Error('Expected mock MCP server to connect');
      const result = await resolved.client.callTool('whoami', {});
      expect((result.content[0] as { type: 'text'; text: string }).text).toBe(KIMI_MCP_CLIENT_NAME);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('emits status transitions in order per server', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      expect(seen.filter((s) => s.name === 'alpha').map((s) => s.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('reconnect cycles a failed server back through pending and into connected when fixed', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        flaky: { transport: 'stdio', command: '/no/such/binary' },
      });
      expect(cm.get('flaky')?.status).toBe('failed');

      await cm.shutdown();
      await cm.connectAll({ flaky: stdioConfig() });
      await cm.reconnect('flaky');
      expect(cm.get('flaky')?.status).toBe('connected');
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('does not let stale in-flight startup failures overwrite a reconnect attempt', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });
    const delayedMockServer = `setTimeout(() => import(${JSON.stringify(
      pathToFileURL(stdioFixture).href,
    )}), 250)`;

    const connect = cm.connectAll({
      slow: {
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', delayedMockServer],
        startupTimeoutMs: 2_000,
      },
    });

    try {
      await delay(50);
      await cm.reconnect('slow');
      await connect;

      expect(cm.get('slow')).toMatchObject({
        status: 'connected',
        toolCount: 4,
      });
      expect(seen.filter((event) => event.name === 'slow').map((event) => event.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
      await Promise.race([connect.catch(() => {}), delay(1_000)]);
    }
  }, 7000);

  it('reconnect throws a coded Error2 when the server name is unknown', async () => {
    const cm = createManager();
    try {
      await expect(cm.reconnect('nope')).rejects.toBeInstanceOf(Error2);
      await expect(cm.reconnect('nope')).rejects.toMatchObject({ code: 'mcp.server_not_found' });
    } finally {
      await cm.shutdown();
    }
  });

  it('reconnect rejects disabled servers without connecting them', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        off: { ...stdioConfig(), enabled: false },
      });

      await expect(cm.reconnect('off')).rejects.toBeInstanceOf(Error2);
      await expect(cm.reconnect('off')).rejects.toMatchObject({ code: 'mcp.server_disabled' });
      expect(cm.get('off')).toMatchObject({
        status: 'disabled',
        toolCount: 0,
      });
    } finally {
      await cm.shutdown();
    }
  });

  it('reconnectAndJoin joins an in-flight reconnect instead of starting a second one', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });
    const delayedMockServer = `setTimeout(() => import(${JSON.stringify(
      pathToFileURL(stdioFixture).href,
    )}), 250)`;

    try {
      await cm.connectAll({
        slow: {
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', delayedMockServer],
          startupTimeoutMs: 5_000,
        },
      });
      seen.length = 0;

      await Promise.all([cm.reconnectAndJoin('slow'), cm.reconnectAndJoin('slow')]);

      expect(cm.get('slow')?.status).toBe('connected');
      expect(seen.filter((event) => event.name === 'slow').map((event) => event.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('joins in-flight startup and repeated initial loads without stale overwrites', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });
    const delayedMockServer = `setTimeout(() => import(${JSON.stringify(
      pathToFileURL(stdioFixture).href,
    )}), 250)`;
    const config = {
      transport: 'stdio' as const,
      command: process.execPath,
      args: ['-e', delayedMockServer],
      startupTimeoutMs: 2_000,
    };

    const connect = cm.connectAll({ slow: config });
    let repeatedSettled = false;
    const repeated = cm.connectAll({ slow: config }).then(() => {
      repeatedSettled = true;
    });

    try {
      await delay(50);
      expect(repeatedSettled).toBe(false);
      await cm.reconnect('slow');
      await Promise.all([connect, repeated]);

      expect(cm.get('slow')).toMatchObject({
        status: 'connected',
        toolCount: 4,
      });
      expect(seen.filter((event) => event.name === 'slow').map((event) => event.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
      await Promise.race([Promise.all([connect, repeated]).catch(() => {}), delay(1_000)]);
    }
  }, 7000);

  it('serializes replacement close and tracks disabled or removed clients through shutdown', async () => {
    const cm = createManager();
    let releaseReplacement = (): void => {};
    let releaseDisable = (): void => {};
    let releaseRemoval = (): void => {};
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      expect(cm.list()).toHaveLength(1);
      await cm.shutdown();
      expect(cm.list()).toEqual([]);

      const replacementGate = new Promise<void>((resolve) => {
        releaseReplacement = resolve;
      });
      spyOn(Client.prototype, 'close').mockImplementation(() => replacementGate);
      await cm.connectAll({ alpha: stdioConfig() });
      let reconnectSettled = false;
      const reconnect = cm.reconnect('alpha').then(() => {
        reconnectSettled = true;
      });
      await delay(50);
      expect(reconnectSettled).toBe(false);
      expect(cm.get('alpha')?.status).toBe('pending');
      releaseReplacement();
      mock.restore();
      await reconnect;
      expect(cm.get('alpha')?.status).toBe('connected');

      const disableGate = new Promise<void>((resolve) => {
        releaseDisable = resolve;
      });
      spyOn(Client.prototype, 'close').mockImplementation(() => disableGate);
      let disableSettled = false;
      const disabling = cm.connect('alpha', { ...stdioConfig(), enabled: false }).then(() => {
        disableSettled = true;
      });
      await delay(50);
      expect(disableSettled).toBe(false);
      releaseDisable();
      mock.restore();
      await disabling;
      expect(cm.get('alpha')?.status).toBe('disabled');
      await cm.connect('alpha', stdioConfig());
      expect(cm.get('alpha')?.status).toBe('connected');

      const removalGate = new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      });
      spyOn(Client.prototype, 'close').mockImplementation(() => removalGate);
      let removeSettled = false;
      let shutdownSettled = false;
      const removing = cm.remove('alpha').then(() => {
        removeSettled = true;
      });
      const shutting = cm.shutdown().then(() => {
        shutdownSettled = true;
      });
      await delay(50);
      expect(removeSettled).toBe(false);
      expect(shutdownSettled).toBe(false);
      releaseRemoval();
      mock.restore();
      await Promise.all([removing, shutting]);
      expect(cm.list()).toEqual([]);
      await cm.shutdown();
    } finally {
      releaseReplacement();
      releaseDisable();
      releaseRemoval();
      mock.restore();
      await cm.shutdown();
    }
  }, 15000);

  it('reconnectAndJoin rejects for unknown servers', async () => {
    const cm = createManager();
    try {
      await expect(cm.reconnectAndJoin('nope')).rejects.toBeInstanceOf(Error2);
      await expect(cm.reconnectAndJoin('nope')).rejects.toMatchObject({
        code: 'mcp.server_not_found',
      });
    } finally {
      await cm.shutdown();
    }
  });

  it('shutdown clears entries and is idempotent', async () => {
    const cm = createManager();
    await cm.connectAll({ alpha: stdioConfig() });
    expect(cm.list()).toHaveLength(1);
    await cm.shutdown();
    expect(cm.list()).toEqual([]);
    await cm.shutdown();
  }, 15000);

  it('shutdown cancels in-flight startup without late status updates', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });

    const connectPromise = cm.connectAll({
      slowList: {
        transport: 'stdio',
        command: process.execPath,
        args: [hangingListStdioFixture],
        startupTimeoutMs: 5_000,
      },
    });

    await delay(50);
    await cm.shutdown();

    const result = await Promise.race([
      connectPromise.then(() => 'resolved' as const),
      delay(1_000).then(() => 'hung' as const),
    ]);
    expect(result).toBe('resolved');
    expect(cm.list()).toEqual([]);
    expect(seen).toEqual([{ name: 'slowList', status: 'pending' }]);
  }, 2000);

  it('honors startupTimeoutMs by marking slow servers failed', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        slow: {
          transport: 'stdio',
          command: process.execPath,
          args: [slowStdioFixture],
          startupTimeoutMs: 100,
        },
      });
      const entry = cm.get('slow');
      expect(entry?.status).toBe('failed');
      expect(entry?.error?.toLowerCase()).toContain('timed out');
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('honors startupTimeoutMs while discovering tools', async () => {
    const cm = createManager();
    const connectPromise = cm.connectAll({
      slowList: {
        transport: 'stdio',
        command: process.execPath,
        args: [hangingListStdioFixture],
        startupTimeoutMs: 100,
      },
    });
    try {
      const result = await Promise.race([
        connectPromise.then(() => 'resolved' as const),
        delay(1_000).then(() => 'hung' as const),
      ]);
      expect(result).toBe('resolved');

      const entry = cm.get('slowList');
      expect(entry?.status).toBe('failed');
      expect(entry?.error?.toLowerCase()).toContain('timed out');
    } finally {
      await cm.shutdown();
      await Promise.race([connectPromise.catch(() => {}), delay(1_000)]);
    }
  }, 7000);

  it('applies the resolved default startup timeout when the server entry omits startupTimeoutMs', async () => {
    const cm = createManager({
      resolveDefaults: () => ({ startupTimeoutMs: 100 }),
    });
    try {
      await cm.connectAll({
        slow: {
          transport: 'stdio',
          command: process.execPath,
          args: [slowStdioFixture],
        },
      });
      const entry = cm.get('slow');
      expect(entry?.status).toBe('failed');
      expect(entry?.error?.toLowerCase()).toContain('timed out');
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it.each([
    ['stdio', stdioConfig()],
    ['http', { transport: 'http' as const, url: 'https://example.test/mcp' }],
    ['sse', { transport: 'sse' as const, url: 'https://example.test/sse' }],
  ])(
    'forwards the resolved default startup timeout above the SDK default over %s',
    async (_transport, config) => {
      const connect = spyOn(Client.prototype, 'connect').mockResolvedValue();
      const listTools = spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
      const cm = createManager({
        resolveDefaults: () => ({ startupTimeoutMs: 120_000 }),
      });
      try {
        await cm.connectAll({ server: config });
        expect(connect).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ timeout: 120_000 }),
        );
        expect(listTools).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ timeout: 120_000 }),
        );
      } finally {
        await cm.shutdown();
        connect.mockRestore();
        listTools.mockRestore();
      }
    },
  );

  it.each([
    ['stdio', stdioConfig()],
    ['http', { transport: 'http' as const, url: 'https://example.test/mcp' }],
    ['sse', { transport: 'sse' as const, url: 'https://example.test/sse' }],
  ])(
    'forwards per-server startupTimeoutMs above the SDK default over %s',
    async (_transport, config) => {
      const connect = spyOn(Client.prototype, 'connect').mockResolvedValue();
      const listTools = spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
      const cm = createManager({
        resolveDefaults: () => ({ startupTimeoutMs: 120_000 }),
      });
      try {
        await cm.connectAll({
          server: { ...config, startupTimeoutMs: 180_000 },
        });
        expect(connect).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ timeout: 180_000 }),
        );
        expect(listTools).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ timeout: 180_000 }),
        );
      } finally {
        await cm.shutdown();
        connect.mockRestore();
        listTools.mockRestore();
      }
    },
  );

  it('applies the resolved default tool timeout when the server entry omits toolTimeoutMs', async () => {
    const cm = createManager({
      resolveDefaults: () => ({ toolTimeoutMs: 100 }),
    });
    try {
      await cm.connectAll({
        slowTool: {
          transport: 'stdio',
          command: process.execPath,
          args: [slowToolStdioFixture],
        },
      });
      const client = cm.resolved('slowTool')?.client;
      if (client === undefined) throw new Error('expected a connected client');
      await expect(client.callTool('slow_echo', { text: 'hi' })).rejects.toThrow(/timed out/i);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('lets a per-server toolTimeoutMs override the resolved default tool timeout', async () => {
    const cm = createManager({
      resolveDefaults: () => ({ toolTimeoutMs: 100 }),
    });
    try {
      await cm.connectAll({
        slowTool: {
          transport: 'stdio',
          command: process.execPath,
          args: [slowToolStdioFixture],
          toolTimeoutMs: 10_000,
        },
      });
      const client = cm.resolved('slowTool')?.client;
      if (client === undefined) throw new Error('expected a connected client');
      const result = await client.callTool('slow_echo', { text: 'hi' });
      expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('flips HTTP servers into needs-auth when the server returns 401 and no static token is set', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        gated: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('gated');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login gated');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('marks an explicitly OAuth HTTP server as needs-auth when non-auth headers accompany a 401', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        gated: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { 'X-Tenant': 'example' },
          auth: 'oauth',
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('gated');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login gated');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('marks HTTP servers with pinned static headers failed (not needs-auth) on 401/403 without retry', async () => {
    const headerSets: Array<Record<string, string>> = [
      { Authorization: 'Bearer static-key' },
      { 'X-API-Key': 'wrong' },
    ];
    for (const headers of headerSets) {
      for (const statusCode of [401, 403]) {
        const server: HttpServer = createHttpServer((_req, res) => {
          res.writeHead(statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as HttpAddress).port;
        const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
        const cm = createManager({
          oauthService,
          reconnectRetryEnabled: true,
          resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
        });
        const statuses: string[] = [];
        cm.onStatusChange((entry) => statuses.push(`${entry.name}:${entry.status}`));
        try {
          await cm.connectAll({
            keyed: {
              transport: 'http',
              url: `http://127.0.0.1:${port}/mcp`,
              headers,
              startupTimeoutMs: 5_000,
            },
          });
          expect(cm.get('keyed')?.status).toBe('failed');
          await delay(250);
          expect(cm.get('keyed')?.status).toBe('failed');
          expect(statuses).toEqual(['keyed:pending', 'keyed:failed']);
        } finally {
          await cm.shutdown();
          await closeServer(server);
        }
      }
    }
  }, 15000);

  it('flips SSE servers into needs-auth when the server returns 401 and no static token is set', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401, {
        'content-type': 'text/plain',
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end('unauthorized');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        legacy: {
          transport: 'sse',
          url: `http://127.0.0.1:${port}/sse`,
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('legacy');
      expect(entry?.transport).toBe('sse');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login legacy');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('flips cached OAuth credentials that require reauth into needs-auth', async () => {
    const server: HttpServer = createHttpServer((req, res) => {
      if (req.url === '/token') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="mcp"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const serverUrl = `http://127.0.0.1:${port}/mcp`;
    const authServerUrl = `http://127.0.0.1:${port}`;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const provider = oauthService.getProvider('notion', serverUrl);
    await provider.saveDiscoveryState({
      authorizationServerUrl: authServerUrl,
      authorizationServerMetadata: {
        issuer: authServerUrl,
        authorization_endpoint: `${authServerUrl}/authorize`,
        token_endpoint: `${authServerUrl}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    });
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    } satisfies OAuthTokens);

    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        notion: {
          transport: 'http',
          url: serverUrl,
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('notion');
      expect(entry).toMatchObject({
        status: 'needs-auth',
        error: expect.stringContaining('run /mcp-config login notion'),
      });
      expect(entry).toMatchObject({ status: 'needs-auth' });
      expect(JSON.stringify(entry)).not.toContain('redirectUrl must be set');
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('marks HTTP 401 as failed when no OAuth service is configured', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401).end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const cm = createManager();
    try {
      await cm.connectAll({
        gated: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('gated')?.status).toBe('failed');
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('marks a server failed with captured stderr when it closes unexpectedly after connect', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        crashy: {
          transport: 'stdio',
          command: process.execPath,
          args: [crashAfterConnectFixture],
          env: { KIMI_TEST_MCP_EXIT_AFTER_MS: '400', KIMI_TEST_MCP_STDERR: 'fatal: out of memory' },
          startupTimeoutMs: 4_000,
        },
      });
      expect(cm.get('crashy')?.status).toBe('connected');

      await waitForStatus(cm, 'crashy', 'failed', 10_000);
      const entry = cm.get('crashy');
      expect(entry?.toolCount).toBe(0);
      expect(entry?.error?.toLowerCase()).toContain('closed');
      expect(entry?.error).toContain('fatal: out of memory');

      await cm.reconnect('crashy');
      const sequence = seen.filter((s) => s.name === 'crashy').map((s) => s.status);
      expect(sequence.slice(0, 3)).toEqual(['pending', 'connected', 'failed']);
      expect(sequence).toContain('connected');
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('includes captured stderr in the error when stdio connect fails before handshake', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        nope: {
          transport: 'stdio',
          command: process.execPath,
          args: [stderrThenExitFixture],
          env: { KIMI_TEST_MCP_STDERR: 'fatal: missing API token KIMI_X' },
          startupTimeoutMs: 4_000,
        },
      });
      const entry = cm.get('nope');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('fatal: missing API token KIMI_X');
    } finally {
      await cm.shutdown();
    }
  }, 10000);

  it('does not flip to failed when the manager intentionally closes the client', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      expect(cm.get('alpha')?.status).toBe('connected');
      await cm.shutdown();
      await delay(100);
      expect(seen.filter((s) => s.name === 'alpha').map((s) => s.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 10000);

  it('returns undefined for get() of a non-existent server', () => {
    const cm = createManager();
    expect(cm.get('nonexistent')).toBeUndefined();
  });

  it('returns undefined for resolved() of a non-existent server', () => {
    const cm = createManager();
    expect(cm.resolved('nonexistent')).toBeUndefined();
  });

  it('handles an empty config in connectAll without error', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({});
      expect(cm.list()).toEqual([]);
    } finally {
      await cm.shutdown();
    }
  });

  it('shutdown is idempotent when called before any connect', async () => {
    const cm = createManager();
    await expect(cm.shutdown()).resolves.toBeUndefined();
    await expect(cm.shutdown()).resolves.toBeUndefined();
  });

  it('retries transient startup failures and reschedules existing waits with new tunables', async () => {
    const mcpServer = new McpServer({ name: 'cm-retry', version: '0.0.1' });
    mcpServer.registerTool(
      'echo',
      { description: 'Echoes text', inputSchema: { text: z.string() } },
      ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await mcpServer.connect(transport);
    let hits = 0;
    const httpServer = createHttpServer((req, res) => {
      hits += 1;
      if (hits <= 2) {
        res.writeHead(500).end();
        return;
      }
      void transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as HttpAddress).port;

    let retryDefaults = { reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 };
    const cm = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => retryDefaults,
    });
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('remote')?.status).toBe('failed');
      const initialRetryAt = cm.get('remote')?.nextRetryAt;
      expect(initialRetryAt).toBeDefined();
      retryDefaults = { reconnectInitialDelayMs: 1, reconnectMaxDelayMs: 1 };
      cm.rescheduleRetries();
      expect(cm.get('remote')?.nextRetryAt).toBeLessThan(initialRetryAt!);

      for (let i = 0; i < 100; i++) {
        if (cm.get('remote')?.status === 'connected') break;
        await delay(25);
      }
      const entry = cm.get('remote');
      expect(entry?.status).toBe('connected');
      expect(entry?.toolCount).toBe(1);
      expect(cm.resolved('remote')).toBeDefined();
      expect(seen.filter((s) => s.name === 'remote').map((s) => s.status)).toEqual([
        'pending',
        'failed',
        'failed',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
      await closeServer(httpServer);
    }

    const processService = new HostProcessService();
    const spawn = spyOn(processService, 'spawn').mockRejectedValueOnce(
      new HostProcessError(HostProcessErrorCode.SpawnFailed, 'temporary resource pressure', {
        details: { errno: 'EAGAIN' },
        cause: Object.assign(new Error('resource pressure'), { code: 'EAGAIN' }),
      }),
    );
    const spawnRuntime = Object.assign(
      new FakeEnvironment(
        { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
        {
          capabilities: ['process'],
          pathClass: process.platform === 'win32' ? 'win32' : 'posix',
        },
      ),
      { process: processService },
    );
    const stdio = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
      runtimeResolver: {
        _serviceBrand: undefined,
        inspect: () => spawnRuntime,
        acquire: () => ({
          runtime: spawnRuntime,
          track: (resource) => resource,
          dispose: () => {},
        }),
      },
    });
    try {
      await stdio.connectAll({ resource: stdioConfig() });
      expect(stdio.get('resource')?.status).toBe('failed');
      expect(stdio.get('resource')?.nextRetryAt).toBeDefined();
      for (let i = 0; i < 100; i++) {
        if (stdio.get('resource')?.status === 'connected') break;
        await delay(25);
      }
      expect(stdio.get('resource')?.status).toBe('connected');
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      spawn.mockRestore();
      await stdio.shutdown();
    }
  }, 15000);

  it('joins manual reconnects to an automatic handshake already in flight', async () => {
    let hits = 0;
    let releaseThird = (): void => {};
    const thirdGate = new Promise<void>((resolve) => {
      releaseThird = resolve;
    });
    const handler = createPerSessionMcpHandler('cm-coord');
    const httpServer = createHttpServer((req, res) => {
      hits += 1;
      if (hits <= 2) {
        res.writeHead(500).end();
        return;
      }
      if (hits === 3) {
        void thirdGate.then(() => {
          handler(req, res);
        });
        return;
      }
      handler(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as HttpAddress).port;

    const cm = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => ({ reconnectInitialDelayMs: 150, reconnectMaxDelayMs: 300 }),
    });
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('remote')?.status).toBe('failed');

      for (let i = 0; i < 100; i++) {
        if (hits >= 3) break;
        await delay(25);
      }
      expect(hits).toBe(3);
      expect(cm.get('remote')?.status).toBe('pending');
      let joinedSettled = false;
      const joined = cm.reconnectAndJoin('remote').then(() => {
        joinedSettled = true;
      });
      await delay(50);
      expect(hits).toBe(3);
      expect(joinedSettled).toBe(false);
      releaseThird();
      await joined;

      expect(cm.get('remote')?.status).toBe('connected');
      expect(cm.resolved('remote')).toBeDefined();
      expect(seen.filter((s) => s.name === 'remote').map((s) => s.status)).toEqual([
        'pending',
        'failed',
        'connected',
      ]);
    } finally {
      releaseThird();
      await cm.shutdown();
      await closeServer(httpServer);
    }
  }, 15000);

  it('probes healthy weak evidence silently and waits for probes during shutdown', async () => {
    const httpServer = createHttpServer(createPerSessionMcpHandler('cm-weak-ok'));
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as HttpAddress).port;

    const ping = spyOn(Client.prototype, 'ping');
    const cm = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
    });
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    let releaseProbe = (): void => {};
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('remote')?.status).toBe('connected');
      const clientBefore = cm.resolved('remote')?.client;
      expect(clientBefore).toBeDefined();
      seen.length = 0;
      ping.mockClear();

      const internalClient = (cm as unknown as {
        entries: Map<string, { client?: { client: { onerror?: (e: Error) => void } } }>;
      }).entries.get('remote')?.client?.client;
      internalClient?.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));

      await delay(300);
      expect(ping.mock.calls.length).toBeGreaterThan(0);
      expect(cm.get('remote')?.status).toBe('connected');
      expect(cm.get('remote')?.toolCount).toBe(1);
      expect(cm.resolved('remote')?.client).toBe(clientBefore);
      expect(seen).toEqual([]);

      const probeGate = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      ping.mockClear();
      ping.mockImplementation(() => probeGate.then(() => ({})));
      internalClient?.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));
      for (let i = 0; i < 100; i++) {
        if (ping.mock.calls.length > 0) break;
        await delay(10);
      }
      expect(ping).toHaveBeenCalled();
      let shutdownSettled = false;
      const shutting = cm.shutdown().then(() => {
        shutdownSettled = true;
      });
      await delay(50);
      expect(shutdownSettled).toBe(false);
      releaseProbe();
      await shutting;
      expect(cm.list()).toEqual([]);
    } finally {
      releaseProbe();
      ping.mockRestore();
      await cm.shutdown();
      await closeServer(httpServer);
    }
  }, 15000);

  it('reconnects automatically when weak session evidence proves the session dead', async () => {
    let healthy = true;
    const handler = createPerSessionMcpHandler('cm-weak-dead');
    const httpServer = createHttpServer((req, res) => {
      if (!healthy) {
        res.writeHead(500).end();
        return;
      }
      handler(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as HttpAddress).port;

    const cm = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
    });
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('remote')?.status).toBe('connected');

      const internalClient = (cm as unknown as {
        entries: Map<string, { client?: { client: { onerror?: (e: Error) => void } } }>;
      }).entries.get('remote')?.client?.client;
      healthy = false;
      internalClient?.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));

      for (let i = 0; i < 100; i++) {
        if (cm.get('remote')?.status === 'failed') break;
        await delay(25);
      }
      const entry = cm.get('remote');
      expect(entry?.status).toBe('failed');
      expect(entry?.toolCount).toBe(0);
      expect(entry?.error).toContain('Maximum reconnection attempts');
      expect(entry?.nextRetryAt).toBeDefined();

      healthy = true;
      for (let i = 0; i < 100; i++) {
        if (cm.get('remote')?.status === 'connected') break;
        await delay(25);
      }
      const recovered = cm.get('remote');
      expect(recovered?.status).toBe('connected');
      expect(recovered?.toolCount).toBe(1);
      expect(recovered?.nextRetryAt).toBeUndefined();
      expect(cm.resolved('remote')).toBeDefined();

      const remoteStatuses = seen.filter((s) => s.name === 'remote').map((s) => s.status);
      expect(remoteStatuses).toEqual(['pending', 'connected', 'failed', 'connected']);
    } finally {
      await cm.shutdown();
      await closeServer(httpServer);
    }
  }, 15000);

  it('flips a connected server into needs-auth when a tool call fails with 401', async () => {
    const server = await startAnonymousDiscoveryHttpMcpServer();
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        hyper: { transport: 'http', url: server.url, startupTimeoutMs: 5_000 },
      });
      expect(cm.get('hyper')?.status).toBe('connected');
      const client = cm.resolved('hyper')?.client;
      if (client === undefined) throw new Error('expected a connected client');
      const callError = await client.callTool('echo', { text: 'hi' }).then(
        () => {
          throw new Error('expected the call to fail with 401');
        },
        (error: unknown) => error,
      );

      await expect(cm.markNeedsAuth('hyper', callError)).resolves.toBe(true);
      const entry = cm.get('hyper');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login hyper');
      expect(cm.resolved('hyper')).toBeUndefined();
      expect(seen.filter((s) => s.name === 'hyper').map((s) => s.status)).toEqual([
        'pending',
        'connected',
        'needs-auth',
      ]);

      await expect(cm.markNeedsAuth('hyper', callError)).resolves.toBe(true);
      expect(seen.filter((s) => s.name === 'hyper').map((s) => s.status)).toEqual([
        'pending',
        'connected',
        'needs-auth',
      ]);
    } finally {
      await cm.shutdown();
      await server.close();
    }
  }, 15000);

  it('invalidates stored OAuth tokens when a runtime 401 fails the refresh', async () => {
    const server = await startAnonymousDiscoveryHttpMcpServer({ tokenEndpoint: 'invalid_grant' });
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const provider = oauthService.getProvider('hyper', server.url);
    await provider.saveDiscoveryState({
      authorizationServerUrl: server.origin,
      authorizationServerMetadata: {
        issuer: server.origin,
        authorization_endpoint: `${server.origin}/authorize`,
        token_endpoint: `${server.origin}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    });
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
    const revokedTokens: StoredMcpOAuthTokens = {
      access_token: 'revoked-access-token',
      refresh_token: 'revoked-refresh-token',
      token_type: 'Bearer',
      obtained_at: Date.now() - 60_000,
    };
    await provider.saveTokens(revokedTokens);
    const cm = createManager({ oauthService });
    try {
      expect(await oauthService.hasTokens('hyper', server.url)).toBe(true);
      await cm.connectAll({
        hyper: { transport: 'http', url: server.url, startupTimeoutMs: 5_000 },
      });
      expect(cm.get('hyper')?.status).toBe('connected');
      const client = cm.resolved('hyper')?.client;
      if (client === undefined) throw new Error('expected a connected client');
      const callError = await client.callTool('echo', { text: 'hi' }).then(
        () => {
          throw new Error('expected the call to fail with 401');
        },
        (error: unknown) => error,
      );
      await expect(cm.markNeedsAuth('hyper', callError, client)).resolves.toBe(true);
      expect(cm.get('hyper')?.status).toBe('needs-auth');
      expect(await oauthService.hasTokens('hyper', server.url)).toBe(false);
    } finally {
      await cm.shutdown();
      await server.close();
    }
  }, 15000);

  it('joins concurrent runtime 401 invalidation and makes old clients unusable immediately', async () => {
    const server = await startAnonymousDiscoveryHttpMcpServer({ tokenEndpoint: 'invalid_grant' });
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const provider = oauthService.getProvider('hyper', server.url);
    await provider.saveDiscoveryState({
      authorizationServerUrl: server.origin,
      authorizationServerMetadata: {
        issuer: server.origin,
        authorization_endpoint: `${server.origin}/authorize`,
        token_endpoint: `${server.origin}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    });
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
    const revokedTokens: StoredMcpOAuthTokens = {
      access_token: 'revoked-access-token',
      refresh_token: 'revoked-refresh-token',
      token_type: 'Bearer',
      obtained_at: Date.now() - 60_000,
    };
    await provider.saveTokens(revokedTokens);
    const cm = createManager({ oauthService });
    let replacement: typeof server | undefined;
    let releaseInvalidation = (): void => {};
    try {
      expect(await oauthService.hasTokens('hyper', server.url)).toBe(true);
      await cm.connectAll({
        hyper: { transport: 'http', url: server.url, startupTimeoutMs: 5_000 },
      });
      expect(cm.get('hyper')?.status).toBe('connected');
      const client = cm.resolved('hyper')?.client;
      if (client === undefined) throw new Error('expected a connected client');
      const callError = new StreamableHTTPError(401, 'Unauthorized');
      expect(await oauthService.hasTokens('hyper', server.url)).toBe(true);
      const invalidate = oauthService.invalidateTokensIfCurrent.bind(oauthService);
      const invalidationGate = new Promise<boolean>((resolve) => {
        releaseInvalidation = () => {
          resolve(true);
        };
      });
      const invalidation = spyOn(oauthService, 'invalidateTokensIfCurrent').mockImplementation(
        async (serverName, serverUrl, expected) => {
          await invalidationGate;
          return invalidate(serverName, serverUrl, expected);
        },
      );
      const peek = spyOn(oauthService, 'peekRejectedGrant');
      const first = cm.markNeedsAuth('hyper', callError, client);
      const second = cm.markNeedsAuth('hyper', callError, client);
      expect(second).toBe(first);
      let firstSettled = false;
      let secondSettled = false;
      void first.then(() => {
        firstSettled = true;
      });
      void second.then(() => {
        secondSettled = true;
      });
      for (let i = 0; i < 100; i++) {
        if (cm.get('hyper')?.status === 'needs-auth' && invalidation.mock.calls.length > 0) break;
        await delay(10);
      }
      expect(cm.get('hyper')?.status).toBe('needs-auth');
      expect(
        ((await peek.mock.results[0]?.value) as { tokens?: unknown } | undefined)?.tokens,
      ).toBeDefined();
      expect(invalidation).toHaveBeenCalled();
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      expect(cm.resolved('hyper')).toBeUndefined();
      const late = cm.markNeedsAuth('hyper', callError, client);
      expect(late).toBe(first);
      let lateSettled = false;
      void late.then(() => {
        lateSettled = true;
      });

      replacement = await startAnonymousDiscoveryHttpMcpServer({ tokenEndpoint: 'invalid_grant' });
      const replacementProvider = oauthService.getProvider('hyper', replacement.url);
      await replacementProvider.saveTokens(revokedTokens);
      await cm.connect('hyper', {
        transport: 'http',
        url: replacement.url,
        startupTimeoutMs: 5000,
      });
      expect(cm.get('hyper')?.status).toBe('connected');
      const nextClient = cm.resolved('hyper')?.client;
      if (nextClient === undefined) throw new Error('expected a replacement client');
      const third = cm.markNeedsAuth('hyper', callError, nextClient);
      expect(third).not.toBe(first);
      let thirdSettled = false;
      void third.then(() => {
        thirdSettled = true;
      });
      for (let i = 0; i < 100; i++) {
        if (invalidation.mock.calls.length >= 2) break;
        await delay(10);
      }
      expect(thirdSettled).toBe(false);
      const connectSpy = spyOn(Client.prototype, 'connect').mockResolvedValue();
      const listSpy = spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
      await cm.reconnect('hyper');
      expect(cm.get('hyper')?.status).toBe('connected');
      const finalClient = cm.resolved('hyper')?.client;
      if (finalClient === undefined) throw new Error('expected a connected client');
      const fourth = cm.markNeedsAuth('hyper', callError, finalClient);
      expect(fourth).not.toBe(third);
      const applicationError = new McpError(ErrorCode.InvalidRequest, 'application-level failure');
      const nonAuth = cm.markNeedsAuth('hyper', applicationError, finalClient);
      let fourthSettled = false;
      void fourth.then(() => {
        fourthSettled = true;
      });
      for (let i = 0; i < 100; i++) {
        if (invalidation.mock.calls.length >= 3) break;
        await delay(10);
      }
      expect(fourthSettled).toBe(false);
      expect(
        (cm as unknown as { pendingNeedsAuthTransitions: Set<Promise<boolean>> })
          .pendingNeedsAuthTransitions.size,
      ).toBe(3);
      releaseInvalidation();
      await expect(Promise.all([first, second, late, third, fourth, nonAuth])).resolves.toEqual([
        false,
        false,
        false,
        false,
        true,
        false,
      ]);
      expect(invalidation).toHaveBeenCalledTimes(3);
      connectSpy.mockRestore();
      listSpy.mockRestore();
      invalidation.mockRestore();
      expect(await oauthService.hasTokens('hyper', replacement.url)).toBe(false);
    } finally {
      releaseInvalidation();
      mock.restore();
      await cm.shutdown();
      await server.close();
      await replacement?.close();
    }
  }, 15000);

  it('ignores application-level errors that merely mention unauthorized', async () => {
    const server = await startAnonymousDiscoveryHttpMcpServer();
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        hyper: { transport: 'http', url: server.url, startupTimeoutMs: 5_000 },
      });
      expect(cm.get('hyper')?.status).toBe('connected');
      await oauthService.getProvider('hyper', server.url).saveTokens({
        access_token: 'valid-access-token',
        token_type: 'Bearer',
        obtained_at: Date.now() - 60_000,
      } as StoredMcpOAuthTokens);
      const client = cm.resolved('hyper')?.client;
      if (client === undefined) throw new Error('expected a connected client');
      const appError = new McpError(ErrorCode.InvalidRequest, 'Unauthorized to edit this project');
      await expect(cm.markNeedsAuth('hyper', appError, client)).resolves.toBe(false);
      expect(cm.get('hyper')?.status).toBe('connected');
      expect(await oauthService.hasTokens('hyper', server.url)).toBe(true);
      expect(cm.resolved('hyper')?.client).toBe(client);
    } finally {
      await cm.shutdown();
      await server.close();
    }
  }, 15000);
});
